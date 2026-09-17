/**
 * Применение изменений процесса одновременно с заведением взаимодействия.
 *
 * Без блокировки создание прочло бы действующую редакцию, дождалось коммита
 * публикации и открыло бы первую стадию **прежней** редакции: шаг публикации,
 * блокирующий незавершённые взаимодействия, таких строк ещё не видит.
 * Разделяемая блокировка группы убирает этот порядок: либо создание успевает до
 * публикации и попадает под её миграцию, либо ждёт её конца и читает уже новую
 * редакцию.
 *
 * Постусловие одно и жёсткое: после обоих коммитов ни одной открытой записи вне
 * действующей редакции своей группы.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { interactions, processGroups, stageEntries, stages } from '$lib/server/db/schema';
import {
	createDraft,
	processDefinition,
	publishProcess,
	updateDraft
} from '$lib/server/stages/process';
import type { ActorContext } from '$lib/server/actor';
import { startTestDatabase, testActor, type TestDatabase } from '../helpers/db';
import { B2C_GROUP_KEY, createInteractionOn, seedProcess, twoStageProcess } from './fixture';

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

/** Исход обещания словами: у отказа — его сообщение, у успеха — «fulfilled». */
function reasonOf(outcome: PromiseSettledResult<unknown>): string {
	return outcome.status === 'fulfilled' ? 'fulfilled' : String(outcome.reason);
}

/** Черновик, который переименовывает первую стадию: сопоставление полное. */
async function prepareRename(ctx: ActorContext): Promise<void> {
	const draft = await createDraft(ctx, B2C_GROUP_KEY);
	const definition = processDefinition(draft);

	await updateDraft(ctx, B2C_GROUP_KEY, {
		...definition,
		stages: definition.stages.map((stage) =>
			stage.key === 'first' ? { ...stage, name: 'Первая стадия после правки' } : stage
		)
	});
}

/**
 * Единственное постусловие: ни одной открытой записи вне действующей редакции
 * своей группы. Считается по всем взаимодействиям, а не по одному: гонка тем и
 * опасна, что портит соседние записи.
 */
async function assertNoStrayEntries(): Promise<number> {
	const stray = await database.db
		.select({ id: stageEntries.id })
		.from(stageEntries)
		.innerJoin(interactions, eq(interactions.id, stageEntries.interactionId))
		.innerJoin(processGroups, eq(processGroups.id, interactions.processGroupId))
		.innerJoin(stages, eq(stages.id, stageEntries.stageId))
		.where(
			and(
				isNull(stageEntries.leftAt),
				// Стадия открытой записи обязана принадлежать действующей редакции
				// своей группы — это и есть инвариант раздела «Гонки».
				eq(stages.revisionId, processGroups.activeRevisionId)
			)
		);

	const open = await database.db
		.select({ id: stageEntries.id })
		.from(stageEntries)
		.where(isNull(stageEntries.leftAt));

	expect(stray).toHaveLength(open.length);

	return open.length;
}

describe('применение изменений и заведение взаимодействия', () => {
	it('детерминированно: публикация ждёт разделяемую блокировку создания', async () => {
		const ctx = admin();
		await seedProcess(database, B2C_GROUP_KEY, twoStageProcess({}));
		await prepareRename(ctx);

		// Транзакция создания берёт `FOR SHARE` на строку группы и держит её.
		let release: () => void = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});

		const holder = database.db.transaction(async (tx) => {
			await tx
				.select({ id: processGroups.id })
				.from(processGroups)
				.where(eq(processGroups.key, B2C_GROUP_KEY))
				.for('share');

			await held;
		});

		await sleep(100);

		const publication = publishProcess(ctx, B2C_GROUP_KEY);
		await sleep(300);

		release();
		await holder;

		await publication;

		// Взаимодействие, заведённое после публикации, встаёт на новую редакцию.
		await createInteractionOn(ctx, database, { kind: 'legal_entity' });

		expect(await assertNoStrayEntries()).toBe(1);
	});

	it('состязательно: двадцать прогонов не оставляют записей вне действующей редакции', async () => {
		const ctx = admin();

		for (let run = 0; run < 20; run += 1) {
			await database.reset();
			await seedProcess(database, B2C_GROUP_KEY, twoStageProcess({}));
			await prepareRename(ctx);

			const [created, publication] = await Promise.allSettled([
				createInteractionOn(ctx, database, { kind: 'legal_entity' }),
				publishProcess(ctx, B2C_GROUP_KEY)
			]);

			// Причина отказа печатается прямо в ожидании: «rejected» без текста не
			// говорит, что именно разошлось.
			expect(reasonOf(publication)).toBe('fulfilled');
			expect(reasonOf(created)).toBe('fulfilled');

			expect(await assertNoStrayEntries()).toBe(1);
		}
	}, 120_000);
});
