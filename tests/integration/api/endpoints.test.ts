/**
 * Эндпоинты чтения и обмена целиком: ключ, право, область доступа владельца
 * ключа и схема ответа. Обработчики зовутся так же, как их зовёт SvelteKit,
 * поэтому проверяется и обёртка, и наш код — в том числе то, что ответ сходится
 * со своей схемой: разошедшийся с ней ответ наружу не уходит вовсе.
 *
 * Контракт описания — описание, тег, право и пример каждого маршрута — проверяет
 * `tests/unit/api/routes.test.ts`: базы ему не нужно, а спрашивать об этом надо
 * на каждом прогоне.
 */
import type { RequestEvent } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { moscowDay } from '$lib/contracts/calendar';
import { saveContractSchema } from '$lib/contracts/directory';
import { createInteractionSchema } from '$lib/contracts/interactions';
import { createApiKey } from '$lib/server/api/keys';
import {
	comments,
	directions,
	documents,
	exchangeMessages,
	learningGroups,
	products,
	programs,
	roles
} from '$lib/server/db/schema';
import { saveContract, saveContractItem } from '$lib/server/directory/contracts';
import { createInteraction } from '$lib/server/interactions/write';
import { getRedis } from '$lib/server/redis';
import { B2B_WORKSPACE_KEY, B2B_PROCESS } from '$lib/server/stages/definitions';
import { ensureWorkflow } from '$lib/server/stages/process';
import {
	insertDocument,
	insertOrganization,
	insertUser,
	scopedActor,
	startTestDatabase,
	testActor,
	TEST_USER_IDS,
	type TestDatabase
} from '../helpers/db';

// См. комментарий в `helpers/db.ts`: без этого сервисы пойдут в базу разработчика.
vi.mock('$env/dynamic/private', () => ({ env: process.env }));

type Endpoint = (event: RequestEvent) => Response | Promise<Response>;

const listPrograms = (await import('../../../src/routes/api/v1/programs/+server')).GET as Endpoint;
const listProducts = (await import('../../../src/routes/api/v1/products/+server')).GET as Endpoint;
const listDirections = (await import('../../../src/routes/api/v1/directions/+server'))
	.GET as Endpoint;
const listContracts = (await import('../../../src/routes/api/v1/contracts/+server'))
	.GET as Endpoint;
const organizationInteractions = (
	await import('../../../src/routes/api/v1/organizations/[id]/interactions/+server')
).GET as Endpoint;
const interactionHistory = (
	await import('../../../src/routes/api/v1/interactions/[id]/history/+server')
).GET as Endpoint;
const interactionDocuments = (
	await import('../../../src/routes/api/v1/interactions/[id]/documents/+server')
).GET as Endpoint;
const interactionLearningGroups = (
	await import('../../../src/routes/api/v1/interactions/[id]/learning-groups/+server')
).GET as Endpoint;
const commentsModule =
	await import('../../../src/routes/api/v1/interactions/[id]/comments/+server');
const listComments = commentsModule.GET as Endpoint;
const createComment = commentsModule.POST as Endpoint;
const markDocumentRoute = (await import('../../../src/routes/api/v1/documents/[id]/marks/+server'))
	.POST as Endpoint;
const listWorkspaces = (await import('../../../src/routes/api/v1/workspaces/+server'))
	.GET as Endpoint;
const getProcess = (await import('../../../src/routes/api/v1/workspaces/[key]/+server'))
	.GET as Endpoint;
const report = (await import('../../../src/routes/api/v1/reports/+server')).GET as Endpoint;
const exchangeJournal = (await import('../../../src/routes/api/v1/exchange/messages/+server'))
	.GET as Endpoint;

let database: TestDatabase;

beforeAll(async () => {
	database = await startTestDatabase();
}, 300_000);

afterAll(async () => {
	await getRedis().quit();
	await database?.stop();
});

beforeEach(async () => {
	await database.reset();
});

type EventOptions = {
	method?: string;
	path: string;
	routeId: string;
	query?: Record<string, string>;
	headers?: Record<string, string>;
	body?: string;
	params?: Record<string, string>;
};

/**
 * Событие запроса в том виде, в каком его собирает SvelteKit: обработчик берёт
 * из него адрес, заголовки и параметры пути, поэтому остальное в подделке не
 * участвует.
 */
function apiEvent(options: EventOptions): RequestEvent {
	const url = new URL(`http://localhost${options.path}`);

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
		route: { id: options.routeId },
		locals: { requestId: crypto.randomUUID(), user: null, apiKey: null },
		getClientAddress: () => `198.51.100.${Math.ceil(Math.random() * 250)}`,
		setHeaders: () => {},
		isDataRequest: false,
		isSubRequest: false
	} as unknown as RequestEvent;
}

function bearer(key: string, extra: Record<string, string> = {}): Record<string, string> {
	return { authorization: `Bearer ${key}`, ...extra };
}

async function body(response: Response): Promise<Record<string, unknown>> {
	return (await response.json()) as Record<string, unknown>;
}

