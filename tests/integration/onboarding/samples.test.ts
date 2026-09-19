/**
 * Образцы записей для подсказок не выходят за область доступа.
 *
 * Тур доводит человека до карточки, и карточку эту выбирает сервер. Значит,
 * выбор обязан подчиняться тем же правилам, что и списки: менеджеру нельзя
 * предложить чужой вуз — ни в списке, ни «просто для примера». Проверять это на
 * заглушке нечем: область доступа живёт в SQL и считается по действующим
 * назначениям, а не по свойству сессии.
 *
 * Заодно проверяется предпочтение: карточка тура рассказывает про сроки и
 * помехи, поэтому просроченная запись берётся раньше спокойной.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { createInteractionSchema } from '$lib/contracts/interactions';
import type { TourSamples } from '$lib/onboarding/screens';
import type { ActorContext } from '$lib/server/actor';
import { stageEntries } from '$lib/server/db/schema';
import { createInteraction } from '$lib/server/interactions/write';
import { B2B_GROUP_KEY, B2B_PROCESS } from '$lib/server/stages/definitions';
import { ensureProcess } from '$lib/server/stages/process';
import {
	daysFrom,
	insertOrganization,
	scopedActor,
	startTestDatabase,
	testActor,
	TEST_USER_IDS,
	type TestDatabase
} from '../helpers/db';
import { pageEvent } from '../helpers/event';

// См. комментарий в `helpers/db.ts`: без этого сервисы пойдут в базу разработчика.
vi.mock('$env/dynamic/private', () => ({ env: process.env }));

type Endpoint = (event: RequestEvent) => Promise<Response>;

const samplesEndpoint = await import('../../../src/routes/(app)/tour/samples/+server');
const readSamples = samplesEndpoint.GET as unknown as Endpoint;

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

/** Процесс учебных заведений: его стадии и ведут взаимодействия набора. */
async function demoProcess(): Promise<string> {
	return database.db.transaction((tx) => ensureProcess(tx, B2B_GROUP_KEY, B2B_PROCESS));
}

async function makeInteraction(options: {
	title: string;
	organizationId: string;
	ownerUserId: string;
}): Promise<string> {
	const created = await createInteraction(
		admin(),
		createInteractionSchema.parse({
			title: options.title,
			ownerUserId: options.ownerUserId,
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
 * поэтому просрочку делают именно так, а не подменой часов процесса.
 */
async function enteredDaysAgo(interactionId: string, days: number): Promise<void> {
	await database.db
		.update(stageEntries)
		.set({ enteredAt: daysFrom(new Date(), -days) })
		.where(and(eq(stageEntries.interactionId, interactionId), isNull(stageEntries.leftAt)));
}

/** Ответ эндпоинта так, как его получит браузер. */
async function fetchSamples(user: ActorContext['user']): Promise<TourSamples> {
	if (user === null) {
		throw new Error('Образцы спрашивает вошедший человек');
	}

	const response = await readSamples(pageEvent({ path: '/tour/samples', user }));

	expect(response.status).toBe(200);
	expect(response.headers.get('cache-control')).toBe('no-store');

	return (await response.json()) as TourSamples;
}

describe('образцы записей для подсказок', () => {
	it('не выходят за область доступа менеджера', async () => {
		await demoProcess();

		const mine = await insertOrganization(database.db, { shortName: 'Свой вуз' });
		const foreign = await insertOrganization(database.db, { shortName: 'Чужой вуз' });
		const manager = await scopedActor(database.db, {
			roleId: 'manager',
			organizationIds: [mine]
		});

		const ownInteraction = await makeInteraction({
			title: 'Своё взаимодействие',
			organizationId: mine,
			ownerUserId: manager.user?.id ?? ''
		});
		const foreignInteraction = await makeInteraction({
			title: 'Чужое взаимодействие',
			organizationId: foreign,
			ownerUserId: TEST_USER_IDS.admin
		});

		const samples = await fetchSamples(manager.user);

		expect(samples.organization).toBe(mine);
		expect(samples.organization).not.toBe(foreign);
		expect(samples.interaction).toBe(ownInteraction);
		expect(samples.interaction).not.toBe(foreignInteraction);

		// Администратору видно всё: у той же базы ответ другой — значит,
		// ограничение считает область доступа, а не пустая выдача.
		const everything = await fetchSamples(admin().user);

		expect(everything.organization).not.toBeNull();
		expect(everything.interaction).not.toBeNull();
	});

	it('предпочитают просроченное взаимодействие спокойному', async () => {
		await demoProcess();

		const organization = await insertOrganization(database.db, { shortName: 'Вуз со сроком' });
		const calm = await makeInteraction({
			title: 'Идёт по сроку',
			organizationId: organization,
			ownerUserId: TEST_USER_IDS.admin
		});
		const overdue = await makeInteraction({
			title: 'Просрочено',
			organizationId: organization,
			ownerUserId: TEST_USER_IDS.admin
		});

		await enteredDaysAgo(overdue, 400);

		const samples = await fetchSamples(admin().user);

		expect(samples.interaction).toBe(overdue);
		expect(samples.interaction).not.toBe(calm);
	});

	it('без прав не отдают ничего', async () => {
		await demoProcess();

		const organization = await insertOrganization(database.db, { shortName: 'Вуз без прав' });

		await makeInteraction({
			title: 'Взаимодействие без зрителей',
			organizationId: organization,
			ownerUserId: TEST_USER_IDS.admin
		});

		const stripped = testActor({ roleId: 'manager', permissions: [] });
		const samples = await fetchSamples(stripped.user);

		expect(Object.values(samples).every((value) => value === null)).toBe(true);
	});
});
