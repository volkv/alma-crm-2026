/**
 * Быстрый поиск палитры: что он находит и, главное, чего не находит.
 *
 * Поиск — это ещё один канал к тем же записям, поэтому область доступа в нём
 * проверяется наравне со списками: вуз и взаимодействие вне области обязаны не
 * находиться вовсе. Именно здесь ошибка стоила бы дороже всего — палитра
 * отвечает на любую строку из двух букв, и утечка выглядела бы как удобство.
 *
 * Проверяется эндпоинт целиком, а не сборка выдачи: разбор строки запроса,
 * минимальная длина и потолок группы живут в нём, и увидеть их можно только
 * через ответ.
 */
import type { RequestEvent } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '$lib/server/auth/types';
import {
	affiliations,
	contracts,
	interactionParties,
	interactions,
	organizations
} from '$lib/server/db/schema';
import {
	SEARCH_GROUP_LIMIT,
	searchResultSchema,
	type SearchHit,
	type SearchKind
} from '$lib/search/contract';
import {
	insertInteractionWithStage,
	insertOrganization,
	insertPerson,
	insertUser,
	scopedActor,
	startTestDatabase,
	testActor,
	type TestDatabase
} from '../helpers/db';
import { pageEvent } from '../helpers/event';

// См. комментарий в `helpers/db.ts`: без этого сервисы пойдут в базу разработчика.
vi.mock('$env/dynamic/private', () => ({ env: process.env }));

type Endpoint = (event: RequestEvent) => Promise<Response>;

const searchEndpoint = await import('../../../src/routes/(app)/search/+server');
const search = searchEndpoint.GET as unknown as Endpoint;

/** Метка прогона в названиях: по ней и ищем, чужого она не зацепит. */
const MARK = 'ЛЦТ-ПОИСК';

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

function asUser(context: { user: SessionUser | null }): SessionUser {
	if (context.user === null) {
		throw new Error('Контекст теста обязан нести пользователя');
	}

	return context.user;
}

async function respond(user: SessionUser, query: string): Promise<Response> {
	return search(
		pageEvent({
			path: '/search',
			query: `?q=${encodeURIComponent(query)}`,
			routeId: '/(app)/search',
			user
		})
	);
}

/** Находки одной группы: их порядок и состав и есть предмет проверок. */
async function found(user: SessionUser, query: string, kind: SearchKind): Promise<SearchHit[]> {
	const response = await respond(user, query);

	expect(response.status).toBe(200);

	const result = searchResultSchema.parse(await response.json());

	return result.items.filter((item) => item.kind === kind);
}

/** Взаимодействие с названием и основной стороной — как его видит область доступа. */
async function insertWork(options: {
	ownerUserId: string;
	organizationId: string;
	title: string;
}): Promise<string> {
	const { interactionId } = await insertInteractionWithStage(database.db, {
		ownerUserId: options.ownerUserId
	});

	await database.db
		.update(interactions)
		.set({ title: options.title })
		.where(eq(interactions.id, interactionId));

	await database.db.insert(interactionParties).values({
		interactionId,
		organizationId: options.organizationId,
		partyRole: 'educational_institution',
		isPrimary: true
	});

	return interactionId;
}

describe('что поиск находит', () => {
	it('находит организацию по названию', async () => {
		const id = await insertOrganization(database.db, { shortName: `${MARK} академия связи` });

		const hits = await found(asUser(testActor()), 'академия связи', 'organization');

		expect(hits).toEqual([
			{ kind: 'organization', id, targetId: id, title: `${MARK} академия связи`, subtitle: null }
		]);
	});

	it('находит организацию по ИНН и показывает его подписью', async () => {
		const id = await insertOrganization(database.db, {
			shortName: `${MARK} технический университет`,
			inn: '7714236875'
		});

		const hits = await found(asUser(testActor()), '7714236875', 'organization');

		expect(hits).toEqual([
			{
				kind: 'organization',
				id,
				targetId: id,
				title: `${MARK} технический университет`,
				subtitle: 'ИНН 7714236875'
			}
		]);
	});

	it('находит взаимодействие по названию и подписывает его вузом', async () => {
		const organizationId = await insertOrganization(database.db, { shortName: `${MARK} колледж` });
		const ownerUserId = await insertUser(database.db, { roleId: 'manager' });
		const interactionId = await insertWork({
			ownerUserId,
			organizationId,
			title: `${MARK} программа стажировок`
		});

		const hits = await found(asUser(testActor()), 'программа стажировок', 'interaction');

		expect(hits).toEqual([
			{
				kind: 'interaction',
				id: interactionId,
				targetId: interactionId,
				title: `${MARK} программа стажировок`,
				subtitle: `${MARK} колледж`
			}
		]);
	});
});