async function issueKey(ownerUserId: string): Promise<string> {
	const created = await createApiKey(testActor(), {
		name: 'Ключ проверки',
		ownerUserId,
		exchangeSystem: null
	});

	return created.key;
}

/** Роль без единого права: ключ её владельца проходит вход, но не действие. */
async function issueKeyWithoutPermissions(): Promise<string> {
	await database.db
		.insert(roles)
		.values({ id: 'restricted', name: 'Без прав', description: 'Только для проверки отказа' });

	const ownerUserId = await insertUser(database.db, { roleId: 'restricted' });

	return issueKey(ownerUserId);
}

/** Менеджер, за которым закреплён названный вуз: ключ на него сужен его областью. */
async function responsibleUserId(organizationId: string): Promise<string> {
	const userId = await insertUser(database.db, {
		roleId: 'manager',
		email: `responsible-${crypto.randomUUID()}@example.org`
	});

	await scopedActor(database.db, { roleId: 'manager', userId, organizationIds: [organizationId] });

	return userId;
}

/** Менеджер без единого закреплённого вуза: его область пуста. */
async function outsiderUserId(): Promise<string> {
	return insertUser(database.db, {
		roleId: 'manager',
		email: `outsider-${crypto.randomUUID()}@example.org`
	});
}

type Fixture = {
	organizationId: string;
	interactionId: string;
	/** Документ дела: на нём проверяются отметки и их область доступа. */
	documentId: string;
};

/** Вуз, взаимодействие на действующем процессе и справочники вокруг них. */
async function seed(title = 'Взаимодействие для API'): Promise<Fixture> {
	const ctx = testActor();
	await database.db.transaction((tx) => ensureWorkflow(tx, B2B_WORKSPACE_KEY, B2B_PROCESS));

	const organizationId = await insertOrganization(database.db, {
		shortName: `Вуз ${crypto.randomUUID().slice(0, 8)}`
	});

	const interaction = await createInteraction(
		ctx,
		B2B_WORKSPACE_KEY,
		createInteractionSchema.parse({
			title,
			ownerUserId: TEST_USER_IDS.admin,
			parties: [{ organizationId, partyRole: 'educational_institution', isPrimary: true }]
		})
	);

	const documentId = await insertDocument(database.db, {
		interactionId: interaction.id,
		title: 'Соглашение о сотрудничестве'
	});

	return { organizationId, interactionId: interaction.id, documentId };
}

/**
 * Обращение к каждому новому эндпоинту одним и тем же способом: так проверки
 * «без ключа» и «без права» перечисляют маршруты, а не повторяют по тесту на
 * каждый.
 */
function calls(
	fixture: Fixture
): { name: string; call: (headers?: Record<string, string>) => Promise<Response> }[] {
	const interactionParams = { id: fixture.interactionId };

	return [
		{
			name: 'GET /v1/programs',
			call: (headers) =>
				Promise.resolve(
					listPrograms(apiEvent({ path: '/api/v1/programs', routeId: '/api/v1/programs', headers }))
				)
		},
		{
			name: 'GET /v1/products',
			call: (headers) =>
				Promise.resolve(
					listProducts(apiEvent({ path: '/api/v1/products', routeId: '/api/v1/products', headers }))
				)
		},
		{
			name: 'GET /v1/directions',
			call: (headers) =>
				Promise.resolve(
					listDirections(
						apiEvent({ path: '/api/v1/directions', routeId: '/api/v1/directions', headers })
					)
				)
		},
		{
			name: 'GET /v1/contracts',
			call: (headers) =>
				Promise.resolve(
					listContracts(
						apiEvent({ path: '/api/v1/contracts', routeId: '/api/v1/contracts', headers })
					)
				)
		},
		{
			name: 'GET /v1/organizations/{id}/interactions',
			call: (headers) =>
				Promise.resolve(
					organizationInteractions(
						apiEvent({
							path: `/api/v1/organizations/${fixture.organizationId}/interactions`,
							routeId: '/api/v1/organizations/[id]/interactions',
							params: { id: fixture.organizationId },
							headers
						})
					)
				)
		},
		{
			name: 'GET /v1/interactions/{id}/history',
			call: (headers) =>
				Promise.resolve(
					interactionHistory(
						apiEvent({
							path: `/api/v1/interactions/${fixture.interactionId}/history`,
							routeId: '/api/v1/interactions/[id]/history',
							params: interactionParams,
							headers
						})
					)
				)
		},
		{
			name: 'GET /v1/interactions/{id}/documents',
			call: (headers) =>
				Promise.resolve(
					interactionDocuments(
						apiEvent({
							path: `/api/v1/interactions/${fixture.interactionId}/documents`,
							routeId: '/api/v1/interactions/[id]/documents',
							params: interactionParams,
							headers
						})
					)
				)
		},
		{
			name: 'GET /v1/interactions/{id}/learning-groups',
			call: (headers) =>
				Promise.resolve(
					interactionLearningGroups(
						apiEvent({
							path: `/api/v1/interactions/${fixture.interactionId}/learning-groups`,
							routeId: '/api/v1/interactions/[id]/learning-groups',
							params: interactionParams,
							headers
						})
					)
				)
		},
		{
			name: 'GET /v1/interactions/{id}/comments',
			call: (headers) =>
				Promise.resolve(
					listComments(
						apiEvent({
							path: `/api/v1/interactions/${fixture.interactionId}/comments`,
							routeId: '/api/v1/interactions/[id]/comments',
							params: interactionParams,
							headers
						})
					)
				)
		},
		{
			name: 'POST /v1/interactions/{id}/comments',
			call: (headers) =>
				Promise.resolve(
					createComment(
						apiEvent({
							method: 'POST',
							path: `/api/v1/interactions/${fixture.interactionId}/comments`,
							routeId: '/api/v1/interactions/[id]/comments',
							params: interactionParams,
							headers: { 'content-type': 'application/json', ...headers },
							body: JSON.stringify({ body: 'Комментарий из интеграции' })
						})
					)
				)
		},
		{
			name: 'POST /v1/documents/{id}/marks',
			call: (headers) =>
				Promise.resolve(
					markDocumentRoute(
						apiEvent({
							method: 'POST',
							path: `/api/v1/documents/${fixture.documentId}/marks`,
							routeId: '/api/v1/documents/[id]/marks',
							params: { id: fixture.documentId },
							headers: { 'content-type': 'application/json', ...headers },
							body: JSON.stringify({ fact: 'agreed' })
						})
					)
				)
		},
		{
			name: 'GET /v1/workspaces',
			call: (headers) =>
				Promise.resolve(
					listWorkspaces(
						apiEvent({ path: '/api/v1/workspaces', routeId: '/api/v1/workspaces', headers })
					)
				)
		},
		{
			name: 'GET /v1/workspaces/{key}',
			call: (headers) =>
				Promise.resolve(
					getProcess(
						apiEvent({
							path: `/api/v1/workspaces/${B2B_WORKSPACE_KEY}`,
							routeId: '/api/v1/workspaces/[key]',
							params: { key: B2B_WORKSPACE_KEY },
							headers
						})
					)
				)
		},
		{
			name: 'GET /v1/reports',
			call: (headers) =>
				Promise.resolve(
					report(
						apiEvent({
							path: '/api/v1/reports',
							routeId: '/api/v1/reports',
							query: { from: '2026-01-01', to: '2026-12-31' },
							headers
						})
					)
				)
		},
		{
			name: 'GET /v1/exchange/messages',
			call: (headers) =>
				Promise.resolve(
					exchangeJournal(
						apiEvent({
							path: '/api/v1/exchange/messages',
							routeId: '/api/v1/exchange/messages',
							headers
						})
					)
				)
		}
	];
}

