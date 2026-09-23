/**
 * Переход одновременно с применением изменений процесса.
 *
 * Гонка разбирается блокировкой строки взаимодействия плюс оптимистической
 * проверкой номера редакции. Возможных порядков два, и оба безопасны: либо
 * переход коммитится целиком и публикация мигрирует уже сдвинутое
 * взаимодействие, либо публикация коммитится первой, а переход просыпается,
 * видит другую редакцию и отказывает до единой записи.
 *
 * Третьего порядка нет: без блокировки обе операции прочли бы одно состояние и
 * обе сочли бы себя правыми, оставив в истории два перехода с одной стадии.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { interactions, stageEntries, stages } from '$lib/server/db/schema';
import { ConflictError } from '$lib/server/errors';
import {
	advanceStage,
	cancelInteraction,
	completeInteraction,
	confirmStage,
	pauseStage,
	resumeStage,
	setChecklistItem,
	setStageResult
} from '$lib/server/stages/commands';
import {
	createDraft,
	processDefinition,
	publishProcess,
	readWorkspaceByKey,
	updateDraft
} from '$lib/server/stages/process';
import { getInteractionStatus } from '$lib/server/stages/status';
import type { ActorContext } from '$lib/server/actor';
import {
	allWorkspaceIds,
	startTestDatabase,
	testActor,
	TEST_USER_IDS,
	type TestDatabase
} from '../helpers/db';
import {
	activeRevision,
	advanceTo,
	B2C_WORKSPACE_KEY,
	createInteractionOn,
	seedProcess,
	stageId,
	threeStageProcess,
	twoStageProcess
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
 * КАМ со своей областью: условие видимости у него — подзапрос по назначениям,
 * и на этом подзапросе команду можно задержать между началом транзакции и
 * блокировкой строки.
 */
const manager = async (): Promise<ActorContext> =>
	testActor({
		roleId: 'manager',
		userId: TEST_USER_IDS.manager,
		scopeUserIds: [TEST_USER_IDS.manager],
		workspaceIds: await allWorkspaceIds(database.db)
	});

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Черновик, который переименовывает первую стадию: сопоставление полное. */
async function prepareRename(ctx: ActorContext): Promise<void> {
	const draft = await createDraft(ctx, B2C_WORKSPACE_KEY);
	const definition = processDefinition(draft);

	await updateDraft(ctx, B2C_WORKSPACE_KEY, {
		...definition,
		stages: definition.stages.map((stage) =>
			stage.key === 'first' ? { ...stage, name: 'Первая стадия, иначе названная' } : stage
		)
	});
}

/** Состояние взаимодействия строкой таблицы: в работе, завершено или отменено. */
async function statusOf(interactionId: string): Promise<string> {
	const [row] = await database.db
		.select({ status: interactions.status })
		.from(interactions)
		.where(eq(interactions.id, interactionId));

	return row.status;
}

/** Постусловие обоих порядков: ровно одна открытая запись, и она в действующей редакции. */
async function assertSettled(interactionId: string): Promise<void> {
	const open = await database.db
		.select({ id: stageEntries.id, revisionId: stages.revisionId })
		.from(stageEntries)
		.innerJoin(stages, eq(stages.id, stageEntries.stageId))
		.where(and(eq(stageEntries.interactionId, interactionId), isNull(stageEntries.leftAt)));

	const active = await activeRevision(database, B2C_WORKSPACE_KEY);

	expect(open).toHaveLength(1);
	expect(open[0].revisionId).toBe(active.id);
}

