/**
 * Сводка рабочего дня на настоящей базе: счётчики портфеля, порядок списка
 * «требуют действия», ожидание стороны, лента событий и область доступа.
 *
 * Проверять это на заглушке нечем: срок стадии считает представление
 * `stage_entry_status`, область доступа живёт в SQL, а лента активности читает
 * журнал, который пишут сами команды движка. Данные готовятся сервисами —
 * состояние, собранное вставками мимо них, не доказывает ничего о продукте.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	createInteractionSchema,
	pauseStageSchema,
	raiseBlockerSchema
} from '$lib/contracts/interactions';
import type { ActorContext } from '$lib/server/actor';
import { interactionParties, interactions, stageEntries } from '$lib/server/db/schema';
import { getWorkOverview } from '$lib/server/interactions/overview';
import { createInteraction } from '$lib/server/interactions/write';
import { pauseStage, raiseBlocker } from '$lib/server/stages/commands';
import { ensureDemoRoute } from '$lib/server/stages/routes';
import { getInteractionStatus } from '$lib/server/stages/status';
import {
	daysFrom,
	insertOrganization,
	startTestDatabase,
	testActor,
	TEST_USER_IDS,
	type TestDatabase
} from '../helpers/db';

// См. комментарий в `helpers/db.ts`: без этого сервисы пойдут в базу разработчика.
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

async function demoRoute(): Promise<string> {
	return database.db.transaction((tx) => ensureDemoRoute(tx));
}

/** Взаимодействие с одним вузом; маршрут сразу ставит его на первую стадию. */
async function makeInteraction(
	ctx: ActorContext,
	options: { routeId: string; title: string; organizationId: string; ownerUserId?: string }
): Promise<string> {
	const created = await createInteraction(
		ctx,
		createInteractionSchema.parse({
			title: options.title,
			routeId: options.routeId,
			ownerUserId: options.ownerUserId ?? TEST_USER_IDS.admin,
			parties: [
				{
					organizationId: options.organizationId,
					partyRole: 'educational_institution',
					isPrimary: true
				}
			]
		})
	);

	return created.id;
}

/**
 * Сдвигает вход на текущую стадию в прошлое. Срок считает база от `entered_at`,
 * поэтому просрочку в тесте делают именно так, а не подменой часов процесса.
 */
async function enteredDaysAgo(interactionId: string, days: number): Promise<void> {
	await database.db
		.update(stageEntries)
		.set({ enteredAt: daysFrom(new Date(), -days) })
		.where(and(eq(stageEntries.interactionId, interactionId), isNull(stageEntries.leftAt)));
}

/** Тишина вокруг записи: протухание считается от последней активности. */
async function silentForDays(interactionId: string, days: number): Promise<void> {
	await database.db
		.update(interactions)
		.set({ lastActivityAt: daysFrom(new Date(), -days) })
		.where(eq(interactions.id, interactionId));
}

async function currentStageId(ctx: ActorContext, interactionId: string): Promise<string> {
	const status = await getInteractionStatus(ctx, interactionId);

	if (status.current === null) {
		throw new Error('У взаимодействия нет открытой стадии');
	}

	return status.current.stageId;
}

async function partyId(interactionId: string): Promise<string> {
	const [row] = await database.db
		.select({ id: interactionParties.id })
		.from(interactionParties)
		.where(eq(interactionParties.interactionId, interactionId));

	return row.id;
}

async function pause(
	ctx: ActorContext,
	interactionId: string,
	note: string,
	nextAction: string | null = null
): Promise<void> {
	await pauseStage(
		ctx,
		pauseStageSchema.parse({
			interactionId,
			fromStageId: await currentStageId(ctx, interactionId),
			reason: 'waiting_counterparty',
			waitingPartyId: await partyId(interactionId),
			nextAction,
			note
		})
	);
}

async function block(ctx: ActorContext, interactionId: string, description: string): Promise<void> {
	await raiseBlocker(
		ctx,
		raiseBlockerSchema.parse({
			interactionId,
			reasonCode: 'no-answer',
			description,
			blocksTransition: true
		})
	);
}