describe('справочники', () => {
	it('отдаёт страницу программ', async () => {
		await database.db
			.insert(programs)
			.values({ code: 'PRG-1', name: 'Программа', level: 'bachelor', status: 'active' });
		const key = await issueKey(TEST_USER_IDS.admin);

		const response = await listPrograms(
			apiEvent({ path: '/api/v1/programs', routeId: '/api/v1/programs', headers: bearer(key) })
		);

		expect(response.status).toBe(200);
		expect(await body(response)).toMatchObject({
			items: [{ code: 'PRG-1', name: 'Программа', level: 'bachelor', status: 'active' }],
			total: 1,
			page: 1,
			pageSize: 20
		});
	});

	it('сужает каталог программ фильтром состояния', async () => {
		await database.db.insert(programs).values([
			{ code: 'PRG-1', name: 'Действующая', level: 'bachelor', status: 'active' },
			{ code: 'PRG-2', name: 'В архиве', level: 'bachelor', status: 'archived' }
		]);
		const key = await issueKey(TEST_USER_IDS.admin);

		const response = await listPrograms(
			apiEvent({
				path: '/api/v1/programs',
				routeId: '/api/v1/programs',
				query: { status: 'archived' },
				headers: bearer(key)
			})
		);

		expect(await body(response)).toMatchObject({ total: 1, items: [{ code: 'PRG-2' }] });
	});

	it('отдаёт страницу продуктов', async () => {
		await database.db.insert(products).values({ code: 'PRD-1', name: 'Продукт', status: 'active' });
		const key = await issueKey(TEST_USER_IDS.admin);

		const response = await listProducts(
			apiEvent({ path: '/api/v1/products', routeId: '/api/v1/products', headers: bearer(key) })
		);

		expect(response.status).toBe(200);
		expect(await body(response)).toMatchObject({
			items: [{ code: 'PRD-1', name: 'Продукт', vendorOrganizationId: null }],
			total: 1
		});
	});

	it('отдаёт договоры с позициями и сужает их областью доступа владельца ключа', async () => {
		const mine = await seed('Моя работа');
		const foreign = await seed('Чужая работа');
		const [product] = await database.db
			.insert(products)
			.values({ code: 'PRD-CTR', name: 'Продукт договора', status: 'active' })
			.returning({ id: products.id });

		const own = await saveContract(
			testActor(),
			saveContractSchema.parse({
				organizationId: mine.organizationId,
				number: 'ДОГ-1',
				signedOn: '2026-03-01',
				status: 'active'
			})
		);
		await saveContractItem(testActor(), {
			id: null,
			contractId: own.id,
			productId: product.id,
			licenseSignedAt: null,
			licenseUntil: '2027-03-01',
			transferStatus: 'передан вузу'
		});
		await saveContract(
			testActor(),
			saveContractSchema.parse({
				organizationId: foreign.organizationId,
				number: 'ДОГ-2',
				status: 'draft'
			})
		);

		// Ключ администратора видит оба договора: его область — всё.
		const wide = await listContracts(
			apiEvent({
				path: '/api/v1/contracts',
				routeId: '/api/v1/contracts',
				headers: bearer(await issueKey(TEST_USER_IDS.admin))
			})
		);

		expect(wide.status).toBe(200);
		expect(await body(wide)).toMatchObject({ total: 2 });

		// Ключ менеджера, за которым закреплён один вуз, — только его договор, и
		// позиции едут вместе с ним: по ним интегратор и сверяет условия.
		const narrow = await listContracts(
			apiEvent({
				path: '/api/v1/contracts',
				routeId: '/api/v1/contracts',
				headers: bearer(await issueKey(await responsibleUserId(mine.organizationId)))
			})
		);

		expect(await body(narrow)).toMatchObject({
			total: 1,
			items: [
				{
					number: 'ДОГ-1',
					status: 'active',
					items: [{ productCode: 'PRD-CTR', transferStatus: 'передан вузу' }]
				}
			]
		});
	});

	it('отдаёт направления целиком, без страниц', async () => {
		await database.db.insert(directions).values({ code: 'devops', name: 'DevOps', position: 100 });
		const key = await issueKey(TEST_USER_IDS.admin);

		const response = await listDirections(
			apiEvent({ path: '/api/v1/directions', routeId: '/api/v1/directions', headers: bearer(key) })
		);
		const payload = await body(response);

		expect(response.status).toBe(200);
		expect(payload.total).toBe((payload.items as unknown[]).length);
		expect((payload.items as { name: string }[]).some((item) => item.name === 'DevOps')).toBe(true);
		expect(payload).not.toHaveProperty('page');
	});
});