describe('переход и применение изменений', () => {
	it('детерминированно: публикация ждёт заблокированное взаимодействие', async () => {
		const ctx = admin();
		const before = await seedProcess(database, B2C_WORKSPACE_KEY, twoStageProcess({}));
		const { interactionId } = await createInteractionOn(ctx, database, { kind: 'legal_entity' });

		await prepareRename(ctx);

		const historyBefore = await database.db
			.select({ id: stageEntries.id })
			.from(stageEntries)
			.where(eq(stageEntries.interactionId, interactionId));

		// Транзакция A вручную берёт блокировку строки взаимодействия и держит её:
		// так воспроизводится «КАМ нажал кнопку первым».
		let release: () => void = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});

		const holder = database.db.transaction(async (tx) => {
			await tx
				.select({ id: interactions.id })
				.from(interactions)
				.where(eq(interactions.id, interactionId))
				.for('update');

			await held;
		});

		await sleep(100);

		// Публикация упирается в блокировку и ждёт.
		const publication = publishProcess(ctx, B2C_WORKSPACE_KEY);
		let settled = false;
		void publication.then(
			() => (settled = true),
			() => (settled = true)
		);
		await sleep(300);

		// Главное утверждение теста: публикация именно **ждёт**. Без него
		// постусловия ниже верны и без блокировки — публикация просто прошла бы
		// раньше и мигрировала ту же единственную запись.
		expect(settled).toBe(false);

		release();
		await holder;

		const result = await publication;

		expect(result.reboundCount).toBe(1);
		await assertSettled(interactionId);

		const historyAfter = await database.db
			.select({ id: stageEntries.id })
			.from(stageEntries)
			.where(eq(stageEntries.interactionId, interactionId));

		// Перепривязка истории не удлиняет: переехавших взаимодействий не было.
		expect(historyAfter).toHaveLength(historyBefore.length);

		const status = await getInteractionStatus(ctx, interactionId);
		expect(status.revision).toBe(before.version + 1);
		expect(status.current?.snapshot.name).toBe('Первая стадия, иначе названная');
	});

	it('состязательно: двадцать прогонов дают оба допустимых исхода', async () => {
		const ctx = admin();
		const outcomes: string[] = [];

		for (let run = 0; run < 20; run += 1) {
			await database.reset();

			const revision = await seedProcess(database, B2C_WORKSPACE_KEY, twoStageProcess({}));
			const { interactionId } = await createInteractionOn(ctx, database, {
				kind: 'legal_entity'
			});

			await prepareRename(ctx);

			const command = {
				interactionId,
				fromStageId: stageId(revision, 'first'),
				toStageId: stageId(revision, 'second'),
				revision: revision.version,
				reason: null,
				resultText: null,
				checklistState: {}
			};

			// Оба порядка обязаны встретиться, иначе половина утверждений ниже
			// никогда не проверяется: планировщик сам по себе отдаёт победу
			// переходу раз за разом. Поэтому фору по очереди получает то одна
			// операция, то другая — гонка остаётся настоящей (обе идут
			// одновременно, разбирает их блокировка), но обе ветви исхода
			// встречаются в прогоне.
			const lead = run % 2 === 0 ? 'move' : 'publication';

			const [move, publication] = await Promise.allSettled([
				(lead === 'move' ? Promise.resolve() : sleep(50)).then(() => advanceStage(ctx, command)),
				(lead === 'publication' ? Promise.resolve() : sleep(50)).then(() =>
					publishProcess(ctx, B2C_WORKSPACE_KEY)
				)
			]);

			outcomes.push(move.status);

			// Публикация обязана состояться: она не зависит от исхода перехода.
			expect(publication.status).toBe('fulfilled');

			// Переход либо прошёл целиком, либо отказал понятными словами. Любой
			// третий исход — потерянная запись, две открытых или запись на стадии
			// несуществующей редакции — валит проверку ниже.
			if (move.status === 'rejected') {
				expect(move.reason).toBeInstanceOf(ConflictError);
				expect(String((move.reason as ConflictError).message)).toMatch(/Процесс изменился/);
			}

			await assertSettled(interactionId);

			const entries = await database.db
				.select({ value: sql<number>`count(*)::int` })
				.from(stageEntries)
				.where(eq(stageEntries.interactionId, interactionId));

			// Одна запись, если переход не состоялся; две, если состоялся. Число
			// выводится из исхода, а не ограничивается сверху: потолок пропустил
			// бы переход, потерявший свою запись.
			expect(entries[0].value).toBe(move.status === 'fulfilled' ? 2 : 1);
		}

		// Обе ветви встретились: «переход прошёл» и «переход отказал».
		expect([...new Set(outcomes)].sort()).toStrictEqual(['fulfilled', 'rejected']);
	}, 180_000);

	it('отказывает команде, собранной по прежней редакции', async () => {
		const ctx = admin();
		const revision = await seedProcess(database, B2C_WORKSPACE_KEY, twoStageProcess({}));
		const { interactionId } = await createInteractionOn(ctx, database, { kind: 'legal_entity' });

		await prepareRename(ctx);
		await publishProcess(ctx, B2C_WORKSPACE_KEY);

		// Карточка была отрисована до применения: стадия та же строка по
		// идентификатору, но принадлежит прежней редакции.
		await expect(
			advanceStage(ctx, {
				interactionId,
				fromStageId: stageId(revision, 'first'),
				toStageId: stageId(revision, 'second'),
				revision: revision.version,
				reason: null,
				resultText: null,
				checklistState: {}
			})
		).rejects.toSatisfy(
			(error: unknown) => error instanceof ConflictError && /Процесс изменился/.test(error.message)
		);

		// Ничего не записано: взаимодействие осталось там же, где было.
		const status = await getInteractionStatus(ctx, interactionId);
		expect(status.current?.snapshot.key).toBe('first');
		expect(status.history).toEqual([]);

		// С номером действующей редакции тот же переход проходит.
		const fresh = await activeRevision(database, B2C_WORKSPACE_KEY);
		await advanceStage(ctx, {
			interactionId,
			fromStageId: stageId(fresh, 'first'),
			toStageId: stageId(fresh, 'second'),
			revision: fresh.version,
			reason: null,
			resultText: null,
			checklistState: {}
		});

		const moved = await getInteractionStatus(ctx, interactionId);
		expect(moved.current?.snapshot.key).toBe('second');
		expect(await readWorkspaceByKey(database.db, B2C_WORKSPACE_KEY)).toBeTruthy();
	});
});