describe('счётчики портфеля', () => {
	it('считают просрочку, паузу, помеху, тишину и завершённые', async () => {
		const ctx = admin();
		const routeId = await demoRoute();
		const organizationId = await insertOrganization(database.db, { shortName: 'Политех' });

		const plain = await makeInteraction(ctx, { routeId, title: 'Обычное', organizationId });
		const overdue = await makeInteraction(ctx, { routeId, title: 'Просроченное', organizationId });
		const paused = await makeInteraction(ctx, { routeId, title: 'На паузе', organizationId });
		const blocked = await makeInteraction(ctx, { routeId, title: 'С помехой', organizationId });
		const silent = await makeInteraction(ctx, { routeId, title: 'Молчит', organizationId });
		const finished = await makeInteraction(ctx, { routeId, title: 'Завершённое', organizationId });

		// Первая стадия демонстрационного маршрута: норматив 7 дней, протухание 5.
		await enteredDaysAgo(overdue, 30);
		await pause(ctx, paused, 'Ждём ответа приёмной комиссии');
		await block(ctx, blocked, 'Координатор не отвечает');
		await silentForDays(silent, 30);

		// Команды «завершить» в движке пока нет: взаимодействие закрывают руками,
		// а счётчику важен сам факт статуса и момент последнего события.
		await database.db
			.update(interactions)
			.set({ status: 'completed' })
			.where(eq(interactions.id, finished));

		const overview = await getWorkOverview(ctx);

		expect(overview.counters.active).toBe(5);
		expect(overview.counters.overdue).toBe(1);
		expect(overview.counters.paused).toBe(1);
		expect(overview.counters.blocked).toBe(1);
		expect(overview.counters.stale).toBe(1);
		expect(overview.counters.completedRecently).toBe(1);

		// Все активные стоят на первой стадии — значит, портфель весь в контактах.
		expect(overview.distribution.total).toBe(5);
		expect(overview.distribution.leading).toBe('contact');
		expect(overview.distribution.shares).toEqual([{ category: 'contact', count: 5 }]);
		expect(overview.distribution.stageless).toBe(0);

		// Записи, которой ничто не мешает, в списке ничего и не приписывают.
		const plainTask = overview.needsAction.tasks.find((task) => task.interaction.id === plain);
		expect(plainTask?.impediment).toBeNull();
	});

	it('не считает завершённое полгода назад', async () => {
		const ctx = admin();
		const routeId = await demoRoute();
		const organizationId = await insertOrganization(database.db);

		const finished = await makeInteraction(ctx, {
			routeId,
			title: 'Давно закрыто',
			organizationId
		});

		await database.db
			.update(interactions)
			.set({ status: 'completed', lastActivityAt: daysFrom(new Date(), -180) })
			.where(eq(interactions.id, finished));

		const overview = await getWorkOverview(ctx);

		expect(overview.counters.active).toBe(0);
		expect(overview.counters.completedRecently).toBe(0);
	});
});

describe('требуют действия', () => {
	it('ставит вперёд просрочку, затем помеху, затем близкий срок', async () => {
		const ctx = admin();
		const routeId = await demoRoute();
		const organizationId = await insertOrganization(database.db);

		const rest = await makeInteraction(ctx, { routeId, title: 'Времени вдоволь', organizationId });
		const soon = await makeInteraction(ctx, { routeId, title: 'Срок на подходе', organizationId });
		const blocked = await makeInteraction(ctx, { routeId, title: 'С помехой', organizationId });
		const overdue = await makeInteraction(ctx, { routeId, title: 'Просроченное', organizationId });

		// Норматив первой стадии — 7 дней: вход шесть дней назад оставляет один.
		await enteredDaysAgo(soon, 6);
		await enteredDaysAgo(overdue, 30);
		await block(ctx, blocked, 'Вуз просит другой комплект документов');

		const overview = await getWorkOverview(ctx);

		expect(overview.needsAction.basis).toBe('mine');
		expect(overview.needsAction.tasks.map((task) => task.interaction.id)).toEqual([
			overdue,
			blocked,
			soon,
			rest
		]);
		expect(overview.needsAction.tasks[1].impediment).toEqual({
			kind: 'blocker',
			text: 'Вуз просит другой комплект документов',
			blocksTransition: true
		});
	});

	it('объясняет строку паузой и тишиной, когда помехи нет', async () => {
		const ctx = admin();
		const routeId = await demoRoute();
		const organizationId = await insertOrganization(database.db, { shortName: 'Педагогический' });

		const paused = await makeInteraction(ctx, { routeId, title: 'Ждём вуз', organizationId });
		const silent = await makeInteraction(ctx, { routeId, title: 'Тишина', organizationId });

		await pause(ctx, paused, 'Ждём подписанный экземпляр', 'Позвонить в деканат');
		await silentForDays(silent, 30);

		const overview = await getWorkOverview(ctx);
		const byId = new Map(
			overview.needsAction.tasks.map((task) => [task.interaction.id, task.impediment])
		);

		expect(byId.get(paused)).toEqual({
			kind: 'waiting',
			party: 'Педагогический',
			text: 'Позвонить в деканат'
		});
		expect(byId.get(silent)?.kind).toBe('silence');
	});

	it('показывает просроченные по всем, когда своих взаимодействий нет', async () => {
		const ctx = admin();
		const routeId = await demoRoute();
		const organizationId = await insertOrganization(database.db);

		const overdue = await makeInteraction(ctx, {
			routeId,
			title: 'Горит у соседа',
			organizationId
		});
		await makeInteraction(ctx, { routeId, title: 'Не горит', organizationId });
		await enteredDaysAgo(overdue, 30);

		// Наблюдатель не ведёт взаимодействий: пустой список не сказал бы ему
		// ничего, а горящее по соседству — говорит.
		const viewer = await getWorkOverview(testActor({ roleId: 'viewer' }));

		expect(viewer.needsAction.basis).toBe('all');
		expect(viewer.needsAction.tasks.map((task) => task.interaction.id)).toEqual([overdue]);
	});
});