describe('взаимодействия организации', () => {
	it('отдаёт взаимодействия, где организация — сторона', async () => {
		const fixture = await seed();
		await seed('Чужая работа');
		const key = await issueKey(TEST_USER_IDS.admin);

		const response = await organizationInteractions(
			apiEvent({
				path: `/api/v1/organizations/${fixture.organizationId}/interactions`,
				routeId: '/api/v1/organizations/[id]/interactions',
				params: { id: fixture.organizationId },
				headers: bearer(key)
			})
		);

		expect(response.status).toBe(200);
		expect(await body(response)).toMatchObject({
			total: 1,
			items: [{ id: fixture.interactionId, title: 'Взаимодействие для API' }]
		});
	});

	it('не даёт подменить организацию тем же фильтром в адресе', async () => {
		const fixture = await seed();
		const other = await seed('Чужая работа');
		const key = await issueKey(TEST_USER_IDS.admin);

		const response = await organizationInteractions(
			apiEvent({
				path: `/api/v1/organizations/${fixture.organizationId}/interactions`,
				routeId: '/api/v1/organizations/[id]/interactions',
				params: { id: fixture.organizationId },
				query: { organizationId: other.organizationId },
				headers: bearer(key)
			})
		);

		// Лишний параметр схема отбрасывает, организацию задаёт адрес.
		expect(await body(response)).toMatchObject({
			total: 1,
			items: [{ id: fixture.interactionId }]
		});
	});
});

describe('история взаимодействия', () => {
	it('отдаёт открытую стадию, ленту пройденных и изменения плана', async () => {
		const fixture = await seed();
		const key = await issueKey(TEST_USER_IDS.admin);

		const response = await interactionHistory(
			apiEvent({
				path: `/api/v1/interactions/${fixture.interactionId}/history`,
				routeId: '/api/v1/interactions/[id]/history',
				params: { id: fixture.interactionId },
				headers: bearer(key)
			})
		);
		const payload = await body(response);

		expect(response.status).toBe(200);
		expect(payload).toMatchObject({
			interactionId: fixture.interactionId,
			processRevision: 1,
			stages: [],
			changes: []
		});
		expect(payload.current).toMatchObject({ stageKey: B2B_PROCESS.stages[0].key });
		// Моменты времени уезжают строками, а не объектами `Date`.
		expect((payload.current as { enteredAt: string }).enteredAt).toMatch(
			/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/
		);
	});

	it('отвечает 404 на чужой идентификатор', async () => {
		await seed();
		const key = await issueKey(TEST_USER_IDS.admin);

		const response = await interactionHistory(
			apiEvent({
				path: '/api/v1/interactions/00000000-0000-4000-8000-0000000000ff/history',
				routeId: '/api/v1/interactions/[id]/history',
				params: { id: '00000000-0000-4000-8000-0000000000ff' },
				headers: bearer(key)
			})
		);

		expect(response.status).toBe(404);
	});
});

