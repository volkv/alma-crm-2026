import type { RequestEvent } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { AuditEventType } from '$lib/contracts/audit';
import type { SessionUser } from '$lib/server/auth/types';
import { apiHandler, type ApiEndpointConfig } from '$lib/server/api/handler';
import { createApiKey, listApiKeys, revokeApiKey } from '$lib/server/api/keys';
import { API_RATE_LIMIT_PER_KEY, consumeRateLimit } from '$lib/server/api/rate-limit';
import { apiKeys, auditEvents, organizations, roles, users } from '$lib/server/db/schema';
import { getRedis } from '$lib/server/redis';
import {
	insertOrganization,
	insertUser,
	startTestDatabase,
	testActor,
	TEST_USER_IDS,
	type TestDatabase
} from '../helpers/db';

// См. комментарий в `helpers/db.ts`: без этого сервисы пойдут в базу разработчика.
vi.mock('$env/dynamic/private', () => ({ env: process.env }));

/**
 * Обработчик маршрута типизирован своим маршрутом, а поддельное событие — общим
 * типом события. Подпись сужается один раз здесь: иначе приведение пришлось бы
 * таскать в каждый вызов.
 */
type Endpoint = (event: RequestEvent) => Response | Promise<Response>;

const listOrganizations = (await import('../../../src/routes/api/v1/organizations/+server'))
	.GET as Endpoint;
const getOrganization = (await import('../../../src/routes/api/v1/organizations/[id]/+server'))
	.GET as Endpoint;
const transitions = (
	await import('../../../src/routes/api/v1/interactions/[id]/transitions/+server')
).POST as Endpoint;
const applications = (await import('../../../src/routes/api/v1/applications/+server'))
	.POST as Endpoint;
const groupResults = (
	await import('../../../src/routes/api/v1/exchange/learning-groups/results/+server')
).POST as Endpoint;
const exchangeFile = (await import('../../../src/routes/api/v1/exchange/files/[...key]/+server'))
	.GET as Endpoint;
const openApiDocument = (await import('../../../src/routes/api/openapi.json/+server'))
	.GET as Endpoint;
const docsPage = (await import('../../../src/routes/api/docs/+server')).GET as Endpoint;
const docsAsset = (await import('../../../src/routes/api/docs/[...path]/+server')).GET as Endpoint;

let database: TestDatabase;

beforeAll(async () => {
	database = await startTestDatabase();
}, 300_000);

afterAll(async () => {
	await getRedis().quit();
	await database?.stop();
});

beforeEach(async () => {
	// `reset()` стирает и Redis: счётчики лимита и пачек живут окно в целую
	// минуту, и без этого тест видел бы то, что насчитал предыдущий.
	await database.reset();
});

type EventOptions = {
	method?: string;
	path?: string;
	query?: Record<string, string>;
	headers?: Record<string, string>;
	body?: string;
	params?: Record<string, string>;
	routeId?: string;
	ip?: string;
	user?: SessionUser | null;
};

/**
 * Событие запроса в том виде, в каком его собирает SvelteKit. Обработчик берёт
 * из него адрес, заголовки, параметры пути и `locals`, поэтому остальное в
 * подделке не участвует: полный `RequestEvent` проверял бы фикстуру, а не код.
 */
function apiEvent(options: EventOptions = {}): RequestEvent {
	const url = new URL(`http://localhost${options.path ?? '/api/v1/organizations'}`);
	for (const [name, value] of Object.entries(options.query ?? {})) {
		url.searchParams.set(name, value);
	}

	const request = new Request(url, {
		method: options.method ?? 'GET',
		headers: options.headers,
		body: options.body
	});

	return {
		request,
		url,
		params: options.params ?? {},
		route: { id: options.routeId ?? '/api/v1/organizations' },
		locals: {
			requestId: crypto.randomUUID(),
			user: options.user ?? null,
			apiKey: null
		},
		getClientAddress: () => options.ip ?? `198.51.100.${Math.ceil(Math.random() * 250)}`,
		setHeaders: () => {},
		isDataRequest: false,
		isSubRequest: false
	} as unknown as RequestEvent;
}

