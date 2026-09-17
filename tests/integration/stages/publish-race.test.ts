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
import { advanceStage } from '$lib/server/stages/commands';
import {
	createDraft,
	processDefinition,
	publishProcess,
	readGroupByKey,
	updateDraft
} from '$lib/server/stages/process';
import { getInteractionStatus } from '$lib/server/stages/status';
import type { ActorContext } from '$lib/server/actor';
import { startTestDatabase, testActor, type TestDatabase } from '../helpers/db';
import {
	activeRevision,
	B2C_GROUP_KEY,
	createInteractionOn,
	seedProcess,
	stageId,
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

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Черновик, который переименовывает первую стадию: сопоставление полное. */
async function prepareRename(ctx: ActorContext): Promise<void> {
	const draft = await createDraft(ctx, B2C_GROUP_KEY);
	const definition = processDefinition(draft);

	await updateDraft(ctx, B2C_GROUP_KEY, {
		...definition,
		stages: definition.stages.map((stage) =>
			stage.key === 'first' ? { ...stage, name: 'Первая стадия, иначе названная' } : stage
		)
	});
}

/** Постусловие обоих порядков: ровно одна открытая запись, и она в действующей редакции. */
async function assertSettled(interactionId: string): Promise<void> {
	const open = await database.db
		.select({ id: stageEntries.id, revisionId: stages.revisionId })
		.from(stageEntries)
		.innerJoin(stages, eq(stages.id, stageEntries.stageId))
		.where(and(eq(stageEntries.interactionId, interactionId), isNull(stageEntries.leftAt)));

	const active = await activeRevision(database, B2C_GROUP_KEY);

	expect(open).toHaveLength(1);
	expect(open[0].revisionId).toBe(active.id);
}

describe('переход и применение изменений', () => {
	it('детерминированно: публикация ждёт заблокированное взаимодействие', async () => {
		const ctx = admin();
		const before = await seedProcess(database, B2C_GROUP_KEY, twoStageProcess({}));
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
		const publication = publishProcess(ctx, B2C_GROUP_KEY);
		await sleep(300);

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

	it('состязательно: двадцать прогонов дают только два допустимых исхода', async () => {
		const ctx = admin();

		for (let run = 0; run < 20; run += 1) {
			await database.reset();

			const revision = await seedProcess(database, B2C_GROUP_KEY, twoStageProcess({}));
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

			const [move, publication] = await Promise.allSettled([
				advanceStage(ctx, command),
				publishProcess(ctx, B2C_GROUP_KEY)
			]);

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

			// Одна запись, если переход не состоялся; две, если состоялся. Трёх не
			// бывает ни при каком порядке.
			expect(entries[0].value).toBeLessThanOrEqual(2);
		}
	}, 120_000);

	it('отказывает команде, собранной по прежней редакции', async () => {
		const ctx = admin();
		const revision = await seedProcess(database, B2C_GROUP_KEY, twoStageProcess({}));
		const { interactionId } = await createInteractionOn(ctx, database, { kind: 'legal_entity' });

		await prepareRename(ctx);
		await publishProcess(ctx, B2C_GROUP_KEY);

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
		const fresh = await activeRevision(database, B2C_GROUP_KEY);
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
		expect(await readGroupByKey(database.db, B2C_GROUP_KEY)).toBeTruthy();
	});
});