describe('документы взаимодействия', () => {
	it('отдаёт метаданные и не отдаёт ни пути к файлу, ни отпечатка', async () => {
		// Документ у дела свой, из набора: второй такой же ничего не проверял бы.
		const fixture = await seed();
		const key = await issueKey(TEST_USER_IDS.admin);

		const response = await interactionDocuments(
			apiEvent({
				path: `/api/v1/interactions/${fixture.interactionId}/documents`,
				routeId: '/api/v1/interactions/[id]/documents',
				params: { id: fixture.interactionId },
				headers: bearer(key)
			})
		);
		const payload = await body(response);

		expect(response.status).toBe(200);
		expect(payload).toMatchObject({
			total: 1,
			items: [
				{
					title: 'Соглашение о сотрудничестве',
					mime: 'application/pdf',
					interactionId: fixture.interactionId
				}
			]
		});

		const [document] = payload.items as Record<string, unknown>[];
		expect(document).not.toHaveProperty('filePath');
		expect(document).not.toHaveProperty('sha256');
	});

	it('отвечает 404 на взаимодействие вне области доступа, а не пустой страницей', async () => {
		const fixture = await seed();
		const key = await issueKey(await outsiderUserId());

		const response = await interactionDocuments(
			apiEvent({
				path: `/api/v1/interactions/${fixture.interactionId}/documents`,
				routeId: '/api/v1/interactions/[id]/documents',
				params: { id: fixture.interactionId },
				headers: bearer(key)
			})
		);

		expect(response.status).toBe(404);
	});
});

describe('отметки по документу', () => {
	it('ставит отметку и отдаёт все три факта по документу', async () => {
		const fixture = await seed();
		const key = await issueKey(TEST_USER_IDS.admin);

		const response = await markDocumentRoute(
			apiEvent({
				method: 'POST',
				path: `/api/v1/documents/${fixture.documentId}/marks`,
				routeId: '/api/v1/documents/[id]/marks',
				params: { id: fixture.documentId },
				headers: bearer(key, { 'content-type': 'application/json' }),
				body: JSON.stringify({ fact: 'approved' })
			})
		);
		const payload = await body(response);

		expect(response.status).toBe(200);
		expect(payload).toMatchObject({
			id: fixture.documentId,
			interactionId: fixture.interactionId,
			agreedAt: null,
			inEffectAt: null
		});
		expect(payload.approvedAt).not.toBeNull();

		const [row] = await database.db
			.select()
			.from(documents)
			.where(eq(documents.id, fixture.documentId));

		expect(row.approvedBy).toBe(TEST_USER_IDS.admin);
	});

	it('ставит отметку задним числом и отказывает дню из будущего', async () => {
		const fixture = await seed();
		const key = await issueKey(TEST_USER_IDS.admin);
		// Документ «появился в системе» неделю назад: сегодняшней загрузке
		// датировать нечего.
		const createdAt = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

		await database.db
			.update(documents)
			.set({ createdAt })
			.where(eq(documents.id, fixture.documentId));

		const mark = (at: string): Promise<Response> =>
			Promise.resolve(
				markDocumentRoute(
					apiEvent({
						method: 'POST',
						path: `/api/v1/documents/${fixture.documentId}/marks`,
						routeId: '/api/v1/documents/[id]/marks',
						params: { id: fixture.documentId },
						headers: bearer(key, { 'content-type': 'application/json' }),
						body: JSON.stringify({ fact: 'agreed', at })
					})
				)
			);

		const backdated = moscowDay(createdAt);
		const accepted = await mark(backdated);

		expect(accepted.status).toBe(200);
		expect(moscowDay(new Date(String((await body(accepted)).agreedAt)))).toBe(backdated);

		const tomorrow = moscowDay(new Date(Date.now() + 24 * 60 * 60 * 1000));
		const rejected = await mark(tomorrow);

		expect(rejected.status).toBe(400);
	});

	it('не ставит вторую отметку на повтор с тем же ключом идемпотентности', async () => {
		const fixture = await seed();
		const key = await issueKey(TEST_USER_IDS.admin);

		const post = (): Promise<Response> =>
			Promise.resolve(
				markDocumentRoute(
					apiEvent({
						method: 'POST',
						path: `/api/v1/documents/${fixture.documentId}/marks`,
						routeId: '/api/v1/documents/[id]/marks',
						params: { id: fixture.documentId },
						headers: bearer(key, {
							'content-type': 'application/json',
							'idempotency-key': 'mark-1'
						}),
						body: JSON.stringify({ fact: 'agreed' })
					})
				)
			);

		const first = await post();
		const second = await post();

		// Без ключа идемпотентности повтор пришёл бы конфликтом: отметка
		// ставится один раз, и второй ответ не отличить от чужой отметки.
		expect(first.status).toBe(200);
		expect(second.headers.get('Idempotency-Replay')).toBe('true');
		expect(await body(second)).toEqual(await body(first));
	});

	it('отвечает 404 на документ вне области доступа и отметки не ставит', async () => {
		const fixture = await seed();
		const key = await issueKey(await outsiderUserId());

		const response = await markDocumentRoute(
			apiEvent({
				method: 'POST',
				path: `/api/v1/documents/${fixture.documentId}/marks`,
				routeId: '/api/v1/documents/[id]/marks',
				params: { id: fixture.documentId },
				headers: bearer(key, { 'content-type': 'application/json' }),
				body: JSON.stringify({ fact: 'agreed' })
			})
		);

		expect(response.status).toBe(404);

		const [row] = await database.db
			.select()
			.from(documents)
			.where(eq(documents.id, fixture.documentId));

		expect(row.agreedAt).toBeNull();
	});
});

