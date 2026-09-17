/**
 * Публикация как миграция: что происходит с записями стадий, когда процесс
 * группы меняют на ходу.
 *
 * Здесь проверяется то, ради чего публикация вообще сделана транзакцией:
 * открытые записи переезжают все и сразу, закрытые не трогает никто, история
 * остаётся целой, а числа отчёта на прошлую дату не зависят от того, правили
 * процесс после неё или нет.
 */
import { and, asc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	auditEvents,
	exchangeMessages,
	interactions,
	processGroups,
	processStageKeys,
	stageEntries,
	stageEntryStatus,
	stagePauses,
	stages
} from '$lib/server/db/schema';
import { ConflictError, ValidationError } from '$lib/server/errors';
import { setExchangeSettings } from '$lib/server/integrations/settings';
import { advanceStage, pauseStage, setChecklistItem } from '$lib/server/stages/commands';
import {
	createDraft,
	processDefinition,
	publishProcess,
	updateDraft
} from '$lib/server/stages/process';
import { getInteractionStatus } from '$lib/server/stages/status';
import type { ActorContext } from '$lib/server/actor';
import { startTestDatabase, testActor, TEST_USER_IDS, type TestDatabase } from '../helpers/db';
import {
	activeRevision,
	advanceTo,
	B2C_GROUP_KEY,
	createInteractionOn,
	seedProcess,
	threeStageProcess
} from './fixture';

vi.mock('$env/dynamic/private', () => ({ env: process.env }));

let database: TestDatabase;

beforeAll(async () => {
	database = await startTestDatabase();
}, 300_000);

afterAll(async () => {
	await database?.stop();
});

beforeEach(async () => {
	await database.reset();
});

const admin = (): ActorContext => testActor({ roleId: 'admin' });

/** Открытая запись взаимодействия вместе с ключом стадии, на которой она стоит. */
async function openEntry(interactionId: string) {
	const [row] = await database.db
		.select({
			id: stageEntries.id,
			stageId: stageEntries.stageId,
			stageKey: stages.key,
			revisionId: stages.revisionId,
			enteredAt: stageEntries.enteredAt,
			migratedAt: stageEntries.migratedAt,
			migratedFromStageKey: stageEntries.migratedFromStageKey,
			checklistState: stageEntries.checklistState
		})
		.from(stageEntries)
		.innerJoin(stages, eq(stages.id, stageEntries.stageId))
		.where(and(eq(stageEntries.interactionId, interactionId), isNull(stageEntries.leftAt)));

	return row;
}

/**
 * Инвариант, общий для всей публикации: открытых пауз на закрытых записях не
 * бывает. Незакрытая пауза в истории читается как «ждать не перестали никогда».
 */
async function assertNoOpenPauseOnClosedEntries(): Promise<void> {
	const stray = await database.db
		.select({ pauseId: stagePauses.id, stageEntryId: stagePauses.stageEntryId })
		.from(stagePauses)
		.innerJoin(stageEntries, eq(stageEntries.id, stagePauses.stageEntryId))
		.where(and(isNull(stagePauses.endedAt), isNotNull(stageEntries.leftAt)));

	expect(stray).toStrictEqual([]);
}

/** Срок и паузы открытой записи — так, как их считает база. */
async function entryStatus(interactionId: string) {
	const [row] = await database.db
		.select({
			isPaused: stageEntryStatus.isPaused,
			isOverdue: stageEntryStatus.isOverdue,
			activeSeconds: stageEntryStatus.activeSeconds,
			overdueSeconds: stageEntryStatus.overdueSeconds
		})
		.from(stageEntryStatus)
		.innerJoin(stageEntries, eq(stageEntries.id, stageEntryStatus.stageEntryId))
		.where(and(eq(stageEntries.interactionId, interactionId), isNull(stageEntries.leftAt)));

	return row;
}

/** Все записи взаимодействия по порядку входа: история целиком. */
async function entriesOf(interactionId: string) {
	return database.db
		.select({
			id: stageEntries.id,
			stageId: stageEntries.stageId,
			snapshot: stageEntries.stageSnapshot,
			enteredAt: stageEntries.enteredAt,
			leftAt: stageEntries.leftAt,
			outcome: stageEntries.outcome,
			updatedAt: stageEntries.updatedAt
		})
		.from(stageEntries)
		.where(eq(stageEntries.interactionId, interactionId))
		.orderBy(asc(stageEntries.enteredAt));
}

