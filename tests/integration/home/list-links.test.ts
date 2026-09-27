/**
 * Числа «Моего дня» и портфеля на главной — и списки, куда ведут их ссылки.
 *
 * Обещание сводки: число на плитке совпадает со списком по её ссылке. Сводка
 * считает по всем пространствам сотрудника, а список живёт в пространстве,
 * поэтому число раскладывается по пространствам, и проверяется ровно это: сумма
 * частей равна плитке, а каждая часть — числу строк списка, открытого по её
 * ссылке тем же загрузчиком, что и в браузере.
 */
import type { RequestEvent } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '$lib/server/auth/types';
import { interactionParties, stageEntries, workspaces } from '$lib/server/db/schema';
import { canEnterWorkspace } from '$lib/server/rbac';
import {
	daysFrom,
	insertInteractionWithStage,
	insertOrganization,
	insertUser,
	scopedActor,
	startTestDatabase,
	type TestDatabase
} from '../helpers/db';
import { pageEvent } from '../helpers/event';

// См. комментарий в `helpers/db.ts`: без этого сервисы пойдут в базу разработчика.
vi.mock('$env/dynamic/private', () => ({ env: process.env }));

type Load = (event: RequestEvent) => Promise<Record<string, unknown>>;

const home = (await import('../../../src/routes/(app)/+page.server')).load as unknown as Load;
const list = (await import('../../../src/routes/(app)/w/[workspace]/interactions/+page.server'))
	.load as unknown as Load;

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

type Part = { key: string; name: string; count: number; href: string };

/** Взаимодействие в своём пространстве, с основной стороной и стадией, вошедшей `daysAgo` назад. */
async function insertWork(options: {
	ownerUserId: string;
	organizationId: string;
	daysAgo: number;
}): Promise<void> {
	const { interactionId, stageId, snapshot } = await insertInteractionWithStage(database.db, {
		ownerUserId: options.ownerUserId,
		slaDays: 5
	});

	await database.db.insert(interactionParties).values({
		interactionId,
		organizationId: options.organizationId,
		partyRole: 'educational_institution',
		isPrimary: true
	});
	await database.db.insert(stageEntries).values({
		interactionId,
		stageId,
		stageSnapshot: snapshot,
		enteredAt: daysFrom(new Date(), -options.daysAgo)
	});
}

/** Строк в списке пространства, открытом по ссылке плитки. */
async function rowsBehind(user: SessionUser, part: Part): Promise<number> {
	const [path, query] = part.href.split('?');
	const [target] = await database.db.select().from(workspaces).where(eq(workspaces.key, part.key));

	if (target === undefined) {
		throw new Error(`Ссылка ведёт в незаведённое пространство «${part.key}»`);
	}

	const data = await list(
		pageEvent({
			path,
			query: `?${query}`,
			routeId: '/(app)/w/[workspace]/interactions',
			params: { workspace: part.key },
			user,
			parent: {
				workspace: {
					id: target.id,
					key: target.key,
					name: target.name,
					hasWorkflow: true,
					modules: []
				}
			}
		})
	);

	expect(data.view).toBe('table');

	return data.total as number;
}

describe('ссылки главной в списки пространств', () => {
	it('у КАМа просрочка из двух пространств раскладывается по ним, и каждая часть — ровно список по её ссылке', async () => {
		const db = database.db;
		const kamId = await insertUser(db, { roleId: 'manager' });
		const colleagueId = await insertUser(db, { roleId: 'manager' });
		const mine = await insertOrganization(db, { shortName: 'Вуз КАМа' });
		const foreign = await insertOrganization(db, { shortName: 'Чужой вуз' });

		// Своё просроченное дело, просроченное дело коллеги по вузу КАМа, своё
		// дело в срок и просроченное дело коллеги по чужому вузу — вне области.
		await insertWork({ ownerUserId: kamId, organizationId: mine, daysAgo: 10 });
		await insertWork({ ownerUserId: colleagueId, organizationId: mine, daysAgo: 10 });
		await insertWork({ ownerUserId: kamId, organizationId: mine, daysAgo: 1 });
		await insertWork({ ownerUserId: colleagueId, organizationId: foreign, daysAgo: 10 });

		// Актёр собирается, когда пространства уже заведены: иначе граница
		// пространства не пустила бы его к записям.
		const ctx = await scopedActor(db, { userId: kamId, organizationIds: [mine] });
		const user = ctx.user as SessionUser;
		const entered = (await db.select().from(workspaces)).filter((row) =>
			canEnterWorkspace(ctx, row.id)
		);

		const data = await home(
			pageEvent({
				path: '/',
				routeId: '/(app)',
				user,
				parent: { workspaces: entered.map((row) => ({ key: row.key, name: row.name })) }
			})
		);

		const myDay = data.myDay as { sections: { kind: string; total: number }[] };
		const overview = data.overview as { counters: { active: number; overdue: number } };
		const lists = data.lists as { active: Part[]; overdue: Part[]; mine: Part[] };
		const overdueSection = myDay.sections.find((section) => section.kind === 'overdue');

		expect(overdueSection?.total).toBe(2);
		expect(overview.counters.overdue).toBe(2);
		expect(overview.counters.active).toBe(3);

		// Два пространства — две части, и сумма частей равна плитке.
		expect(lists.overdue).toHaveLength(2);
		expect(lists.overdue.reduce((sum, part) => sum + part.count, 0)).toBe(2);
		expect(lists.active.reduce((sum, part) => sum + part.count, 0)).toBe(3);
		// «Мои» — только те, что КАМ ведёт сам, без дела коллеги по его вузу.
		expect(lists.mine.reduce((sum, part) => sum + part.count, 0)).toBe(2);

		for (const part of [...lists.overdue, ...lists.active, ...lists.mine]) {
			expect(await rowsBehind(user, part)).toBe(part.count);
		}
	});
});