describe('учебные группы взаимодействия', () => {
	it('отдаёт потоки взаимодействия с состоянием заявки', async () => {
		const fixture = await seed();
		await database.db.insert(learningGroups).values({
			interactionId: fixture.interactionId,
			streamNumber: 1,
			system: 'lms',
			instance: 'moodle-test',
			groupExternalId: 'LMS-1',
			plannedSeats: 30,
			startsOn: '2026-10-01',
			endsOn: '2026-12-20'
		});
		const key = await issueKey(TEST_USER_IDS.admin);

		const response = await interactionLearningGroups(
			apiEvent({
				path: `/api/v1/interactions/${fixture.interactionId}/learning-groups`,
				routeId: '/api/v1/interactions/[id]/learning-groups',
				params: { id: fixture.interactionId },
				headers: bearer(key)
			})
		);

		expect(response.status).toBe(200);
		expect(await body(response)).toMatchObject({
			total: 1,
			items: [
				{
					streamNumber: 1,
					system: 'lms',
					groupExternalId: 'LMS-1',
					startsOn: '2026-10-01',
					messageState: null,
					enrolled: null
				}
			]
		});
	});
});

describe('комментарии взаимодействия', () => {
	it('пишет комментарий от имени владельца ключа и отдаёт его лентой', async () => {
		const fixture = await seed();
		const key = await issueKey(TEST_USER_IDS.admin);

		const created = await createComment(
			apiEvent({
				method: 'POST',
				path: `/api/v1/interactions/${fixture.interactionId}/comments`,
				routeId: '/api/v1/interactions/[id]/comments',
				params: { id: fixture.interactionId },
				headers: bearer(key, { 'content-type': 'application/json' }),
				body: JSON.stringify({ body: 'Заявка продублирована письмом' })
			})
		);

		expect(created.status).toBe(200);

		const listed = await listComments(
			apiEvent({
				path: `/api/v1/interactions/${fixture.interactionId}/comments`,
				routeId: '/api/v1/interactions/[id]/comments',
				params: { id: fixture.interactionId },
				headers: bearer(key)
			})
		);

		expect(await body(listed)).toMatchObject({
			total: 1,
			items: [{ body: 'Заявка продублирована письмом', authorId: TEST_USER_IDS.admin }]
		});
	});

	it('не оставляет двух комментариев на повтор с тем же ключом идемпотентности', async () => {
		const fixture = await seed();
		const key = await issueKey(TEST_USER_IDS.admin);

		const post = (): Promise<Response> =>
			Promise.resolve(
				createComment(
					apiEvent({
						method: 'POST',
						path: `/api/v1/interactions/${fixture.interactionId}/comments`,
						routeId: '/api/v1/interactions/[id]/comments',
						params: { id: fixture.interactionId },
						headers: bearer(key, {
							'content-type': 'application/json',
							'idempotency-key': 'comment-1'
						}),
						body: JSON.stringify({ body: 'Один и тот же комментарий' })
					})
				)
			);

		const first = await post();
		const second = await post();

		expect(second.headers.get('Idempotency-Replay')).toBe('true');
		expect(await body(second)).toEqual(await body(first));

		const rows = await database.db
			.select({ id: comments.id })
			.from(comments)
			.where(eq(comments.interactionId, fixture.interactionId));
		expect(rows).toHaveLength(1);
	});

	it('не пишет комментарий в чужое взаимодействие', async () => {
		const fixture = await seed();
		const key = await issueKey(await outsiderUserId());

		const response = await createComment(
			apiEvent({
				method: 'POST',
				path: `/api/v1/interactions/${fixture.interactionId}/comments`,
				routeId: '/api/v1/interactions/[id]/comments',
				params: { id: fixture.interactionId },
				headers: bearer(key, { 'content-type': 'application/json' }),
				body: JSON.stringify({ body: 'Чужая запись' })
			})
		);

		expect(response.status).toBe(404);
		expect(
			await database.db
				.select({ id: comments.id })
				.from(comments)
				.where(eq(comments.interactionId, fixture.interactionId))
		).toEqual([]);
	});
});