describe('переход в удаляемую стадию, пока публикация ждёт', () => {
	it('публикация переживает вход, случившийся после её старта', async () => {
		const ctx = admin();
		const revision = await seedProcess(database, B2C_WORKSPACE_KEY, threeStageProcess());

		const created = [];
		for (let index = 0; index < 3; index += 1) {
			created.push(await createInteractionOn(ctx, database, { kind: 'legal_entity' }));
		}

		// Публикация блокирует взаимодействия по возрастанию идентификатора:
		// держим первое, чтобы она встала в очередь, не тронув остальные.
		const sorted = [...created].sort((left, right) =>
			left.interactionId < right.interactionId ? -1 : 1
		);
		const holderId = sorted[0].interactionId;
		const moverId = sorted[1].interactionId;
		const occupantId = sorted[2].interactionId;

		// На удаляемой стадии кто-то уже стоит — иначе правило переноса черновику
		// не понадобилось бы.
		await advanceTo(ctx, database, occupantId, 'offer');

		const draft = await createDraft(ctx, B2C_WORKSPACE_KEY);

		await updateDraft(ctx, B2C_WORKSPACE_KEY, {
			...processDefinition(draft),
			migrationRules: [{ removedStageKey: 'offer', targetStageKey: 'done' }],
			stages: processDefinition(draft).stages.filter((stage) => stage.key !== 'offer'),
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

		let release: () => void = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});

		const holder = database.db.transaction(async (tx) => {
			await tx
				.select({ id: interactions.id })
				.from(interactions)
				.where(eq(interactions.id, holderId))
				.for('update');

			await held;
		});

		await sleep(100);

		const publication = publishProcess(ctx, B2C_WORKSPACE_KEY);
		let settled = false;
		void publication.then(
			() => (settled = true),
			() => (settled = true)
		);
		await sleep(300);

		expect(settled).toBe(false);

		// Переход начинается, когда публикация уже стоит в очереди: его строку она
		// ещё не заблокировала, и вход на удаляемую стадию проходит целиком.
		await advanceStage(ctx, {
			interactionId: moverId,
			fromStageId: stageId(revision, 'intake'),
			toStageId: stageId(revision, 'offer'),
			revision: revision.version,
			reason: null,
			resultText: null,
			checklistState: {}
		});

		release();
		await holder;

		// Момент публикации снимается после блокировок, поэтому запись, вошедшая
		// на стадию за время ожидания, закрывается **позже** своего входа.
		// Момент, снятый до них, дал бы отрицательное окно и отказ базы по
		// `stage_entries_left_after_entered` — пятисотую вместо ответа.
		const result = await publication;

		expect(result.migratedCount).toBe(2);
		await assertSettled(moverId);

		const moved = await database.db
			.select({
				interactionId: stageEntries.interactionId,
				enteredAt: stageEntries.enteredAt,
				leftAt: stageEntries.leftAt,
				outcome: stageEntries.outcome
			})
			.from(stageEntries)
			.where(eq(stageEntries.interactionId, moverId))
			.orderBy(stageEntries.enteredAt);

		const migrated = moved.find((entry) => entry.outcome === 'migrated');

		expect(migrated).toBeDefined();
		expect(migrated?.leftAt?.getTime()).toBeGreaterThanOrEqual(migrated?.enteredAt.getTime() ?? 0);

		const status = await getInteractionStatus(ctx, moverId);
		expect(status.current?.snapshot.key).toBe('done');
	}, 120_000);
});