/** Заводит черновик, правит его и применяет ко всем. */
async function publishWith(
	ctx: ActorContext,
	groupKey: string,
	change: (definition: ReturnType<typeof processDefinition>) => ReturnType<typeof processDefinition>
) {
	const draft = await createDraft(ctx, groupKey);

	await updateDraft(ctx, groupKey, change(processDefinition(draft)));

	return publishProcess(ctx, groupKey);
}

describe('перепривязка открытых записей', () => {
	it('переносит открытые записи и не трогает закрытые', async () => {
		const ctx = admin();
		await seedProcess(database, B2C_GROUP_KEY, threeStageProcess());

		const { interactionId } = await createInteractionOn(ctx, database, { kind: 'legal_entity' });
		await advanceTo(ctx, database, interactionId, 'offer');

		const before = await entriesOf(interactionId);
		const closedBefore = before.filter((entry) => entry.leftAt !== null);

		const result = await publishWith(ctx, B2C_GROUP_KEY, (definition) => ({
			...definition,
			stages: definition.stages.map((stage) =>
				stage.key === 'offer' ? { ...stage, name: 'Предложение и условия', slaDays: 9 } : stage
			)
		}));

		const after = await entriesOf(interactionId);
		const closedAfter = after.filter((entry) => entry.leftAt !== null);
		const open = await openEntry(interactionId);
		const active = await activeRevision(database, B2C_GROUP_KEY);

		expect(result.reboundCount).toBe(1);
		expect(result.migratedCount).toBe(0);

		// Открытая запись стоит на стадии действующей редакции, и её снимок
		// пересобран: изменение процесса применяется ко всем, а не только к тем,
		// кто начнёт завтра.
		expect(open.revisionId).toBe(active.id);
		expect(open.stageKey).toBe('offer');

		const reopened = await getInteractionStatus(ctx, interactionId);
		expect(reopened.current?.snapshot.name).toBe('Предложение и условия');
		expect(reopened.current?.snapshot.slaDays).toBe(9);
		// Часы стадии не перезапущены: перепривязка — это не вход на стадию.
		expect(open.enteredAt.getTime()).toBe(
			before.find((entry) => entry.leftAt === null)?.enteredAt.getTime()
		);

		// Закрытая запись осталась на стадии своей редакции, её снимок не изменился
		// ни в байте, и `updated_at` не сдвинулся.
		expect(closedAfter).toHaveLength(closedBefore.length);
		expect(closedAfter[0].stageId).toBe(closedBefore[0].stageId);
		expect(JSON.stringify(closedAfter[0].snapshot)).toBe(JSON.stringify(closedBefore[0].snapshot));
		expect(closedAfter[0].updatedAt.getTime()).toBe(closedBefore[0].updatedAt.getTime());

		// История цела: новых записей у непереехавшего взаимодействия нет.
		expect(after).toHaveLength(before.length);
	});

	it('переезд закрывает запись исходом «перенесена» и открывает новую', async () => {
		const ctx = admin();
		await seedProcess(database, B2C_GROUP_KEY, threeStageProcess());

		const { interactionId } = await createInteractionOn(ctx, database, { kind: 'legal_entity' });
		await advanceTo(ctx, database, interactionId, 'offer');

		const before = await entriesOf(interactionId);

		const result = await publishWith(ctx, B2C_GROUP_KEY, (definition) => ({
			...definition,
			stages: definition.stages.filter((stage) => stage.key !== 'offer'),
			transitions: [
				{
					fromStageKey: 'intake',
					toStageKey: 'done',
					kind: 'forward' as const,
					requiredPermissionKey: 'stages.transition',
					requiresReason: false
				}
			]
		}));

		const after = await entriesOf(interactionId);
		const open = await openEntry(interactionId);
		const moved = after.find((entry) => entry.outcome === 'migrated');

		expect(result.migratedCount).toBe(1);
		expect(result.reboundCount).toBe(0);

		// Две записи вместо правки одной: иначе срез на прошлую дату показал бы,
		// что взаимодействие «всегда» стояло на целевой стадии.
		expect(after).toHaveLength(before.length + 1);
		expect(moved?.outcome).toBe('migrated');
		expect(open.stageKey).toBe('intake');
		expect(open.migratedFromStageKey).toBe('offer');
		expect(open.migratedAt).not.toBeNull();
		// `left_at` закрытой равен `entered_at` новой: между записями нет дыры.
		expect(moved?.leftAt?.getTime()).toBe(open.enteredAt.getTime());

		await assertNoOpenPauseOnClosedEntries();

		// Карточка объясняет перенос, пока запись открыта.
		const status = await getInteractionStatus(ctx, interactionId);
		expect(status.migratedFrom?.stageKey).toBe('offer');
	});

	it('переносит записи на выбранную стадию, а не на подставленную по умолчанию', async () => {
		const ctx = admin();
		await seedProcess(database, B2C_GROUP_KEY, threeStageProcess());

		const { interactionId } = await createInteractionOn(ctx, database, { kind: 'legal_entity' });
		await advanceTo(ctx, database, interactionId, 'offer');

		// По умолчанию записи с «Предложения» уехали бы назад, на «Приём»
		// (предыдущая сохранившаяся стадия). Правило говорит другое.
		const result = await publishWith(ctx, B2C_GROUP_KEY, (definition) => ({
			...definition,
			migrationRules: [{ removedStageKey: 'offer', targetStageKey: 'done' }],
			stages: definition.stages.filter((stage) => stage.key !== 'offer'),
			transitions: [
				{
					fromStageKey: 'intake',
					toStageKey: 'done',
					kind: 'forward' as const,
					requiredPermissionKey: 'stages.transition',
					requiresReason: false
				}
			]
		}));

		const open = await openEntry(interactionId);

		expect(result.migratedCount).toBe(1);
		expect(open.stageKey).toBe('done');
		expect(open.migratedFromStageKey).toBe('offer');
	});

	it('переносит отметки чек-листа только по совпавшим ключом и подписью пунктам', async () => {
		const ctx = admin();
		await seedProcess(
			database,
			B2C_GROUP_KEY,
			threeStageProcess({
				checklist: {
					offer: [
						{ key: 'papers', label: 'Документы собраны', required: false },
						{ key: 'price', label: 'Цена согласована', required: false }
					],
					// Ключи те же, а работа за ними другая: ключ уникален внутри
					// стадии, и совпадение ключей на двух стадиях — совпадение.
					intake: [
						{ key: 'papers', label: 'Документы собраны', required: false },
						{ key: 'price', label: 'Договор подписан обеими сторонами', required: true }
					]
				}
			})
		);

		const { interactionId } = await createInteractionOn(ctx, database, { kind: 'legal_entity' });
		await advanceTo(ctx, database, interactionId, 'offer');

		await setChecklistItem(ctx, { interactionId, key: 'papers', done: true });
		await setChecklistItem(ctx, { interactionId, key: 'price', done: true });

		await publishWith(ctx, B2C_GROUP_KEY, (definition) => ({
			...definition,
			stages: definition.stages.filter((stage) => stage.key !== 'offer'),
			transitions: [
				{
					fromStageKey: 'intake',
					toStageKey: 'done',
					kind: 'forward' as const,
					requiredPermissionKey: 'stages.transition',
					requiresReason: false
				}
			]
		}));

		const open = await openEntry(interactionId);

		// `papers` совпал ключом и подписью — работа та же, и отметка переехала.
		// `price` на целевой стадии называет другое требование: переехав, отметка
		// засчитала бы неподписанный договор подписанным.
		expect(open.checklistState).toStrictEqual({ papers: true });

		const status = await getInteractionStatus(ctx, interactionId);
		const target = await activeRevision(database, B2C_GROUP_KEY);
		const move = {
			interactionId,
			fromStageId: open.stageId,
			toStageId: target.stages.find((stage) => stage.key === 'done')?.id ?? '',
			revision: status.revision,
			reason: null,
			resultText: null,
			checklistState: {}
		};

		// Шаг вперёд не проходит, пока обязательный пункт целевой стадии не
		// закрыт: именно этого и стоил бы переезд отметки.
		await expect(advanceStage(ctx, move)).rejects.toSatisfy(
			(error: unknown) =>
				error instanceof ConflictError && /обязательный пункт чек-листа/.test(error.message)
		);

		await setChecklistItem(ctx, { interactionId, key: 'price', done: true });
		await advanceStage(ctx, move);

		const moved = await getInteractionStatus(ctx, interactionId);
		expect(moved.current?.snapshot.key).toBe('done');
	});

	it('переносит паузу вместе с записью и не запускает часы стадии', async () => {
		const ctx = admin();
		await seedProcess(database, B2C_GROUP_KEY, threeStageProcess());

		const { interactionId } = await createInteractionOn(ctx, database, { kind: 'legal_entity' });
		await advanceTo(ctx, database, interactionId, 'offer');

		const before = await openEntry(interactionId);

		await pauseStage(ctx, {
			interactionId,
			fromStageId: before.stageId,
			reason: 'waiting_counterparty',
			waitingPartyId: null,
			nextAction: 'Ждём ответ проректора',
			note: 'Вуз обещал ответить после учёного совета'
		});

		const pausedBefore = await entryStatus(interactionId);

		const result = await publishWith(ctx, B2C_GROUP_KEY, (definition) => ({
			...definition,
			stages: definition.stages.filter((stage) => stage.key !== 'offer'),
			transitions: [
				{
					fromStageKey: 'intake',
					toStageKey: 'done',
					kind: 'forward' as const,
					requiredPermissionKey: 'stages.transition',
					requiresReason: false
				}
			]
		}));

		const open = await openEntry(interactionId);
		const pauses = await database.db
			.select({
				stageEntryId: stagePauses.stageEntryId,
				startedAt: stagePauses.startedAt,
				endedAt: stagePauses.endedAt,
				reason: stagePauses.reason,
				note: stagePauses.note,
				nextAction: stagePauses.nextAction
			})
			.from(stagePauses)
			.orderBy(asc(stagePauses.startedAt));

		expect(result.migratedCount).toBe(1);

		// Пауза переехала вместе с записью: на закрытой записи открытых пауз не
		// осталось, на новой пауза идёт с момента публикации. Иначе часы стадии
		// пошли бы из-за правки процесса, а ждать сторону взаимодействие не
		// перестало.
		expect(pauses).toHaveLength(2);
		expect(pauses[0].stageEntryId).toBe(before.id);
		expect(pauses[0].endedAt?.getTime()).toBe(open.enteredAt.getTime());
		expect(pauses[1].stageEntryId).toBe(open.id);
		expect(pauses[1].startedAt.getTime()).toBe(open.enteredAt.getTime());
		expect(pauses[1].endedAt).toBeNull();
		expect(pauses[1].note).toBe(pauses[0].note);
		expect(pauses[1].reason).toBe(pauses[0].reason);
		expect(pauses[1].nextAction).toBe(pauses[0].nextAction);

		await assertNoOpenPauseOnClosedEntries();

		const pausedAfter = await entryStatus(interactionId);

		expect(pausedAfter.isPaused).toBe(true);
		expect(pausedAfter.isOverdue).toBe(pausedBefore.isOverdue);
		// Часы стоят по обе стороны публикации: активное время новой записи не
		// растёт, просрочке взяться неоткуда.
		expect(pausedAfter.activeSeconds).toBeLessThan(1);
		expect(pausedAfter.overdueSeconds).toBe(0);

		const status = await getInteractionStatus(ctx, interactionId);
		expect(status.current?.isPaused).toBe(true);
	});

	it('сообщает CMS о переезде и двигает `updated_at` взаимодействия', async () => {
		const ctx = admin();
		await seedProcess(database, B2C_GROUP_KEY, threeStageProcess());

		// Адрес получателя никуда не ведёт намеренно: доставка идёт отдельным
		// циклом, а проверка смотрит на очередь.
		await setExchangeSettings(ctx, {
			cmsInstance: 'itschool-site',
			cmsStatusUrl: 'http://127.0.0.1:9/api/applications/{externalId}/status',
			cmsSecret: 'secret-of-the-stand',
			cmsDefaultOwnerUserId: TEST_USER_IDS.manager,
			lmsInstance: 'moodle-itschool',
			lmsGroupsUrl: '',
			lmsSecret: null
		});

		const fromSite = await createInteractionOn(ctx, database, { kind: 'legal_entity' });
		const ownRecord = await createInteractionOn(ctx, database, { kind: 'legal_entity' });

		// Заявка с сайта: снимок её статуса заявитель видит у себя, и
		// административный переезд для него — такое же изменение, как переход.
		await database.db
			.update(interactions)
			.set({ externalSource: 'cms:itschool-site', externalId: 'site-2026-000123' })
			.where(eq(interactions.id, fromSite.interactionId));

		await advanceTo(ctx, database, fromSite.interactionId, 'offer');
		await advanceTo(ctx, database, ownRecord.interactionId, 'offer');

		const [before] = await database.db
			.select({ updatedAt: interactions.updatedAt })
			.from(interactions)
			.where(eq(interactions.id, fromSite.interactionId));

		await database.db.delete(exchangeMessages);

		const result = await publishWith(ctx, B2C_GROUP_KEY, (definition) => ({
			...definition,
			stages: definition.stages.filter((stage) => stage.key !== 'offer'),
			transitions: [
				{
					fromStageKey: 'intake',
					toStageKey: 'done',
					kind: 'forward' as const,
					requiredPermissionKey: 'stages.transition',
					requiresReason: false
				}
			]
		}));

		const queued = await database.db
			.select({
				interactionId: exchangeMessages.interactionId,
				eventType: exchangeMessages.eventType,
				state: exchangeMessages.state
			})
			.from(exchangeMessages);

		const [after] = await database.db
			.select({ updatedAt: interactions.updatedAt, lastActivityAt: interactions.lastActivityAt })
			.from(interactions)
			.where(eq(interactions.id, fromSite.interactionId));

		expect(result.migratedCount).toBe(2);

		// Ровно одна строка очереди: у второго взаимодействия внешней заявки нет,
		// и слать по нему некому.
		expect(queued).toHaveLength(1);
		expect(queued[0]).toMatchObject({
			interactionId: fromSite.interactionId,
			eventType: 'application.status',
			state: 'pending'
		});

		expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
		// Работы по взаимодействию никто не вёл: подсказка «запись протухла»
		// считается от последнего живого действия, а не от правки процесса.
		expect(after.lastActivityAt.getTime()).toBeLessThan(after.updatedAt.getTime());
	});
});