describe('область доступа в поиске', () => {
	it('не находит организацию вне области доступа', async () => {
		const mine = await insertOrganization(database.db, { shortName: `${MARK} мой вуз` });
		const foreign = await insertOrganization(database.db, { shortName: `${MARK} чужой вуз` });

		const context = await scopedActor(database.db, {
			roleId: 'manager',
			organizationIds: [mine]
		});

		const hits = await found(asUser(context), MARK, 'organization');

		expect(hits.map((hit) => hit.id)).toEqual([mine]);
		// Полный доступ видит обе: разошлись не данные, а область.
		const all = await found(asUser(testActor()), MARK, 'organization');
		expect(all.map((hit) => hit.id).sort()).toEqual([mine, foreign].sort());
	});

	it('не находит взаимодействие вне области доступа', async () => {
		const mine = await insertOrganization(database.db, { shortName: `${MARK} мой вуз` });
		const foreign = await insertOrganization(database.db, { shortName: `${MARK} чужой вуз` });

		const context = await scopedActor(database.db, {
			roleId: 'manager',
			organizationIds: [mine]
		});
		const stranger = await insertUser(database.db, { roleId: 'manager' });

		const own = await insertWork({
			ownerUserId: asUser(context).id,
			organizationId: mine,
			title: `${MARK} моя работа`
		});
		const alien = await insertWork({
			ownerUserId: stranger,
			organizationId: foreign,
			title: `${MARK} чужая работа`
		});

		// Каждая запись заводится в своём пространстве: актёр собирается заново,
		// когда они уже есть, — иначе его не пустила бы граница пространства.
		const viewer = await scopedActor(database.db, {
			roleId: 'manager',
			userId: asUser(context).id,
			organizationIds: []
		});
		const hits = await found(asUser(viewer), MARK, 'interaction');

		expect(hits.map((hit) => hit.id)).toEqual([own]);

		const all = await found(asUser(testActor()), MARK, 'interaction');
		expect(all.map((hit) => hit.id).sort()).toEqual([own, alien].sort());
	});
});