function bearer(key: string, extra: Record<string, string> = {}): Record<string, string> {
	return { authorization: `Bearer ${key}`, ...extra };
}

async function issueKey(roleId = 'admin'): Promise<{ id: string; key: string }> {
	const ownerUserId = TEST_USER_IDS[roleId] ?? TEST_USER_IDS.admin;
	const created = await createApiKey(testActor(), { name: `Ключ ${roleId}`, ownerUserId });

	return { id: created.id, key: created.key };
}

/** Роль без единого права: ключ её владельца проходит вход, но не действие. */
async function issueKeyWithoutPermissions(): Promise<string> {
	await database.db
		.insert(roles)
		.values({ id: 'restricted', name: 'Без прав', description: 'Только для проверки отказа' });

	const ownerUserId = await insertUser(database.db, { roleId: 'restricted' });
	const created = await createApiKey(testActor(), { name: 'Ключ без прав', ownerUserId });

	return created.key;
}

type AuditRecord = { outcome: string; details: Record<string, unknown>; apiKeyId: string | null };

async function recordsOfType(eventType: AuditEventType): Promise<AuditRecord[]> {
	const rows = await database.db
		.select({
			outcome: auditEvents.outcome,
			details: auditEvents.details,
			apiKeyId: auditEvents.apiKeyId
		})
		.from(auditEvents)
		.where(eq(auditEvents.eventType, eventType));

	return rows.map((row) => ({ ...row, details: row.details as Record<string, unknown> }));
}

/** Построчные записи об обращениях к API. */
async function auditRecords(): Promise<AuditRecord[]> {
	return recordsOfType('api.request');
}

/** Агрегированные записи об отказах тем, кто не представился. */
async function unauthenticatedRecords(): Promise<AuditRecord[]> {
	return recordsOfType('api.unauthenticated_burst');
}

async function body(response: Response): Promise<Record<string, never>> {
	return (await response.json()) as Record<string, never>;
}