describe('атомарность', () => {
	it('черновик с неполным сопоставлением не публикуется и ничего не меняет', async () => {
		const ctx = admin();
		const active = await seedProcess(database, B2C_GROUP_KEY, threeStageProcess());

		const { interactionId } = await createInteractionOn(ctx, database, { kind: 'legal_entity' });
		await advanceTo(ctx, database, interactionId, 'offer');

		const draft = await createDraft(ctx, B2C_GROUP_KEY);
		const definition = processDefinition(draft);

		// Стадия убрана, а правило переноса стёрто руками: ровно тот случай, когда
		// незавершённым взаимодействиям некуда переехать.
		await updateDraft(ctx, B2C_GROUP_KEY, {
			...definition,
			stages: definition.stages.filter((stage) => stage.key !== 'offer'),
			transitions: [
				{
					fromStageKey: 'intake',
					toStageKey: 'done',
					kind: 'forward' as const,
					requiredPermissionKey: 'stages.transition',
					requiresReason: false
				}
			]
		});

		await database.db.execute(
			sql`delete from stage_migration_rules where revision_id = ${draft.id}::uuid`
		);

		await expect(publishProcess(ctx, B2C_GROUP_KEY)).rejects.toBeInstanceOf(ValidationError);

		const [group] = await database.db
			.select({ activeRevisionId: processGroups.activeRevisionId })
			.from(processGroups)
			.where(eq(processGroups.key, B2C_GROUP_KEY));
		const open = await openEntry(interactionId);

		// Ни опубликованной редакции, ни перепривязанных записей: сбой на середине
		// не оставляет половины изменения.
		expect(group.activeRevisionId).toBe(active.id);
		expect(open.revisionId).toBe(active.id);
		expect(open.stageKey).toBe('offer');
	});
});

