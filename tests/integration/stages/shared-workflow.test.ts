/**
 * Один процесс на два пространства.
 *
 * Ради этого процесс и вынесен из пространства: два направления, работающие по
 * одному сценарию, — это два места и один процесс, а не две копии стадий,
 * которые разъедутся на первой же правке. Проверяется то, что из этого следует:
 * публикация меняет работу в обоих местах сразу, записи переезжают в обоих, а
 * блокировка берётся с процесса — иначе две публикации одного процесса,
 * начатые из разных мест, прошли бы одновременно.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { workflows, workspaces } from '$lib/server/db/schema';
import type { ActorContext } from '$lib/server/actor';
import {
	assignWorkflow,
	createDraft,
	ensureWorkflow,
	processDefinition,
	publishProcess,
	readWorkspaceByKey,
	requireActiveRevisionForWorkspace,
	updateDraft
} from '$lib/server/stages/process';
import { getInteractionStatus } from '$lib/server/stages/status';
import { startTestDatabase, testActor, TEST_USER_IDS, type TestDatabase } from '../helpers/db';
import {
	advanceTo,
	B2B_WORKSPACE_KEY,
	B2C_WORKSPACE_KEY,
	createInteractionOn,
	threeStageProcess
} from './fixture';

vi.mock('$env/dynamic/private', () => ({ env: process.env }));

/** Ключ процесса, назначенного обоим пространствам стенда. */
const SHARED_KEY = 'shared';

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

function admin(): ActorContext {
	return testActor({ userId: TEST_USER_IDS.admin });
}

/** Один процесс из трёх стадий, назначенный обоим пространствам. */
async function shareProcess(): Promise<void> {
	await database.db.transaction(async (tx) => {
		await ensureWorkflow(tx, SHARED_KEY, threeStageProcess());
		await assignWorkflow(tx, B2B_WORKSPACE_KEY, SHARED_KEY);
		await assignWorkflow(tx, B2C_WORKSPACE_KEY, SHARED_KEY);
	});
}

/** Действующая редакция процесса, назначенного пространству. */
async function activeOf(workspaceKey: string) {
	const workspace = await readWorkspaceByKey(database.db, workspaceKey);

	return requireActiveRevisionForWorkspace(database.db, workspace.id);
}

/** Ключ стадии, на которой стоит взаимодействие прямо сейчас. */
async function stageKeyOf(ctx: ActorContext, interactionId: string): Promise<string | null> {
	return (await getInteractionStatus(ctx, interactionId)).current?.snapshot.key ?? null;
}

describe('процесс, назначенный двум пространствам', () => {
	it('назначается обоим и отдаёт им одну и ту же действующую редакцию', async () => {
		await shareProcess();

		const rows = await database.db
			.select({ workspaceKey: workspaces.key, workflowKey: workflows.key })
			.from(workspaces)
			.innerJoin(workflows, eq(workflows.id, workspaces.workflowId))
			.orderBy(workspaces.position);

		expect(rows).toStrictEqual([
			{ workspaceKey: B2B_WORKSPACE_KEY, workflowKey: SHARED_KEY },
			{ workspaceKey: B2C_WORKSPACE_KEY, workflowKey: SHARED_KEY }
		]);

		const b2b = await activeOf(B2B_WORKSPACE_KEY);
		const b2c = await activeOf(B2C_WORKSPACE_KEY);

		// Не «такая же», а та же самая: две редакции с одинаковыми стадиями — это
		// две копии, которые разойдутся, и ради того, чтобы их не было, процесс и
		// вынесен из пространства.
		expect(b2c.id).toBe(b2b.id);
	});

	it('публикацией меняет процесс в обоих пространствах и переносит записи в обоих', async () => {
		const ctx = admin();
		await shareProcess();

		const inB2b = await createInteractionOn(ctx, database, { kind: 'educational_institution' });
		const inB2c = await createInteractionOn(ctx, database, { kind: 'legal_entity' });

		await advanceTo(ctx, database, inB2b.interactionId, 'offer');
		await advanceTo(ctx, database, inB2c.interactionId, 'offer');

		const before = await activeOf(B2B_WORKSPACE_KEY);

		// Стадия «Предложение» исчезает, и правило по умолчанию уводит тех, кто на
		// ней стоял, на ближайшую уцелевшую назад. Черновик и публикация зовутся
		// ключом процесса: правят описание работы, а не место, где по нему идут.
		const draft = await createDraft(ctx, SHARED_KEY);
		const definition = processDefinition(draft);

		await updateDraft(ctx, SHARED_KEY, {
			...definition,
			stages: definition.stages.filter((stage) => stage.key !== 'offer'),
			transitions: [
				{
					fromStageKey: 'intake',
					toStageKey: 'done',
					kind: 'forward',
					requiredPermissionKey: 'stages.transition',
					requiresReason: false
				}
			]
		});

		const result = await publishProcess(ctx, SHARED_KEY);

		// Публикацию затеяли из одного места, а сосчитала она оба: процесс один,
		// и записи на исчезнувшей стадии есть в обоих.
		expect(result.workflowKey).toBe(SHARED_KEY);
		expect(result.migratedCount).toBe(2);

		const afterB2b = await activeOf(B2B_WORKSPACE_KEY);
		const afterB2c = await activeOf(B2C_WORKSPACE_KEY);

		expect(afterB2b.id).not.toBe(before.id);
		expect(afterB2c.id).toBe(afterB2b.id);
		expect(afterB2b.stages.map((stage) => stage.key)).toStrictEqual(['intake', 'done']);

		await expect(stageKeyOf(ctx, inB2b.interactionId)).resolves.toBe('intake');
		await expect(stageKeyOf(ctx, inB2c.interactionId)).resolves.toBe('intake');
	});

	it('держит один черновик на процесс, а не на место, где по нему работают', async () => {
		const ctx = admin();
		await shareProcess();

		await createDraft(ctx, SHARED_KEY);

		// Черновик принадлежит процессу: два описания одной работы опубликовались
		// бы оба, и какое из них описывает работу, стало бы вопросом порядка
		// нажатий.
		await expect(createDraft(ctx, SHARED_KEY)).rejects.toThrow(/черновик/i);
	});
});