describe('закрытие взаимодействия, пока идёт публикация', () => {
	/**
	 * Команда, начавшая транзакцию до публикации и получившая блокировку строки
	 * после неё.
	 *
	 * Окно между `BEGIN` и блокировкой строки короткое, но оно есть: условие
	 * видимости тянет в план `organization_responsibles`, и команда встаёт на
	 * этой таблице ещё до того, как доберётся до своей строки. Блокировка
	 * таблицы воспроизводит это окно управляемо — иначе оно ловится только
	 * вероятностно.
	 */
	async function underPublication(command: () => Promise<void>): Promise<unknown> {
		let release: () => void = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});

		const holder = database.db.transaction(async (tx) => {
			await tx.execute(sql`lock table organization_responsibles in access exclusive mode`);

			await held;
		});

		await sleep(100);

		const outcome = command().then(
			() => null,
			(error: unknown) => error
		);
		let settled = false;
		void outcome.then(() => (settled = true));
		await sleep(200);

		// Команда ждёт: публикация проходит целиком, пока она стоит.
		expect(settled).toBe(false);

		await publishProcess(admin(), B2C_WORKSPACE_KEY);

		release();
		await holder;

		return outcome;
	}

	/** Взаимодействие менеджера на удаляемой стадии и черновик, её удаляющий. */
	async function prepareRemoval(): Promise<{
		ctx: ActorContext;
		interactionId: string;
		stageId: string;
		/** Редакция, с которой отрисована карточка: публикация её сменит. */
		revision: number;
	}> {
		const ctx = admin();
		await seedProcess(database, B2C_WORKSPACE_KEY, threeStageProcess());

		// Взаимодействие ведёт КАМ: его область видит запись по владельцу, а
		// условие видимости всё равно тянет в план назначения — на них команда и
		// встаёт.
		const { interactionId } = await createInteractionOn(ctx, database, {
			kind: 'legal_entity',
			ownerUserId: TEST_USER_IDS.manager
		});

		await advanceTo(ctx, database, interactionId, 'offer');

		const draft = await createDraft(ctx, B2C_WORKSPACE_KEY);

		await updateDraft(ctx, B2C_WORKSPACE_KEY, {
			...processDefinition(draft),
			migrationRules: [{ removedStageKey: 'offer', targetStageKey: 'done' }],
			stages: processDefinition(draft).stages.filter((stage) => stage.key !== 'offer'),
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

		const status = await getInteractionStatus(ctx, interactionId);

		return {
			ctx: await manager(),
			interactionId,
			stageId: status.current?.stageId ?? '',
			revision: status.revision
		};
	}

	it('отказывает завершению предметным конфликтом, а не ошибкой базы', async () => {
		const { ctx, interactionId, revision } = await prepareRemoval();

		const error = await underPublication(() =>
			completeInteraction(ctx, {
				interactionId,
				revision,
				summary: 'Работа закончена',
				force: false
			})
		);

		expect(error).toBeInstanceOf(ConflictError);
		expect(String((error as ConflictError).message)).toMatch(/Процесс изменился/);

		// Ничего не записано: взаимодействие стоит там, куда его перенесла
		// публикация, и остаётся в работе.
		const status = await getInteractionStatus(admin(), interactionId);

		expect(status.current?.snapshot.key).toBe('done');
		await expect(statusOf(interactionId)).resolves.toBe('active');

		// Повтор по обновлённой карточке проходит: номер редакции читается заново.
		await completeInteraction(ctx, {
			interactionId,
			revision: status.revision,
			summary: 'Работа закончена',
			force: false
		});

		await expect(statusOf(interactionId)).resolves.toBe('completed');
	}, 120_000);

	it.each([
		[
			'пауза',
			(ctx: ActorContext, interactionId: string, stageId: string) =>
				pauseStage(ctx, {
					interactionId,
					fromStageId: stageId,
					reason: 'waiting_counterparty' as const,
					waitingPartyId: null,
					nextAction: null,
					note: 'Ждём ответ вуза'
				})
		],
		[
			'снятие паузы',
			(ctx: ActorContext, interactionId: string, stageId: string) =>
				resumeStage(ctx, { interactionId, fromStageId: stageId, note: null })
		],
		[
			'подтверждение стадии',
			(ctx: ActorContext, interactionId: string, stageId: string) =>
				confirmStage(ctx, {
					interactionId,
					fromStageId: stageId,
					confirmation: { kind: 'mark' as const }
				})
		],
		[
			'результат стадии',
			(ctx: ActorContext, interactionId: string) =>
				setStageResult(ctx, { interactionId, resultText: 'Условия согласованы' })
		],
		[
			'отметка чек-листа',
			(ctx: ActorContext, interactionId: string) =>
				setChecklistItem(ctx, { interactionId, key: 'papers', done: true })
		]
	])(
		'отказывает команде «%s» теми же словами',
		async (_name, command) => {
			const { ctx, interactionId, stageId: from } = await prepareRemoval();

			const error = await underPublication(() => command(ctx, interactionId, from));

			// Сверки `fromStageId` мало: она отвечает «взаимодействие уже на другой
			// стадии», а произошло другое — процесс изменился, и карточку надо
			// перечитать.
			expect(error).toBeInstanceOf(ConflictError);
			expect(String((error as ConflictError).message)).toMatch(/Процесс изменился/);
		},
		120_000
	);

	it('отказывает отмене тем же способом', async () => {
		const { ctx, interactionId, revision } = await prepareRemoval();

		const error = await underPublication(() =>
			cancelInteraction(ctx, { interactionId, revision, reason: 'Вуз отказался от программы' })
		);

		expect(error).toBeInstanceOf(ConflictError);
		expect(String((error as ConflictError).message)).toMatch(/Процесс изменился/);

		await expect(statusOf(interactionId)).resolves.toBe('active');

		const status = await getInteractionStatus(admin(), interactionId);

		await cancelInteraction(ctx, {
			interactionId,
			revision: status.revision,
			reason: 'Вуз отказался от программы'
		});

		await expect(statusOf(interactionId)).resolves.toBe('cancelled');
	}, 120_000);
});
