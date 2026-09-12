/**
 * Браузерный контур отвечает отказом, а не пятисотой.
 *
 * Предметная ошибка сервиса (нет права, нет записи, запрос не разобран) должна
 * доезжать до человека как 403, 404 или 400 — со своим текстом и внутри
 * оболочки приложения. Пятисотая на месте отказа — это не «страховка», а
 * потерянное объяснение: человек видит поломку там, где система работает
 * правильно. Проверяются здесь именно загрузчики и эндпоинты оболочки: перевод
 * живёт в них, и ошибиться можно только в них.
 */
import type { RequestEvent } from '@sveltejs/kit';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '$lib/server/auth/types';
import { startTestDatabase, testActor, type TestDatabase } from '../helpers/db';
import { pageEvent, sessionUser } from '../helpers/event';

// См. комментарий в `helpers/db.ts`: без этого сервисы пойдут в базу разработчика.
vi.mock('$env/dynamic/private', () => ({ env: process.env }));

type PageLoad = (event: RequestEvent) => Promise<unknown>;
type Endpoint = (event: RequestEvent) => Promise<Response>;

const hooks = await import('../../../src/hooks.server');
const overviewPage = await import('../../../src/routes/(app)/+page.server');
const newInteractionPage = await import('../../../src/routes/(app)/interactions/new/+page.server');
const lookupEndpoint = await import('../../../src/routes/(app)/interactions/lookup/+server');
const downloadEndpoint =
	await import('../../../src/routes/(app)/documents/[id=uuid]/download/+server');

const loadOverview = overviewPage.load as unknown as PageLoad;
const loadNewInteraction = newInteractionPage.load as unknown as PageLoad;
const lookup = lookupEndpoint.GET as unknown as Endpoint;
const download = downloadEndpoint.GET as unknown as Endpoint;

/** Идентификатор, которого нет ни в одной таблице, но по форме — наш. */
const ABSENT_ID = '00000000-0000-4000-8000-0000000000ff';

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

/** Вошедший, у которого не осталось ни одного права. */
function userWithoutPermissions(): SessionUser {
	const user = testActor({ roleId: 'viewer', permissions: [] }).user;

	if (user === null) {
		throw new Error('testActor обязан вернуть пользователя');
	}

	return user;
}

describe('отказ, который сочинил не мы', () => {
	/**
	 * Часть отказов приходит от самого фреймворка: тело больше потолка (413) или
	 * форма подана не как форма (415). До нашего кода такой запрос не доходит, и
	 * человеку без этой таблицы досталась бы «внутренняя ошибка сервера» — то
	 * есть обещание поломки там, где система работает правильно.
	 */
	async function rejection(status: number, message: string): Promise<{ message: string }> {
		return (await hooks.handleError({
			error: new Error(message),
			event: pageEvent({}),
			status,
			message
		})) as { message: string };
	}

	it('называет потолок, а не «внутреннюю ошибку», на слишком большом теле', async () => {
		const failed = await rejection(413, 'Payload Too Large');

		expect(failed.message).toBe('Файл или запрос больше, чем принимает сервер (до 25 МиБ)');
	});

	it('говорит про формат запроса, а не про поломку, на чужом content-type', async () => {
		const failed = await rejection(415, 'Unsupported Media Type');

		expect(failed.message).toBe('Неподдерживаемый формат запроса');
	});

	it('незнакомый сбой остаётся внутренней ошибкой и уходит в лог', async () => {
		const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

		try {
			const failed = await rejection(500, 'что-то сломалось');

			expect(failed.message).toBe('Внутренняя ошибка сервера');
			expect(logged).toHaveBeenCalledOnce();
		} finally {
			logged.mockRestore();
		}
	});

	it('отвергнутый по форме запрос не выдаётся за сбой приложения', async () => {
		const failed = vi.spyOn(console, 'error').mockImplementation(() => {});
		const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});

		try {
			await rejection(413, 'Payload Too Large');

			// Стек описывает наш код, а причина лежит в самом запросе: в логе от
			// него остаётся строка, а не трасса, и не строка про наш сбой.
			expect(failed).not.toHaveBeenCalled();
			expect(warned).toHaveBeenCalledOnce();
		} finally {
			failed.mockRestore();
			warned.mockRestore();
		}
	});
});

describe('отказ вместо пятисотой', () => {
	it('сводка рабочего дня без права на взаимодействия отвечает 403', async () => {
		await expect(
			loadOverview(pageEvent({ path: '/', user: userWithoutPermissions() }))
		).rejects.toMatchObject({
			status: 403,
			body: { message: 'Недостаточно прав: требуется «interactions.read»' }
		});
	});

	it('форма заведения взаимодействия закрыта наблюдателю', async () => {
		await expect(
			loadNewInteraction(
				pageEvent({
					path: '/interactions/new',
					routeId: '/(app)/interactions/new',
					user: sessionUser('viewer')
				})
			)
		).rejects.toMatchObject({
			status: 403,
			body: { message: 'Недостаточно прав: требуется «interactions.write»' }
		});
	});

	it('карточка документа, которого нет, отвечает 404', async () => {
		await expect(
			download(
				pageEvent({
					path: `/documents/${ABSENT_ID}/download`,
					routeId: '/(app)/documents/[id=uuid]/download',
					params: { id: ABSENT_ID }
				})
			)
		).rejects.toMatchObject({ status: 404 });
	});
});

describe('подсказки формы взаимодействия', () => {
	const lookupEvent = (query: string, user?: SessionUser): RequestEvent =>
		pageEvent({
			path: '/interactions/lookup',
			routeId: '/(app)/interactions/lookup',
			query,
			user
		});

	it('не пускает в выборку идентификатор, который не может быть нашим', async () => {
		const response = await lookup(lookupEvent('?kind=sites&organizationId=abc'));

		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toMatchObject({
			error: 'Не указана организация или её идентификатор некорректен'
		});
	});

	it('так же отвечает на подсказку без организации вовсе', async () => {
		const response = await lookup(lookupEvent('?kind=contacts'));

		expect(response.status).toBe(400);
	});

	it('не знает видов подсказки, кроме своих', async () => {
		const response = await lookup(lookupEvent('?kind=что-нибудь'));

		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toMatchObject({ error: 'Неизвестный вид подсказки' });
	});

	it('отказ по правам отдаёт 403, а не 400', async () => {
		const response = await lookup(
			lookupEvent(`?kind=sites&organizationId=${ABSENT_ID}`, userWithoutPermissions())
		);

		expect(response.status).toBe(403);
		await expect(response.json()).resolves.toMatchObject({
			error: 'Недостаточно прав: требуется «organizations.read»'
		});
	});
});