describe('ожидание и лента', () => {
	it('называет сторону и то, чего от неё ждут', async () => {
		const ctx = admin();
		const routeId = await demoRoute();
		const organizationId = await insertOrganization(database.db, { shortName: 'Политех' });

		const paused = await makeInteraction(ctx, { routeId, title: 'Ждём подпись', organizationId });
		await pause(ctx, paused, 'Соглашение у проректора', 'Напомнить через неделю');

		const overview = await getWorkOverview(ctx);

		expect(overview.waiting).toHaveLength(1);
		expect(overview.waiting[0]).toMatchObject({
			interactionId: paused,
			title: 'Ждём подпись',
			party: 'Политех',
			note: 'Соглашение у проректора',
			nextAction: 'Напомнить через неделю'
		});
	});

	it('показывает менеджеру след работы по взаимодействиям', async () => {
		const manager = testActor({ roleId: 'manager' });
		const routeId = await demoRoute();
		const organizationId = await insertOrganization(database.db);

		const created = await makeInteraction(manager, {
			routeId,
			title: 'Новое взаимодействие',
			organizationId,
			ownerUserId: TEST_USER_IDS.manager
		});

		// У менеджера нет права `audit.read`: журнал целиком — инструмент
		// администратора. След работы над своими же записями он видеть обязан.
		const overview = await getWorkOverview(manager);

		expect(manager.user?.permissions.has('audit.read')).toBe(false);
		expect(overview.activity.map((event) => event.eventType)).toContain('interactions.created');
		expect(overview.activity.every((event) => event.interactionId === created)).toBe(true);
		expect(overview.activity[0].actorLabel).toBe('Тестовый Пользователь');
	});
});

describe('область доступа', () => {
	it('не пускает в сводку то, что за её пределами', async () => {
		const ctx = admin();
		const routeId = await demoRoute();
		const mine = await insertOrganization(database.db, { shortName: 'Свой вуз' });
		const theirs = await insertOrganization(database.db, { shortName: 'Чужой вуз' });

		const visible = await makeInteraction(ctx, {
			routeId,
			title: 'Своё',
			organizationId: mine,
			ownerUserId: TEST_USER_IDS.manager
		});
		const hidden = await makeInteraction(ctx, {
			routeId,
			title: 'Чужое',
			organizationId: theirs,
			ownerUserId: TEST_USER_IDS.manager
		});

		await enteredDaysAgo(hidden, 30);
		await pause(ctx, hidden, 'Ждём чужой вуз');
		await block(ctx, hidden, 'Чужая помеха');

		const limited = testActor({ roleId: 'manager', organizationIds: [mine] });
		const overview = await getWorkOverview(limited);

		expect(overview.counters.active).toBe(1);
		expect(overview.counters.overdue).toBe(0);
		expect(overview.counters.paused).toBe(0);
		expect(overview.counters.blocked).toBe(0);
		expect(overview.distribution.total).toBe(1);
		expect(overview.needsAction.tasks.map((task) => task.interaction.id)).toEqual([visible]);
		expect(overview.waiting).toEqual([]);
		expect(overview.activity.every((event) => event.interactionId === visible)).toBe(true);
	});
});