describe('процесс', () => {
	it('отдаёт пространства и стадии действующей редакции с ключами', async () => {
		await seed();
		const key = await issueKey(TEST_USER_IDS.admin);

		const list = await listWorkspaces(
			apiEvent({
				path: '/api/v1/workspaces',
				routeId: '/api/v1/workspaces',
				headers: bearer(key)
			})
		);
		const listBody = await body(list);

		expect(list.status).toBe(200);
		expect(
			(listBody.items as { key: string }[]).some((item) => item.key === B2B_WORKSPACE_KEY)
		).toBe(true);

		const process = await getProcess(
			apiEvent({
				path: `/api/v1/workspaces/${B2B_WORKSPACE_KEY}`,
				routeId: '/api/v1/workspaces/[key]',
				params: { key: B2B_WORKSPACE_KEY },
				headers: bearer(key)
			})
		);
		const payload = await body(process);

		expect(process.status).toBe(200);
		expect(payload).toMatchObject({ workspace: { key: B2B_WORKSPACE_KEY } });

		const revision = payload.revision as {
			version: number;
			stages: { key: string; id: string }[];
			transitions: { fromStageId: string; toStageId: string }[];
		};
		expect(revision.version).toBe(1);
		expect(revision.stages.map((stage) => stage.key)).toEqual(
			B2B_PROCESS.stages.map((stage) => stage.key)
		);

		// Переходы ссылаются на стадии того же ответа: интегратор собирает команду
		// перехода, не спрашивая систему второй раз.
		const stageIds = new Set(revision.stages.map((stage) => stage.id));
		expect(revision.transitions.length).toBeGreaterThan(0);
		expect(
			revision.transitions.every(
				(transition) => stageIds.has(transition.fromStageId) && stageIds.has(transition.toStageId)
			)
		).toBe(true);
		// Черновик и его замечания наружу не уезжают.
		expect(payload).not.toHaveProperty('draft');
		expect(payload).not.toHaveProperty('issues');
	});

	it('не отдаёт устройство процесса тому, кто его не настраивает', async () => {
		await seed();
		const key = await issueKey(TEST_USER_IDS.manager);

		const response = await listWorkspaces(
			apiEvent({
				path: '/api/v1/workspaces',
				routeId: '/api/v1/workspaces',
				headers: bearer(key)
			})
		);

		expect(response.status).toBe(403);
	});

	it('отвечает 404 на неизвестный ключ группы', async () => {
		await seed();
		const key = await issueKey(TEST_USER_IDS.admin);

		const response = await getProcess(
			apiEvent({
				path: '/api/v1/workspaces/unknown',
				routeId: '/api/v1/workspaces/[key]',
				params: { key: 'unknown' },
				headers: bearer(key)
			})
		);

		expect(response.status).toBe(404);
	});
});

describe('отчёт', () => {
	const period = { from: '2026-01-01', to: '2026-12-31' };

	it('отдаёт срез тем же объектом, что и экран', async () => {
		const fixture = await seed();
		const key = await issueKey(TEST_USER_IDS.admin);

		const response = await report(
			apiEvent({
				path: '/api/v1/reports',
				routeId: '/api/v1/reports',
				query: period,
				headers: bearer(key)
			})
		);
		const payload = await body(response);

		expect(response.status).toBe(200);
		expect(payload).toMatchObject({
			meta: { mode: 'snapshot', schemaVersion: 1, period: { start: period.from, end: period.to } },
			totals: { rowCount: 1, interactionCount: 1 }
		});
		expect((payload.rows as { interactionId: string }[])[0].interactionId).toBe(
			fixture.interactionId
		);
		expect((payload.charts as { funnel: unknown }).funnel).not.toBeNull();
	});

	it('строит движение за период вместо среза', async () => {
		await seed();
		const key = await issueKey(TEST_USER_IDS.admin);

		const response = await report(
			apiEvent({
				path: '/api/v1/reports',
				routeId: '/api/v1/reports',
				query: { ...period, mode: 'movement' },
				headers: bearer(key)
			})
		);
		const payload = await body(response);

		expect(response.status).toBe(200);
		expect(payload).toMatchObject({ meta: { mode: 'movement' } });
		expect((payload.charts as { movement: unknown }).movement).not.toBeNull();
		expect((payload.charts as { funnel: unknown }).funnel).toBeNull();
	});

	it('не собирает отчёт без периода и с периодом задом наперёд', async () => {
		await seed();
		const key = await issueKey(TEST_USER_IDS.admin);

		const withoutPeriod = await report(
			apiEvent({ path: '/api/v1/reports', routeId: '/api/v1/reports', headers: bearer(key) })
		);
		expect(withoutPeriod.status).toBe(400);

		const reversed = await report(
			apiEvent({
				path: '/api/v1/reports',
				routeId: '/api/v1/reports',
				query: { from: '2026-12-31', to: '2026-01-01' },
				headers: bearer(key)
			})
		);
		expect(reversed.status).toBe(400);
		expect(await body(reversed)).toMatchObject({ error: { code: 'validation' } });
	});
});

