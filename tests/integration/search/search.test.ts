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
import { interactionParties, interactions } from '$lib/server/db/schema';
import {
	SEARCH_GROUP_LIMIT,
	searchResultSchema,
	type SearchHit,
	type SearchKind
} from '$lib/search/contract';
import {
	insertInteractionWithStage,
	insertOrganization,
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
			{ kind: 'organization', id, title: `${MARK} академия связи`, subtitle: null }
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