describe('реестр ключей и журнал', () => {
	it('архивирует снятый ключ и не даёт завести стадию под ним заново', async () => {
		const ctx = admin();
		await seedProcess(database, B2C_GROUP_KEY, threeStageProcess());

		await publishWith(ctx, B2C_GROUP_KEY, (definition) => ({
			...definition,
			stages: definition.stages.filter((stage) => stage.key !== 'offer'),
			transitions: [
				{
					fromStageKey: 'intake',
					toStageKey: 'done',
					kind: 'forward' as const,
					requiredPermissionKey: 'stages.transition',
					requiresReason: false
				}
			]
		}));

		const registry = await database.db
			.select({ key: processStageKeys.key, archivedAt: processStageKeys.archivedAt })
			.from(processStageKeys);
		const archived = registry.find((row) => row.key === 'offer');

		expect(archived?.archivedAt).not.toBeNull();

		// Черновик, заводящий стадию под архивным ключом, не применяется: иначе
		// история прошлого года приросла бы записями совсем другой работы.
		const draft = await createDraft(ctx, B2C_GROUP_KEY);
		const definition = processDefinition(draft);

		await updateDraft(ctx, B2C_GROUP_KEY, {
			...definition,
			stages: [
				definition.stages[0],
				{
					key: 'offer',
					name: 'Совсем другая работа',
					category: 'delivery' as const,
					slaDays: 4,
					staleAfterDays: null,
					requiresResult: false,
					requiresConfirmation: false,
					requiresLmsData: false,
					isFinal: false,
					checklist: []
				},
				definition.stages[1]
			],
			transitions: [
				{
					fromStageKey: 'intake',
					toStageKey: 'offer',
					kind: 'forward' as const,
					requiredPermissionKey: 'stages.transition',
					requiresReason: false
				},
				{
					fromStageKey: 'offer',
					toStageKey: 'done',
					kind: 'forward' as const,
					requiredPermissionKey: 'stages.transition',
					requiresReason: false
				}
			]
		});

		await expect(publishProcess(ctx, B2C_GROUP_KEY)).rejects.toSatisfy(
			(error: unknown) =>
				error instanceof ValidationError &&
				error.issues.some((issue) => /уже был в этой группе и снят/.test(issue))
		);
	});

	it('пишет оба события публикации с числами и строку на каждое переехавшее', async () => {
		const ctx = admin();
		await seedProcess(database, B2C_GROUP_KEY, threeStageProcess());

		const { interactionId } = await createInteractionOn(ctx, database, { kind: 'legal_entity' });
		await advanceTo(ctx, database, interactionId, 'offer');

		await publishWith(ctx, B2C_GROUP_KEY, (definition) => ({
			...definition,
			stages: definition.stages.filter((stage) => stage.key !== 'offer'),
			transitions: [
				{
					fromStageKey: 'intake',
					toStageKey: 'done',
					kind: 'forward' as const,
					requiredPermissionKey: 'stages.transition',
					requiresReason: false
				}
			]
		}));

		const events = await database.db
			.select({
				type: auditEvents.eventType,
				subjectId: auditEvents.subjectId,
				details: auditEvents.details
			})
			.from(auditEvents);

		const published = events.find((event) => event.type === 'stages.process_published');
		const migrated = events.find((event) => event.type === 'stages.process_migrated');
		const perInteraction = events.filter((event) => event.type === 'interactions.stage_migrated');

		expect(published?.details).toMatchObject({ groupKey: B2C_GROUP_KEY, stageCount: 2 });
		expect(migrated?.details).toMatchObject({ reboundCount: 0, migratedCount: 1 });
		expect(perInteraction).toHaveLength(1);
		expect(perInteraction[0].subjectId).toBe(interactionId);
		expect(perInteraction[0].details).toMatchObject({
			fromStageKey: 'offer',
			toStageKey: 'intake'
		});

		// Административная миграция не считается движением по процессу: событий
		// перехода она не пишет, иначе воронка показала бы всплеск переходов в
		// день, когда никто никуда не переходил.
		expect(events.filter((event) => event.type === 'interactions.stage_advanced')).toHaveLength(1);
	});
});
