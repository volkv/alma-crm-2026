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
import {
	blockers,
	interactionParties,
	interactions,
	stageEntries,
	stagePauses,
	workspaces
} from '$lib/server/db/schema';
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
	slaDays?: number;
	/** Норма тишины стадии в днях; без неё тишиной запись не бывает. */
	staleAfterDays?: number;
}): Promise<{ interactionId: string; entryId: string }> {
	const { interactionId, stageId, snapshot } = await insertInteractionWithStage(database.db, {
		ownerUserId: options.ownerUserId,
		slaDays: options.slaDays ?? 5
	});

	await database.db.insert(interactionParties).values({
		interactionId,
		organizationId: options.organizationId,
		partyRole: 'educational_institution',
		isPrimary: true
	});
	const [entry] = await database.db
		.insert(stageEntries)
		.values({
			interactionId,
			stageId,
			stageSnapshot: { ...snapshot, staleAfterDays: options.staleAfterDays ?? null },
			enteredAt: daysFrom(new Date(), -options.daysAgo)
		})
		.returning({ id: stageEntries.id });

	return { interactionId, entryId: entry.id };
}

/** Главная глазами сотрудника: те же пространства, что пускает ему оболочка. */
async function openHome(ctx: Awaited<ReturnType<typeof scopedActor>>) {
	const user = ctx.user as SessionUser;
	const entered = (await database.db.select().from(workspaces)).filter((row) =>
		canEnterWorkspace(ctx, row.id)
	);

	return home(
		pageEvent({
			path: '/',
			routeId: '/(app)',
			user,
			parent: { workspaces: entered.map((row) => ({ key: row.key, name: row.name })) }
		})
	);
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
		const data = await openHome(ctx);

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

	it('пауза, помехи, тишина, завершённые за 30 дней и зависшие ведут в списки ровно с тем же числом', async () => {
		const db = database.db;
		const kamId = await insertUser(db, { roleId: 'manager' });
		const mine = await insertOrganization(db, { shortName: 'Вуз КАМа' });

		// На паузе: открытая пауза на текущей записи.
		const paused = await insertWork({ ownerUserId: kamId, organizationId: mine, daysAgo: 2 });
		await db.insert(stagePauses).values({
			stageEntryId: paused.entryId,
			reason: 'waiting_counterparty',
			note: 'Ждём ответа вуза',
			startedAt: daysFrom(new Date(), -1)
		});

		// С помехой: открытая и снятая — считается только открытая.
		const blocked = await insertWork({ ownerUserId: kamId, organizationId: mine, daysAgo: 2 });
		await db.insert(blockers).values([
			{
				interactionId: blocked.interactionId,
				stageEntryId: blocked.entryId,
				reasonCode: 'other',
				description: 'Нет подписанта',
				raisedBy: kamId
			},
			{
				interactionId: paused.interactionId,
				stageEntryId: paused.entryId,
				reasonCode: 'other',
				description: 'Снята',
				raisedBy: kamId,
				resolvedAt: new Date(),
				resolvedBy: kamId
			}
		]);

		// Тишина: норма три дня, последнее событие пять дней назад.
		const quiet = await insertWork({
			ownerUserId: kamId,
			organizationId: mine,
			daysAgo: 2,
			slaDays: 60,
			staleAfterDays: 3
		});
		await db
			.update(interactions)
			.set({ lastActivityAt: daysFrom(new Date(), -5) })
			.where(eq(interactions.id, quiet.interactionId));

		// Зависли: стоит десять дней при сроке в шестьдесят — не просрочка, а порог.
		await insertWork({ ownerUserId: kamId, organizationId: mine, daysAgo: 10, slaDays: 60 });
		await insertWork({ ownerUserId: kamId, organizationId: mine, daysAgo: 12, slaDays: 60 });

		// Завершённые: одно в окне, одно за его пределами.
		for (const daysAgo of [3, 40]) {
			const done = await insertWork({ ownerUserId: kamId, organizationId: mine, daysAgo });
			await db
				.update(interactions)
				.set({ status: 'completed', lastActivityAt: daysFrom(new Date(), -daysAgo) })
				.where(eq(interactions.id, done.interactionId));
		}

		const ctx = await scopedActor(db, { userId: kamId, organizationIds: [mine] });
		const user = ctx.user as SessionUser;
		const data = await openHome(ctx);

		const counters = (
			data.overview as {
				counters: { paused: number; blocked: number; stale: number; completedRecently: number };
			}
		).counters;
		const myDay = data.myDay as { sections: { kind: string; total: number }[] };
		const lists = data.lists as {
			states: { paused: Part[]; blocked: Part[]; stale: Part[] };
			completed: Part[];
			day: Record<string, Part[]>;
		};
		const sum = (parts: Part[]) => parts.reduce((total, part) => total + part.count, 0);

		expect(counters).toMatchObject({ paused: 1, blocked: 1, stale: 1, completedRecently: 1 });
		expect(sum(lists.states.paused)).toBe(counters.paused);
		expect(sum(lists.states.blocked)).toBe(counters.blocked);
		expect(sum(lists.states.stale)).toBe(counters.stale);
		expect(sum(lists.completed)).toBe(counters.completedRecently);

		const stuck = myDay.sections.find((section) => section.kind === 'stuck');

		expect(stuck?.total).toBe(2);

		// Каждый непустой раздел «Моего дня» о делах — со ссылками, и сумма частей
		// равна числу раздела.
		for (const section of myDay.sections) {
			expect(sum(lists.day[section.kind] ?? [])).toBe(section.total);
		}

		for (const part of [
			...lists.states.paused,
			...lists.states.blocked,
			...lists.states.stale,
			...lists.completed,
			...Object.values(lists.day).flat()
		]) {
			expect(await rowsBehind(user, part)).toBe(part.count);
		}
	});
});