describe('журнал обмена', () => {
	async function insertMessage(interactionId: string): Promise<void> {
		await database.db.insert(exchangeMessages).values({
			direction: 'outbound',
			system: 'lms',
			instance: 'moodle-test',
			eventType: 'learning_group.requested',
			eventId: crypto.randomUUID(),
			externalId: `${interactionId}:1`,
			interactionId,
			state: 'sent',
			payload: {}
		});
	}

	it('отдаёт страницу журнала с фильтрами', async () => {
		const fixture = await seed();
		await insertMessage(fixture.interactionId);
		const key = await issueKey(TEST_USER_IDS.admin);

		const response = await exchangeJournal(
			apiEvent({
				path: '/api/v1/exchange/messages',
				routeId: '/api/v1/exchange/messages',
				headers: bearer(key)
			})
		);

		expect(response.status).toBe(200);
		expect(await body(response)).toMatchObject({
			total: 1,
			items: [{ direction: 'outbound', system: 'lms', state: 'sent' }]
		});

		const filtered = await exchangeJournal(
			apiEvent({
				path: '/api/v1/exchange/messages',
				routeId: '/api/v1/exchange/messages',
				query: { direction: 'inbound' },
				headers: bearer(key)
			})
		);

		expect(await body(filtered)).toMatchObject({ total: 0 });
	});

	it('не отдаёт журнал тому, кто не настраивает интеграции', async () => {
		const fixture = await seed();
		await insertMessage(fixture.interactionId);
		const key = await issueKey(TEST_USER_IDS.manager);

		const response = await exchangeJournal(
			apiEvent({
				path: '/api/v1/exchange/messages',
				routeId: '/api/v1/exchange/messages',
				headers: bearer(key)
			})
		);

		expect(response.status).toBe(403);
	});
});

describe('ключ на входе каждого эндпоинта', () => {
	it('без заголовка Authorization не пускает никуда', async () => {
		const fixture = await seed();

		for (const endpoint of calls(fixture)) {
			const response = await endpoint.call();

			expect(response.status, endpoint.name).toBe(401);
			expect(await body(response), endpoint.name).toMatchObject({
				error: { code: 'unauthorized' }
			});
		}
	});

	it('без права отказывает на каждом эндпоинте', async () => {
		const fixture = await seed();
		const key = await issueKeyWithoutPermissions();

		for (const endpoint of calls(fixture)) {
			const response = await endpoint.call(bearer(key));

			expect(response.status, endpoint.name).toBe(403);
			expect(await body(response), endpoint.name).toMatchObject({ error: { code: 'forbidden' } });
		}
	});
});

describe('область доступа владельца ключа', () => {
	it('сужает выборку до того, что видит человек, на которого выпущен ключ', async () => {
		const mine = await seed('Моя работа');
		const foreign = await seed('Чужая работа');

		// Ключ выпущен на менеджера, за которым закреплён только один вуз:
		// область доступа ключа — это область его владельца, не шире.
		const key = await issueKey(await responsibleUserId(mine.organizationId));

		const visible = await organizationInteractions(
			apiEvent({
				path: `/api/v1/organizations/${mine.organizationId}/interactions`,
				routeId: '/api/v1/organizations/[id]/interactions',
				params: { id: mine.organizationId },
				headers: bearer(key)
			})
		);
		expect(await body(visible)).toMatchObject({ total: 1, items: [{ id: mine.interactionId }] });

		// Чужой вуз отвечает пустой страницей, а не отказом: по разнице между
		// «нет взаимодействий» и «нет доступа» перебором узнавали бы чужое.
		const hidden = await organizationInteractions(
			apiEvent({
				path: `/api/v1/organizations/${foreign.organizationId}/interactions`,
				routeId: '/api/v1/organizations/[id]/interactions',
				params: { id: foreign.organizationId },
				headers: bearer(key)
			})
		);
		expect(await body(hidden)).toMatchObject({ total: 0, items: [] });

		// А карточка чужой записи — 404, и по всем подресурсам одинаково.
		for (const [name, endpoint] of [
			['history', interactionHistory],
			['documents', interactionDocuments],
			['learning-groups', interactionLearningGroups],
			['comments', listComments]
		] as const) {
			const response = await endpoint(
				apiEvent({
					path: `/api/v1/interactions/${foreign.interactionId}/${name}`,
					routeId: `/api/v1/interactions/[id]/${name}`,
					params: { id: foreign.interactionId },
					headers: bearer(key)
				})
			);

			expect(response.status, name).toBe(404);
		}
	});

	it('оставляет в отчёте только то, что видит владелец ключа', async () => {
		const mine = await seed('Моя работа');
		await seed('Чужая работа');

		const narrow = await issueKey(await responsibleUserId(mine.organizationId));
		const wide = await issueKey(TEST_USER_IDS.admin);

		const query = { from: '2026-01-01', to: '2026-12-31' };

		const narrowReport = await report(
			apiEvent({
				path: '/api/v1/reports',
				routeId: '/api/v1/reports',
				query,
				headers: bearer(narrow)
			})
		);
		const wideReport = await report(
			apiEvent({
				path: '/api/v1/reports',
				routeId: '/api/v1/reports',
				query,
				headers: bearer(wide)
			})
		);

		const narrowBody = await body(narrowReport);
		const wideBody = await body(wideReport);

		expect(narrowBody).toMatchObject({ totals: { rowCount: 1 } });
		expect(wideBody).toMatchObject({
			totals: { rowCount: 2 },
			meta: { scope: 'все взаимодействия' }
		});
		// Область словами едет в самом отчёте: две выгрузки с разными числами
		// иначе выглядели бы как ошибка системы.
		expect((narrowBody.meta as { scope: string }).scope).toContain('сотрудник');
	});
});
