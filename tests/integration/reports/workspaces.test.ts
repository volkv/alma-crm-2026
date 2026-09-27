/**
 * Общий отчёт по пространствам: выборка — объединение доступного по каждому
 * пространству с учётом области, а воронка — по пространству отдельно.
 *
 * Три пространства, у каждого свой процесс, и у всех трёх одна и та же стадия
 * по ключу (`contact`): одинаковые ключи в разных процессах законны, и именно
 * на них сумма по стадиям разных процессов была бы незаметна.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { ReportView } from '$lib/contracts/reports';
import type { ActorContext } from '$lib/server/actor';
import { interactions, stageEntries, workspaces } from '$lib/server/db/schema';
import { NotFoundError } from '$lib/server/errors';
import { checkReportInvariants } from '$lib/server/reports/invariants';
import { readReportQuery } from '$lib/server/reports/query';
import { buildReport } from '$lib/server/reports/rows';
import {
	insertInteractionWithStage,
	insertUser,
	startTestDatabase,
	testActor,
	type TestDatabase
} from '../helpers/db';

vi.mock('$env/dynamic/private', () => ({ env: process.env }));

process.env.OIDC_ISSUER_URL ??= 'http://localhost:8080/realms/lct';
process.env.OIDC_PUBLIC_URL ??= 'http://localhost:8080/realms/lct';
process.env.OIDC_CLIENT_ID ??= 'lct-crm';
process.env.OIDC_CLIENT_SECRET ??= 'test-secret';

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

type Space = { id: string; key: string; name: string };

/**
 * Первый КАМ ведёт дела в пространствах `first` и `third`, второй — в `second`
 * и ещё одно дело в `first`, то есть в пространстве первого, но не его.
 */
async function arrange() {
	const kamA = await insertUser(database.db, { roleId: 'manager' });
	const kamB = await insertUser(database.db, { roleId: 'manager' });

	const first = await insertInteractionWithStage(database.db, { ownerUserId: kamA });
	const second = await insertInteractionWithStage(database.db, { ownerUserId: kamB });
	const third = await insertInteractionWithStage(database.db, { ownerUserId: kamA });

	const spaceOf = async (interactionId: string): Promise<Space> => {
		const [found] = await database.db
			.select({ id: workspaces.id, key: workspaces.key, name: workspaces.name })
			.from(interactions)
			.innerJoin(workspaces, eq(workspaces.id, interactions.workspaceId))
			.where(eq(interactions.id, interactionId));

		return found;
	};

	const spaces = {
		first: await spaceOf(first.interactionId),
		second: await spaceOf(second.interactionId),
		third: await spaceOf(third.interactionId)
	};

	// Названия разные: по ним отчёт подписывает блоки воронки.
	for (const [label, space] of Object.entries(spaces)) {
		space.name = `Пространство ${label}`;
		await database.db
			.update(workspaces)
			.set({ name: space.name })
			.where(eq(workspaces.id, space.id));
	}

	// Чужое дело в пространстве первого КАМа — на той же стадии того же процесса.
	const [foreignDeal] = await database.db
		.insert(interactions)
		.values({ title: 'Дело второго КАМа', workspaceId: spaces.first.id, ownerUserId: kamB })
		.returning({ id: interactions.id });

	const enteredAt = new Date(Date.now() - 60_000);

	await database.db.insert(stageEntries).values([
		...[first, second, third].map((work) => ({
			interactionId: work.interactionId,
			stageId: work.stageId,
			stageSnapshot: work.snapshot,
			enteredAt
		})),
		{
			interactionId: foreignDeal.id,
			stageId: first.stageId,
			stageSnapshot: first.snapshot,
			enteredAt
		}
	]);

	return {
		kamA,
		kamB,
		spaces,
		deals: {
			first: first.interactionId,
			second: second.interactionId,
			third: third.interactionId,
			foreign: foreignDeal.id
		}
	};
}

function report(ctx: ActorContext, search = ''): Promise<ReportView> {
	return buildReport(
		ctx,
		readReportQuery(new URL(`http://localhost/reports?mode=snapshot${search}`))
	);
}

function rowIds(view: ReportView): string[] {
	return view.rows.map((row) => row.interactionId).sort();
}

/** Воронка как «пространство → [стадия, число]»: блоки не сливаются по ключу стадии. */
function funnelBlocks(view: ReportView): Record<string, [string, number][]> {
	if (view.charts.funnel === null) {
		throw new Error('У среза нет воронки');
	}

	return Object.fromEntries(
		view.charts.funnel.workspaces.map((block) => [
			block.workspaceKey,
			block.stages.map((bucket): [string, number] => [bucket.filter?.value ?? '', bucket.value])
		])
	);
}

describe('общий отчёт по пространствам', () => {
	it('объединяет доступное по пространствам с учётом области и не складывает стадии разных процессов', async () => {
		const { kamA, kamB, spaces, deals } = await arrange();

		// КАМ включён в два своих пространства и видит только свои дела: чужое
		// пространство и чужое дело в своём пространстве в выборку не попадают.
		const kam = testActor({
			roleId: 'manager',
			userId: kamA,
			scopeUserIds: [kamA],
			workspaceIds: [spaces.first.id, spaces.third.id]
		});
		const kamView = await report(kam);

		expect(rowIds(kamView)).toEqual([deals.first, deals.third].sort());
		expect(funnelBlocks(kamView)).toEqual({
			[spaces.first.key]: [['contact', 1]],
			[spaces.third.key]: [['contact', 1]]
		});
		expect(checkReportInvariants(kamView)).toEqual([]);

		// Фильтр чужим пространством — «не найдено», а не отчёт по всем своим.
		await expect(report(kam, `&workspace=${spaces.second.key}`)).rejects.toBeInstanceOf(
			NotFoundError
		);

		// Руководитель обоих КАМов во всех трёх пространствах видит всё — и три
		// воронки: 2 + 1 + 1, а не одну полосу «Первый контакт» с четырьмя.
		const lead = testActor({
			roleId: 'lead',
			scopeUserIds: [kamA, kamB],
			workspaceIds: [spaces.first.id, spaces.second.id, spaces.third.id]
		});
		const leadView = await report(lead);

		expect(rowIds(leadView)).toEqual(Object.values(deals).sort());
		expect(leadView.totals.rowCount).toBe(4);
		expect(funnelBlocks(leadView)).toEqual({
			[spaces.first.key]: [['contact', 2]],
			[spaces.second.key]: [['contact', 1]],
			[spaces.third.key]: [['contact', 1]]
		});
		expect(checkReportInvariants(leadView)).toEqual([]);

		// Фильтр пространств сужает ту же выборку, и воронки — только выбранных.
		const narrowed = await report(
			lead,
			`&workspace=${spaces.first.key}&workspace=${spaces.third.key}`
		);

		expect(rowIds(narrowed)).toEqual([deals.first, deals.foreign, deals.third].sort());
		expect(Object.keys(funnelBlocks(narrowed)).sort()).toEqual(
			[spaces.first.key, spaces.third.key].sort()
		);
	});
});