describe('люди, договоры и домены — в той же области, что их разделы', () => {
	/** Вуз в области менеджера и чужой вуз — с человеком, договором и сайтом у каждого. */
	async function twoUniversities() {
		const mine = await insertOrganization(database.db, { shortName: `${MARK} мой вуз` });
		const foreign = await insertOrganization(database.db, { shortName: `${MARK} чужой вуз` });

		await database.db
			.update(organizations)
			.set({ website: 'https://www.my-univ.example.ru/' })
			.where(eq(organizations.id, mine));
		await database.db
			.update(organizations)
			.set({ website: 'https://alien-univ.example.ru' })
			.where(eq(organizations.id, foreign));

		const own = await insertPerson(database.db, {
			lastName: `${MARK}Своякова`,
			email: 'svoyakova@my-univ.example.ru'
		});
		const alien = await insertPerson(database.db, {
			lastName: `${MARK}Чужакова`,
			email: 'chuzhakova@alien-univ.example.ru'
		});

		await database.db.insert(affiliations).values([
			{
				personId: own,
				organizationId: mine,
				position: 'Проректор',
				roleKind: 'vice_rector',
				validFrom: '2026-01-01'
			},
			{
				personId: alien,
				organizationId: foreign,
				position: 'Проректор',
				roleKind: 'vice_rector',
				validFrom: '2026-01-01'
			}
		]);

		const [ownContract, alienContract] = await database.db
			.insert(contracts)
			.values([
				{ organizationId: mine, number: `${MARK}-Д-001` },
				{ organizationId: foreign, number: `${MARK}-Д-002` }
			])
			.returning({ id: contracts.id });

		const viewer = await scopedActor(database.db, { roleId: 'manager', organizationIds: [mine] });

		return { mine, foreign, own, alien, ownContract, alienContract, viewer: asUser(viewer) };
	}

	it('находит человека по ФИО только в своей области и без контактов в выдаче', async () => {
		const { own, alien, viewer } = await twoUniversities();

		const hits = await found(viewer, `${MARK}`, 'person');

		expect(hits).toEqual([
			{
				kind: 'person',
				id: own,
				targetId: own,
				title: `${MARK}Своякова Тест`,
				subtitle: `Проректор, ${MARK} мой вуз`
			}
		]);

		const all = await found(asUser(testActor()), `${MARK}`, 'person');
		expect(all.map((hit) => hit.id).sort()).toEqual([own, alien].sort());
	});

	it('находит человека по точной почте только тому, кому контакты открыты без маски', async () => {
		const { own } = await twoUniversities();
		const email = 'svoyakova@my-univ.example.ru';

		const open = await found(asUser(testActor()), email, 'person');
		expect(open.map((hit) => hit.id)).toEqual([own]);

		const masked = testActor({
			permissions: ['people.read', 'organizations.read', 'interactions.read']
		});
		expect(await found(asUser(masked), email, 'person')).toEqual([]);
	});

	it('находит договор по номеру в своей области и ведёт в карточку организации', async () => {
		const { mine, ownContract, viewer } = await twoUniversities();

		const hits = await found(viewer, `${MARK}-Д-00`, 'contract');

		expect(hits).toEqual([
			{
				kind: 'contract',
				id: ownContract.id,
				targetId: mine,
				title: `Договор № ${MARK}-Д-001`,
				subtitle: `${MARK} мой вуз`
			}
		]);
	});

	it('находит организацию по домену почты и сайта в своей области', async () => {
		const { mine, foreign, viewer } = await twoUniversities();

		const byEmail = await found(viewer, 'rector@my-univ.example.ru', 'organization');
		expect(byEmail.map((hit) => hit.id)).toEqual([mine]);

		expect(await found(viewer, 'alien-univ.example.ru', 'organization')).toEqual([]);

		const all = await found(asUser(testActor()), 'alien-univ.example.ru', 'organization');
		expect(all.map((hit) => hit.id)).toEqual([foreign]);

		// Общий домен почты не делает своими все сайты под ним.
		expect(await found(asUser(testActor()), 'ivanov@example.ru', 'organization')).toEqual([]);
	});

	it('находит по названию вуз, открытый через своё взаимодействие', async () => {
		const { foreign, viewer } = await twoUniversities();

		expect(await found(viewer, 'чужой вуз', 'organization')).toEqual([]);

		await insertWork({ ownerUserId: viewer.id, organizationId: foreign, title: `${MARK} дело` });
		// Актёр собирается заново: область пространства читается при сборке.
		const again = await scopedActor(database.db, {
			roleId: 'manager',
			userId: viewer.id,
			organizationIds: []
		});

		const hits = await found(asUser(again), 'чужой вуз', 'organization');
		expect(hits.map((hit) => hit.id)).toEqual([foreign]);
	});
});

describe('границы запроса', () => {
	it('запрос короче двух символов отклоняется словами', async () => {
		await insertOrganization(database.db, { shortName: `${MARK} академия` });

		const response = await respond(asUser(testActor()), 'а');

		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toEqual({
			error: 'Поисковый запрос — от 2 символов'
		});
	});

	it('пустой запрос отклоняется так же: на сервер за оглавлением не ходят', async () => {
		const response = await respond(asUser(testActor()), '   ');

		expect(response.status).toBe(400);
	});

	it('в группе не больше пяти строк, сколько бы ни нашлось', async () => {
		const total = SEARCH_GROUP_LIMIT + 2;

		for (let index = 0; index < total; index += 1) {
			await insertOrganization(database.db, { shortName: `${MARK} вуз номер ${index}` });
		}

		const hits = await found(asUser(testActor()), 'вуз номер', 'organization');

		expect(hits).toHaveLength(SEARCH_GROUP_LIMIT);
	});
});