describe('вход по ключу', () => {
	it('не пускает без заголовка Authorization и пишет отказ в журнал', async () => {
		const response = await listOrganizations(apiEvent({ ip: '198.51.100.71' }));

		expect(response.status).toBe(401);
		expect(await body(response)).toMatchObject({ error: { code: 'unauthorized' } });

		// Обращением такой запрос не считается: до сервиса он не дошёл, и пишется
		// он агрегированно — см. «пачка запросов без ключа».
		expect(await auditRecords()).toEqual([]);
		expect(await unauthenticatedRecords()).toEqual([
			{
				outcome: 'denied',
				apiKeyId: null,
				details: { route: '/api/v1/organizations', method: 'GET', status: 401 }
			}
		]);
	});

	it('на пачку запросов без ключа пишет одну запись в минуту на адрес', async () => {
		// Минута прибита: окно ограничителя календарное, и пачка, начатая в
		// 10:59:59, легла бы в журнал двумя записями по совершенно верной причине.
		vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-09-12T10:00:00Z') });

		try {
			for (let index = 0; index < 25; index += 1) {
				const response = await listOrganizations(apiEvent({ ip: '198.51.100.72' }));

				expect(response.status).toBe(401);
			}

			// Перебор ключей не должен вытеснять из ленты то, что в системе
			// действительно происходило: 25 запросов — одна строка.
			expect(await unauthenticatedRecords()).toHaveLength(1);
			expect(await auditRecords()).toEqual([]);

			// Счётчик на адрес, а не общий: пачка с одного адреса не глушит запись
			// о другом — иначе за шумом перебора спрятался бы соседний перебор.
			await listOrganizations(apiEvent({ ip: '198.51.100.73' }));

			expect(await unauthenticatedRecords()).toHaveLength(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it('не пускает по сессии браузера: у API есть только ключ', async () => {
		const session: SessionUser = {
			id: TEST_USER_IDS.admin,
			email: 'admin@example.org',
			fullName: 'Тестовый Администратор',
			roleId: 'admin',
			permissions: new Set(['organizations.read']),
			isDemo: false,
			scope: { kind: 'all' }
		};

		const response = await listOrganizations(
			apiEvent({ user: session, headers: { cookie: 'session=whatever' } })
		);

		expect(response.status).toBe(401);
	});

	it('не пускает отозванный ключ', async () => {
		const issued = await issueKey();
		await revokeApiKey(testActor(), issued.id);

		const response = await listOrganizations(apiEvent({ headers: bearer(issued.key) }));

		expect(response.status).toBe(401);
		expect(await body(response)).toMatchObject({ error: { code: 'unauthorized' } });
	});

	it('не пускает ключ, которого нет, и мусор вместо ключа', async () => {
		for (const key of ['lct_00000000000000000000000000000000', 'not-a-key']) {
			const response = await listOrganizations(apiEvent({ headers: bearer(key) }));

			expect(response.status).toBe(401);
		}
	});

	it('не пускает ключ деактивированного владельца', async () => {
		const issued = await issueKey();
		await database.db
			.update(users)
			.set({ isActive: false })
			.where(eq(users.id, TEST_USER_IDS.admin));

		const response = await listOrganizations(apiEvent({ headers: bearer(issued.key) }));

		expect(response.status).toBe(401);
	});

	it('отказывает без права и записывает отказ вместе с ключом', async () => {
		const key = await issueKeyWithoutPermissions();

		const response = await listOrganizations(apiEvent({ headers: bearer(key) }));

		expect(response.status).toBe(403);
		expect(await body(response)).toMatchObject({ error: { code: 'forbidden' } });

		const denied = (await auditRecords()).filter((row) => row.outcome === 'denied');
		expect(denied).toHaveLength(1);
		expect(denied[0].apiKeyId).not.toBeNull();
		expect(denied[0].details).toMatchObject({ status: 403 });
	});

	it('пускает действующий ключ, отмечает использование и пишет успех', async () => {
		const issued = await issueKey();

		const response = await listOrganizations(apiEvent({ headers: bearer(issued.key) }));

		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('no-store');

		const [row] = await database.db
			.select({ lastUsedAt: apiKeys.lastUsedAt })
			.from(apiKeys)
			.where(eq(apiKeys.id, issued.id));
		expect(row.lastUsedAt).not.toBeNull();

		expect(await auditRecords()).toMatchObject([
			{ outcome: 'success', apiKeyId: issued.id, details: { status: 200 } }
		]);
	});

	it('хранит только хеш ключа', async () => {
		const issued = await issueKey();

		const [row] = await database.db
			.select({ keyHash: apiKeys.keyHash })
			.from(apiKeys)
			.where(eq(apiKeys.id, issued.id));

		expect(row.keyHash).not.toContain(issued.key);
		expect(row.keyHash).toMatch(/^[0-9a-f]{64}$/);
	});
});

describe('список организаций', () => {
	it('отдаёт страницу целиком описанной', async () => {
		await insertOrganization(database.db, { shortName: 'Альфа' });
		await insertOrganization(database.db, { shortName: 'Бета' });
		await insertOrganization(database.db, { shortName: 'Гамма' });

		const issued = await issueKey();

		const first = await listOrganizations(
			apiEvent({ headers: bearer(issued.key), query: { pageSize: '2' } })
		);
		const firstPage = await body(first);

		expect(first.status).toBe(200);
		expect(firstPage).toMatchObject({ total: 3, page: 1, pageSize: 2 });
		expect(
			(firstPage.items as unknown as { shortName: string }[]).map((item) => item.shortName)
		).toEqual(['Альфа', 'Бета']);

		const second = await listOrganizations(
			apiEvent({ headers: bearer(issued.key), query: { pageSize: '2', page: '2' } })
		);

		expect((await body(second)).items).toHaveLength(1);
	});

	it('отдаёт моменты времени строками, а не объектами', async () => {
		await insertOrganization(database.db, { shortName: 'Альфа' });
		const issued = await issueKey();

		const response = await listOrganizations(apiEvent({ headers: bearer(issued.key) }));
		const [organization] = (await body(response)).items as unknown as { createdAt: string }[];

		expect(organization.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
	});

	it('сужает выборку фильтром и поиском', async () => {
		await insertOrganization(database.db, { shortName: 'Альфа' });
		await insertOrganization(database.db, { shortName: 'Бета' });
		const issued = await issueKey();

		const found = await listOrganizations(
			apiEvent({ headers: bearer(issued.key), query: { q: 'Бет' } })
		);

		expect((await body(found)).total).toBe(1);

		const wrongKind = await listOrganizations(
			apiEvent({ headers: bearer(issued.key), query: { kind: 'operator' } })
		);

		expect((await body(wrongKind)).total).toBe(0);
	});

	it('перечисляет поля, из-за которых запрос не прошёл', async () => {
		const issued = await issueKey();

		const response = await listOrganizations(
			apiEvent({ headers: bearer(issued.key), query: { page: '0', kind: 'галактика' } })
		);

		expect(response.status).toBe(400);

		const failure = await body(response);
		expect(failure).toMatchObject({ error: { code: 'validation' } });

		const issues = (failure.error as unknown as { details: { issues: string[] } }).details.issues;
		expect(issues.some((issue) => issue.startsWith('query.page:'))).toBe(true);
		expect(issues.some((issue) => issue.startsWith('query.kind:'))).toBe(true);
	});
});

describe('организация по идентификатору', () => {
	const routeId = '/api/v1/organizations/[id]';

	it('отдаёт карточку', async () => {
		const organizationId = await insertOrganization(database.db, { shortName: 'Альфа' });
		const issued = await issueKey();

		const response = await getOrganization(
			apiEvent({ headers: bearer(issued.key), params: { id: organizationId }, routeId })
		);

		expect(response.status).toBe(200);
		expect(await body(response)).toMatchObject({ id: organizationId, shortName: 'Альфа' });
	});

	it('отвечает 404 на неизвестный идентификатор и 400 на негодный', async () => {
		const issued = await issueKey();

		const missing = await getOrganization(
			apiEvent({
				headers: bearer(issued.key),
				params: { id: '00000000-0000-4000-8000-0000000000ff' },
				routeId
			})
		);
		expect(missing.status).toBe(404);
		expect(await body(missing)).toMatchObject({ error: { code: 'not_found' } });

		const malformed = await getOrganization(
			apiEvent({ headers: bearer(issued.key), params: { id: 'не-uuid' }, routeId })
		);
		expect(malformed.status).toBe(400);
	});
});

describe('лимит частоты', () => {
	it('сообщает остаток окна на обычном ответе', async () => {
		const issued = await issueKey();

		const response = await listOrganizations(apiEvent({ headers: bearer(issued.key) }));

		expect(response.headers.get('RateLimit-Limit')).toBe(String(API_RATE_LIMIT_PER_KEY));
		expect(response.headers.get('RateLimit-Remaining')).toBe(String(API_RATE_LIMIT_PER_KEY - 1));
		expect(Number(response.headers.get('RateLimit-Reset'))).toBeGreaterThan(0);
	});

	it('отказывает после исчерпания лимита ключа', async () => {
		const issued = await issueKey();

		for (let index = 0; index < API_RATE_LIMIT_PER_KEY; index += 1) {
			await consumeRateLimit(`key:${issued.id}`, API_RATE_LIMIT_PER_KEY);
		}

		const response = await listOrganizations(apiEvent({ headers: bearer(issued.key) }));

		expect(response.status).toBe(429);
		expect(await body(response)).toMatchObject({ error: { code: 'rate_limited' } });
		expect(response.headers.get('RateLimit-Remaining')).toBe('0');
		expect(Number(response.headers.get('Retry-After'))).toBeGreaterThan(0);

		const denied = (await auditRecords()).filter((row) => row.outcome === 'denied');
		expect(denied).toMatchObject([{ details: { status: 429 } }]);
	});

	it('сводит наплыв без ключа в одну запись, чем бы он ни кончился', async () => {
		const ip = '198.51.100.99';

		// Перебор с одного адреса выбирает сперва лимит адреса (600 запросов), и
		// после него тот же самый наплыв перестаёт получать 401 и начинает
		// получать 429. Обе части — про одного безымянного вызывающего, и в
		// журнале им место в одной агрегированной строке: построчная запись
		// вытеснила бы из ленты всё, что в системе действительно происходило.
		for (let attempt = 0; attempt < 700; attempt += 1) {
			await listOrganizations(apiEvent({ ip }));
		}

		// Две — это стык минут: окно фиксированное, и наплыв мог начаться в конце
		// одной минуты и кончиться в начале следующей.
		const records = await unauthenticatedRecords();
		expect(records.length).toBeGreaterThanOrEqual(1);
		expect(records.length).toBeLessThanOrEqual(2);
		expect(records.every((row) => row.outcome === 'denied')).toBe(true);

		// Построчных записей об этом наплыве нет ни одной.
		expect(await auditRecords()).toEqual([]);
	});

	it('отказ по лимиту самого ключа агрегации не подлежит', async () => {
		const issued = await issueKey();

		for (let index = 0; index < API_RATE_LIMIT_PER_KEY; index += 1) {
			await consumeRateLimit(`key:${issued.id}`, API_RATE_LIMIT_PER_KEY);
		}

		await listOrganizations(apiEvent({ headers: bearer(issued.key) }));

		// За таким отказом стоит известный владелец: это строка про него, а не
		// про наплыв с адреса.
		expect(await unauthenticatedRecords()).toEqual([]);
		expect(await auditRecords()).toMatchObject([
			{ outcome: 'denied', details: { status: 429 }, apiKeyId: issued.id }
		]);
	});
});

describe('идемпотентность', () => {
	const probeConfig = {
		auth: 'key',
		body: z.object({ note: z.string() }),
		output: z.object({ note: z.string(), runs: z.number() }),
		idempotent: true
	} satisfies ApiEndpointConfig;

	function probe(): { handler: ReturnType<typeof apiHandler>; runs: () => number } {
		let runs = 0;

		const handler = apiHandler(probeConfig, (_ctx, { body: input }) => {
			runs += 1;
			return Promise.resolve({ note: input.note, runs });
		});

		return { handler, runs: () => runs };
	}

	function post(key: string, note: string, idempotencyKey?: string): RequestEvent {
		return apiEvent({
			method: 'POST',
			path: '/api/v1/probe',
			routeId: '/api/v1/probe',
			headers: bearer(key, {
				'content-type': 'application/json',
				...(idempotencyKey === undefined ? {} : { 'idempotency-key': idempotencyKey })
			}),
			body: JSON.stringify({ note })
		});
	}

	it('повторяет ответ на тот же ключ и то же тело, не выполняя работу дважды', async () => {
		const issued = await issueKey();
		const { handler, runs } = probe();

		const first = await handler(post(issued.key, 'первый', 'idem-1'));
		const second = await handler(post(issued.key, 'первый', 'idem-1'));

		expect(await body(first)).toEqual({ note: 'первый', runs: 1 });
		expect(await body(second)).toEqual({ note: 'первый', runs: 1 });
		expect(second.headers.get('Idempotency-Replay')).toBe('true');
		expect(runs()).toBe(1);
	});

	it('отказывает, если под тем же ключом приехало другое тело', async () => {
		const issued = await issueKey();
		const { handler, runs } = probe();

		await handler(post(issued.key, 'первый', 'idem-2'));
		const conflicting = await handler(post(issued.key, 'другой', 'idem-2'));

		expect(conflicting.status).toBe(422);
		expect(await body(conflicting)).toMatchObject({ error: { code: 'idempotency_mismatch' } });
		expect(runs()).toBe(1);
	});

	it('без заголовка выполняет каждый запрос', async () => {
		const issued = await issueKey();
		const { handler, runs } = probe();

		await handler(post(issued.key, 'первый'));
		await handler(post(issued.key, 'первый'));

		expect(runs()).toBe(2);
	});

	it('не путает ключи идемпотентности разных ключей доступа', async () => {
		const mine = await issueKey();
		const other = await issueKey('manager');
		const { handler, runs } = probe();

		await handler(post(mine.key, 'первый', 'idem-3'));
		await handler(post(other.key, 'первый', 'idem-3'));

		expect(runs()).toBe(2);
	});
});

describe('описание API', () => {
	it('собирается из зарегистрированных маршрутов и объявляет ключ доступа', async () => {
		const response = await openApiDocument(apiEvent({ path: '/api/openapi.json' }));
		const document = await body(response);

		expect(response.status).toBe(200);
		expect(document.openapi).toBe('3.1.0');

		const paths = document.paths as unknown as Record<string, Record<string, unknown>>;
		expect(Object.keys(paths).sort()).toEqual([
			'/v1/applications',
			'/v1/exchange/files/{key}',
			'/v1/exchange/learning-groups/results',
			'/v1/interactions',
			'/v1/interactions/{id}',
			'/v1/interactions/{id}/transitions',
			'/v1/organizations',
			'/v1/organizations/{id}'
		]);
		expect(paths['/v1/organizations'].get).toMatchObject({ security: [{ bearerAuth: [] }] });

		const components = document.components as unknown as {
			securitySchemes: Record<string, unknown>;
			schemas: Record<string, unknown>;
		};
		expect(components.securitySchemes.bearerAuth).toMatchObject({ type: 'http', scheme: 'bearer' });
		expect(components.schemas.Error).toBeDefined();
	});
});

describe('страница документации', () => {
	const reader: SessionUser = {
		id: TEST_USER_IDS.manager,
		email: 'manager@example.org',
		fullName: 'Тестовый Менеджер',
		roleId: 'manager',
		permissions: new Set(),
		isDemo: false,
		scope: { kind: 'all' }
	};

	it('закрыта от тех, кто не вошёл в систему', async () => {
		// Перенаправление в SvelteKit — это исключение, а обработчик страницы
		// синхронный, поэтому оно не превращается в отклонённое обещание.
		let redirected: unknown;
		try {
			docsPage(apiEvent({ path: '/api/docs', routeId: '/api/docs' }));
		} catch (error) {
			redirected = error;
		}
		expect(redirected).toMatchObject({ status: 303, location: '/login?next=%2Fapi%2Fdocs' });

		const asset = await docsAsset(
			apiEvent({
				path: '/api/docs/swagger-ui-bundle.js',
				routeId: '/api/docs/[...path]',
				params: { path: 'swagger-ui-bundle.js' }
			})
		);
		expect(asset.status).toBe(401);
	});

	it('отдаёт страницу вошедшему пользователю и не зовёт наружу', async () => {
		const response = await docsPage(
			apiEvent({ path: '/api/docs', routeId: '/api/docs', user: reader })
		);
		const html = await response.text();

		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
		expect(html).toContain('/api/docs/swagger-ui-bundle.js');
		expect(html).not.toMatch(/https?:\/\//);
		expect(response.headers.get('content-security-policy')).toContain("script-src 'self'");
	});

	it('отдаёт файлы интерфейса локально', async () => {
		const script = await docsAsset(
			apiEvent({
				path: '/api/docs/swagger-ui-bundle.js',
				routeId: '/api/docs/[...path]',
				params: { path: 'swagger-ui-bundle.js' },
				user: reader
			})
		);

		expect(script.status).toBe(200);
		expect(script.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
		expect((await script.text()).length).toBeGreaterThan(100_000);

		const initializer = await docsAsset(
			apiEvent({
				path: '/api/docs/initializer.js',
				routeId: '/api/docs/[...path]',
				params: { path: 'initializer.js' },
				user: reader
			})
		);

		expect(await initializer.text()).toContain("url: '/api/openapi.json'");
	});

	it('не отдаёт ничего, кроме перечисленных файлов', async () => {
		for (const path of ['package.json', '../../../.env', 'swagger-ui-bundle.js.map']) {
			await expect(
				docsAsset(
					apiEvent({
						path: `/api/docs/${path}`,
						routeId: '/api/docs/[...path]',
						params: { path },
						user: reader
					})
				)
			).rejects.toMatchObject({ status: 404 });
		}
	});
});

describe('ключи доступа', () => {
	it('не выпускает ключ на деактивированного владельца', async () => {
		const ownerUserId = await insertUser(database.db, { roleId: 'manager' });
		await database.db.update(users).set({ isActive: false }).where(eq(users.id, ownerUserId));

		await expect(createApiKey(testActor(), { name: 'Ключ', ownerUserId })).rejects.toMatchObject({
			code: 'validation'
		});
	});

	it('не даёт выпустить и отозвать ключ без права', async () => {
		const manager = testActor({ roleId: 'manager' });

		await expect(
			createApiKey(manager, { name: 'Ключ', ownerUserId: TEST_USER_IDS.manager })
		).rejects.toMatchObject({ code: 'forbidden' });

		const issued = await issueKey();
		await expect(revokeApiKey(manager, issued.id)).rejects.toMatchObject({ code: 'forbidden' });
	});

	it('пишет в журнал отказ выпустить, отозвать и прочитать ключи', async () => {
		const manager = testActor({ roleId: 'manager' });
		const issued = await issueKey();

		await expect(
			createApiKey(manager, { name: 'Ключ', ownerUserId: TEST_USER_IDS.manager })
		).rejects.toMatchObject({ code: 'forbidden' });
		await expect(revokeApiKey(manager, issued.id)).rejects.toMatchObject({ code: 'forbidden' });
		await expect(listApiKeys(manager)).rejects.toMatchObject({ code: 'forbidden' });

		const denied = await database.db
			.select({
				eventType: auditEvents.eventType,
				subjectId: auditEvents.subjectId,
				actorUserId: auditEvents.actorUserId
			})
			.from(auditEvents)
			.where(eq(auditEvents.outcome, 'denied'));

		// Попытка выпустить ключ на себя, отозвать чужой и пересчитать все —
		// три разных намерения, и в журнале они тремя строками и стоят.
		expect(denied).toEqual([
			{
				eventType: 'api_keys.created',
				subjectId: null,
				actorUserId: TEST_USER_IDS.manager
			},
			{
				eventType: 'api_keys.revoked',
				subjectId: issued.id,
				actorUserId: TEST_USER_IDS.manager
			},
			{ eventType: 'api_keys.viewed', subjectId: null, actorUserId: TEST_USER_IDS.manager }
		]);

		// Ключ при этом остался действующим: отказ ничего не изменил.
		expect(await listApiKeys(testActor())).toMatchObject([{ id: issued.id, revokedAt: null }]);
	});

	it('не отзывает ключ дважды', async () => {
		const issued = await issueKey();

		await revokeApiKey(testActor(), issued.id);
		await expect(revokeApiKey(testActor(), issued.id)).rejects.toMatchObject({
			code: 'not_found'
		});
	});

	it('оставляет след выпуска и отзыва в журнале', async () => {
		const issued = await issueKey();
		await revokeApiKey(testActor(), issued.id);

		const rows = await database.db
			.select({ eventType: auditEvents.eventType, subjectId: auditEvents.subjectId })
			.from(auditEvents)
			.where(eq(auditEvents.subjectType, 'api_key'));

		expect(rows).toEqual([
			{ eventType: 'api_keys.created', subjectId: issued.id },
			{ eventType: 'api_keys.revoked', subjectId: issued.id }
		]);
	});
});

describe('область доступа владельца ключа', () => {
	it('доходит до выборки через контекст запроса', async () => {
		const visible = await insertOrganization(database.db, { shortName: 'Альфа' });
		await insertOrganization(database.db, { shortName: 'Бета' });

		const issued = await issueKey();
		const response = await listOrganizations(apiEvent({ headers: bearer(issued.key) }));

		// Область владельца ключа сейчас «все организации», поэтому видно обе; сам
		// же путь проверяется тем, что выборка вообще применяет область — это
		// `scopeFilter` в `directory/read.ts`, у которого свой тест.
		expect((await body(response)).total).toBe(2);

		const [row] = await database.db
			.select({ id: organizations.id })
			.from(organizations)
			.where(eq(organizations.id, visible));
		expect(row.id).toBe(visible);
	});
});

describe('ключ машинного субъекта', () => {
	/** Эндпоинт обмена: сюда ключу роли `service` дорога открыта. */
	const exchangeConfig = {
		auth: 'key',
		service: true,
		permission: 'exchange.intake',
		output: z.object({ accepted: z.boolean() })
	} satisfies ApiEndpointConfig;

	const exchange = apiHandler(exchangeConfig, () => Promise.resolve({ accepted: true }));

	/**
	 * Тот же эндпоинт без признака обмена. Право у него то же самое, поэтому
	 * отказ здесь может дать только граница машинного субъекта — и ничто другое.
	 */
	const notExchange = apiHandler({ ...exchangeConfig, service: false }, () =>
		Promise.resolve({ accepted: true })
	);

	function get(key: string, path: string): RequestEvent {
		return apiEvent({ path, routeId: path, headers: bearer(key) });
	}

	it('пускает ключ обмена на маршрут обмена', async () => {
		const issued = await issueKey('service');

		const response = await exchange(get(issued.key, '/api/v1/exchange/probe'));

		expect(response.status).toBe(200);
	});

	it('не пускает ключ обмена на маршрут без признака обмена, даже когда право совпало', async () => {
		const issued = await issueKey('service');

		// Область у машинного субъекта `all`: попади он на обычный маршрут — и
		// увидел бы записи всего продукта. Поэтому правило обратное обычному:
		// без признака `service` на маршруте ключ получает 403 — и получает его
		// раньше проверки права, которое здесь у него как раз есть.
		const response = await notExchange(get(issued.key, '/api/v1/probe'));

		expect(response.status).toBe(403);
		expect(await response.json()).toMatchObject({
			error: { message: 'Ключ внешней системы работает только на эндпоинтах обмена' }
		});
	});

	it('не отдаёт ключу обмена список вузов', async () => {
		const issued = await issueKey('service');

		const listing = await listOrganizations(get(issued.key, '/api/v1/organizations'));

		expect(listing.status).toBe(403);
	});

	it('не двигает стадии: подтвердить стадию и вести процесс — разные полномочия', async () => {
		const issued = await issueKey('service');
		const organizationId = await insertOrganization(database.db, { shortName: 'Вуз обмена' });

		const response = await transitions(
			apiEvent({
				method: 'POST',
				path: `/api/v1/interactions/${organizationId}/transitions`,
				routeId: '/api/v1/interactions/[id]/transitions',
				params: { id: organizationId },
				headers: bearer(issued.key, { 'content-type': 'application/json' }),
				body: JSON.stringify({ kind: 'forward' })
			})
		);

		// Именно 403 и именно до всякой предметной проверки: у ключа обмена нет
		// ни права `stages.transition`, ни доступа к этому маршруту вовсе.
		expect(response.status).toBe(403);
	});

	it('оставляет обычные маршруты людям', async () => {
		const issued = await issueKey('admin');

		const listing = await listOrganizations(get(issued.key, '/api/v1/organizations'));

		expect(listing.status).toBe(200);
	});

	it('проходит границу на настоящих маршрутах обмена', async () => {
		const issued = await issueKey('service');

		// Тело намеренно пустое: проверяется не приём заявки — у него свой файл, —
		// а то, что ключ роли `service` вообще пускают на эти маршруты. Отказ
		// границы даёт 403 до всякого разбора тела, а разбор тела даёт 400.
		const application = await applications(
			apiEvent({
				method: 'POST',
				path: '/api/v1/applications',
				routeId: '/api/v1/applications',
				headers: bearer(issued.key, { 'content-type': 'application/json' }),
				body: '{}'
			})
		);

		expect(application.status).toBe(400);

		const result = await groupResults(
			apiEvent({
				method: 'POST',
				path: '/api/v1/exchange/learning-groups/results',
				routeId: '/api/v1/exchange/learning-groups/results',
				headers: bearer(issued.key, { 'content-type': 'application/json' }),
				body: '{}'
			})
		);

		expect(result.status).toBe(400);
	});

	it('не находит чужое вложение обмена: перебор ключей ничего не рассказывает', async () => {
		const issued = await issueKey('service');

		const response = await exchangeFile(
			apiEvent({
				path: '/api/v1/exchange/files/files/00000000-0000-4000-8000-000000000000',
				routeId: '/api/v1/exchange/files/[...key]',
				params: { key: 'files/00000000-0000-4000-8000-000000000000' },
				headers: bearer(issued.key)
			})
		);

		expect(response.status).toBe(404);
	});
});
