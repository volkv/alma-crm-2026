/**
 * Публикация как миграция: что происходит с записями стадий, когда процесс
 * группы меняют на ходу.
 *
 * Здесь проверяется то, ради чего публикация вообще сделана транзакцией:
 * открытые записи переезжают все и сразу, закрытые не трогает никто, история
 * остаётся целой, а числа отчёта на прошлую дату не зависят от того, правили
 * процесс после неё или нет.
 */
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	auditEvents,
	processGroups,
	processStageKeys,
	stageEntries,
	stages
} from '$lib/server/db/schema';
import { ValidationError } from '$lib/server/errors';
import {
	createDraft,
	processDefinition,
	publishProcess,
	updateDraft
} from '$lib/server/stages/process';
import { getInteractionStatus } from '$lib/server/stages/status';
import type { ActorContext } from '$lib/server/actor';
import { startTestDatabase, testActor, type TestDatabase } from '../helpers/db';
import {
	activeRevision,
	advanceTo,
	B2C_GROUP_KEY,
	createInteractionOn,
	seedProcess
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

/**
 * Процесс из трёх стадий: на средней можно стоять, её же можно удалить, и
 * первую есть чем закрыть. Минимум, на котором виден и переезд, и перепривязка.
 */
const THREE_STAGES = {
	name: 'Процесс из трёх стадий',
	note: null,
	migrationRules: [],
	stages: [
		{
			key: 'intake',
			name: 'Приём',
			category: 'contact' as const,
			slaDays: 3,
			staleAfterDays: null,
			requiresResult: false,
			requiresConfirmation: false,
			requiresLmsData: false,
			isFinal: false,
			checklist: []
		},
		{
			key: 'offer',
			name: 'Предложение',
			category: 'documents' as const,
			slaDays: 5,
			staleAfterDays: null,
			requiresResult: false,
			requiresConfirmation: false,
			requiresLmsData: false,
			isFinal: false,
			checklist: []
		},
		{
			key: 'done',
			name: 'Завершение',
			category: 'control' as const,
			slaDays: 7,
			staleAfterDays: null,
			requiresResult: false,
			requiresConfirmation: false,
			requiresLmsData: false,
			isFinal: true,
			checklist: []
		}
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
};

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

/**
 * Числа отчёта «срез на дату»: сколько взаимодействий группы стояло на каждом
 * ключе стадии в заданный момент. Считается по `stage_entries` группировкой по
 * ключу из снимка — ровно так, как обещает движок отчёту.
 */
async function snapshotAt(groupKey: string, at: Date): Promise<Record<string, number>> {
	const rows = (await database.db.execute(sql`
		select entries.stage_snapshot ->> 'key' as key, count(*)::int as value
		from stage_entries entries
		join interactions on interactions.id = entries.interaction_id
		join process_groups groups on groups.id = interactions.process_group_id
		where groups.key = ${groupKey}
			and entries.entered_at <= ${at.toISOString()}::timestamptz
			and (entries.left_at is null or entries.left_at > ${at.toISOString()}::timestamptz)
		group by 1
	`)) as unknown as { key: string; value: number }[];

	return Object.fromEntries(rows.map((row) => [row.key, row.value]));
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
		await seedProcess(database, B2C_GROUP_KEY, THREE_STAGES);

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
		await seedProcess(database, B2C_GROUP_KEY, THREE_STAGES);

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

		// Карточка объясняет перенос, пока запись открыта.
		const status = await getInteractionStatus(ctx, interactionId);
		expect(status.migratedFrom?.stageKey).toBe('offer');
	});
});

describe('атомарность', () => {
	it('черновик с неполным сопоставлением не публикуется и ничего не меняет', async () => {
		const ctx = admin();
		const active = await seedProcess(database, B2C_GROUP_KEY, THREE_STAGES);

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

describe('числа отчёта на прошлую дату', () => {
	it('не меняются от публикации изменения процесса', async () => {
		const ctx = admin();
		await seedProcess(database, B2C_GROUP_KEY, THREE_STAGES);

		const first = await createInteractionOn(ctx, database, { kind: 'legal_entity' });
		const second = await createInteractionOn(ctx, database, { kind: 'legal_entity' });
		await advanceTo(ctx, database, first.interactionId, 'offer');
		await advanceTo(ctx, database, second.interactionId, 'offer');

		// Момент среза — сейчас, до публикации. Потом процесс меняют так, что
		// одна стадия исчезает, а другая переименовывается.
		const at = new Date();
		const before = await snapshotAt(B2C_GROUP_KEY, at);

		await publishWith(ctx, B2C_GROUP_KEY, (definition) => ({
			...definition,
			stages: definition.stages
				.filter((stage) => stage.key !== 'offer')
				.map((stage) => (stage.key === 'intake' ? { ...stage, name: 'Приём заявки' } : stage)),
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

		const after = await snapshotAt(B2C_GROUP_KEY, at);

		// Меняться могут подписи строк, но не числа: история не переписывается.
		expect(after).toEqual(before);
		expect(before.offer).toBe(2);
	});
});

describe('реестр ключей и журнал', () => {
	it('архивирует снятый ключ и не даёт завести стадию под ним заново', async () => {
		const ctx = admin();
		await seedProcess(database, B2C_GROUP_KEY, THREE_STAGES);

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
		await seedProcess(database, B2C_GROUP_KEY, THREE_STAGES);

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
