import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { documentListQuerySchema } from '$lib/contracts/documents';
import { interactionListQuerySchema } from '$lib/contracts/interactions';
import type { ActorContext } from '$lib/server/actor';
import { loadSessionUser } from '$lib/server/auth/session';
import { interactions, stageEntries, workspaces } from '$lib/server/db/schema';
import { listDocuments, readDocumentForDownload } from '$lib/server/documents/read';
import { ConflictError, NotFoundError } from '$lib/server/errors';
import { getInteraction, listInteractions } from '$lib/server/interactions/read';
import { readFilterOptions } from '$lib/server/reports/options';
import { readReportQuery } from '$lib/server/reports/query';
import { buildReport } from '$lib/server/reports/rows';
import { removeWorkspaceMember } from '$lib/server/rbac/workspaces';
import { search } from '$lib/server/search';
import {
	insertDocument,
	insertInteractionWithStage,
	insertUser,
	startTestDatabase,
	testActor,
	TEST_USER_IDS,
	type TestDatabase
} from '../helpers/db';

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

/** Действующее лицо так, как его собирает запрос: область — из базы. */
async function sessionActor(userId: string): Promise<ActorContext> {
	const user = await loadSessionUser(userId);

	if (user === null) {
		throw new Error('Пользователь не собрался');
	}

	return { ...testActor(), user, scope: user.scope };
}

const MARK = 'граница-пространства';

/**
 * Менеджер ведёт два взаимодействия — каждое в своём пространстве — и
 * исключён из второго. Внутри области по назначениям обе записи его: граница
 * пространства — единственное, что закрывает вторую.
 */
async function arrange() {
	const managerId = await insertUser(database.db, { roleId: 'manager' });
	const inside = await insertInteractionWithStage(database.db, { ownerUserId: managerId });
	const outside = await insertInteractionWithStage(database.db, { ownerUserId: managerId });

	await database.db
		.update(interactions)
		.set({ title: `${MARK} своя` })
		.where(eq(interactions.id, inside.interactionId));
	await database.db
		.update(interactions)
		.set({ title: `${MARK} чужая` })
		.where(eq(interactions.id, outside.interactionId));

	// Отчёт считает записи, стоящие на стадии: ставим обе.
	await database.db.insert(stageEntries).values(
		[inside, outside].map((work) => ({
			interactionId: work.interactionId,
			stageId: work.stageId,
			stageSnapshot: work.snapshot,
			enteredAt: new Date(Date.now() - 60_000)
		}))
	);

	const workspaceOf = async (interactionId: string) => {
		const [found] = await database.db
			.select({ id: workspaces.id, key: workspaces.key })
			.from(interactions)
			.innerJoin(workspaces, eq(workspaces.id, interactions.workspaceId))
			.where(eq(interactions.id, interactionId));

		return found;
	};
	const home = await workspaceOf(inside.interactionId);
	const foreign = await workspaceOf(outside.interactionId);

	const documentId = await insertDocument(database.db, { interactionId: outside.interactionId });

	return {
		managerId,
		inside: inside.interactionId,
		outside: outside.interactionId,
		home,
		foreign,
		documentId
	};
}

async function revoke(managerId: string, workspaceKey: string): Promise<void> {
	await removeWorkspaceMember(testActor(), {
		key: workspaceKey,
		userId: managerId,
		confirmOwned: true
	});
}

/** Отчёт-срез пространства — так, как его собирает экран `/w/<ключ>/reports`. */
function snapshotReport(ctx: ActorContext, workspaceKey: string) {
	return buildReport(
		ctx,
		readReportQuery(
			new URL(`http://localhost/w/${workspaceKey}/reports?mode=snapshot`),
			workspaceKey
		)
	);
}

async function listedIds(ctx: ActorContext): Promise<string[]> {
	const page = await listInteractions(ctx, interactionListQuerySchema.parse({ pageSize: 100 }));

	return page.items.map((item) => item.id).sort();
}

describe('пространство — граница доступа', () => {
	it('закрывает список, карточку, отчёт, поиск и документ сотруднику вне пространства', async () => {
		const setup = await arrange();
		await revoke(setup.managerId, setup.foreign.key);
		const ctx = await sessionActor(setup.managerId);

		expect(await listedIds(ctx)).toEqual([setup.inside]);
		await expect(getInteraction(ctx, setup.outside)).rejects.toBeInstanceOf(NotFoundError);

		const report = await snapshotReport(ctx, setup.home.key);
		expect(report.totals.rowCount).toBe(1);
		// Отчёт чужого пространства — тот же отказ, что у его адреса: «не найдено».
		await expect(snapshotReport(ctx, setup.foreign.key)).rejects.toBeInstanceOf(NotFoundError);

		const hits = await search(ctx, MARK);
		expect(hits.items.filter((hit) => hit.kind === 'interaction').map((hit) => hit.id)).toEqual([
			setup.inside
		]);

		const documents = await listDocuments(ctx, documentListQuerySchema.parse({}));
		expect(documents.items.map((item) => item.id)).not.toContain(setup.documentId);
		await expect(readDocumentForDownload(ctx, setup.documentId)).rejects.toBeInstanceOf(
			NotFoundError
		);
	});

	it('администратор видит всё без членства', async () => {
		const setup = await arrange();
		await revoke(setup.managerId, setup.foreign.key);
		const admin = await sessionActor(TEST_USER_IDS.admin);

		expect(admin.scope).toEqual({ kind: 'all' });
		expect(await listedIds(admin)).toEqual([setup.inside, setup.outside].sort());

		// Отчёт строится внутри пространства: даже тому, кто видит всё, отчёт
		// одного пространства не показывает дел другого.
		const home = await snapshotReport(admin, setup.home.key);
		const foreign = await snapshotReport(admin, setup.foreign.key);

		expect(home.rows.map((row) => row.interactionId)).toEqual([setup.inside]);
		expect(foreign.rows.map((row) => row.interactionId)).toEqual([setup.outside]);
		expect(home.meta.workspace.key).toBe(setup.home.key);
	});

	it('отзыв членства гасит доступ со следующего запроса, и кэш чужого не отдаёт', async () => {
		const setup = await arrange();
		const before = await sessionActor(setup.managerId);

		expect((await getInteraction(before, setup.outside)).id).toBe(setup.outside);
		// Подбор фильтров отчёта кэшируется по отпечатку области: до отзыва стадии
		// второго пространства в нём есть.
		const optionsBefore = await readFilterOptions(before, setup.foreign.key);
		expect(optionsBefore.stages.map((option) => option.value)).toEqual(['contact']);

		// Исключение того, у кого есть работа, без подтверждения не проходит.
		await expect(
			removeWorkspaceMember(testActor(), {
				key: setup.foreign.key,
				userId: setup.managerId,
				confirmOwned: false
			})
		).rejects.toBeInstanceOf(ConflictError);

		await revoke(setup.managerId, setup.foreign.key);

		// Повторного входа нет: тот же пользователь, следующий запрос.
		const after = await sessionActor(setup.managerId);

		await expect(getInteraction(after, setup.outside)).rejects.toBeInstanceOf(NotFoundError);
		const optionsAfter = await readFilterOptions(after, setup.foreign.key);
		expect(optionsAfter.stages).toEqual([]);
	});
});
