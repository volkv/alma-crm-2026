/**
 * Основные сущности через публичный API: справочники, контакты, ответственные,
 * пространства и процессы. По одному сквозному случаю на ресурс — через те же
 * сервисы, что у экранов, — и отказ ключу без права.
 */
import type { RequestEvent } from '@sveltejs/kit';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiKey } from '$lib/server/api/keys';
import { getRedis } from '$lib/server/redis';
import { startTestDatabase, testActor, TEST_USER_IDS, type TestDatabase } from '../helpers/db';

// См. комментарий в `helpers/db.ts`: без этого сервисы пойдут в базу разработчика.
vi.mock('$env/dynamic/private', () => ({ env: process.env }));

type Endpoint = (event: RequestEvent) => Response | Promise<Response>;
type Module = Record<string, unknown>;

const organizations: Module = await import('../../../src/routes/api/v1/organizations/+server');
const organization: Module = await import('../../../src/routes/api/v1/organizations/[id]/+server');
const organizationContacts: Module =
	await import('../../../src/routes/api/v1/organizations/[id]/contacts/+server');
const responsibles: Module =
	await import('../../../src/routes/api/v1/organizations/[id]/responsibles/+server');
const people: Module = await import('../../../src/routes/api/v1/people/+server');
const contacts: Module = await import('../../../src/routes/api/v1/contacts/+server');
const programs: Module = await import('../../../src/routes/api/v1/programs/+server');
const program: Module = await import('../../../src/routes/api/v1/programs/[id]/+server');
const products: Module = await import('../../../src/routes/api/v1/products/+server');
const product: Module = await import('../../../src/routes/api/v1/products/[id]/+server');
const members: Module = await import('../../../src/routes/api/v1/workspaces/[key]/members/+server');
const workflows: Module = await import('../../../src/routes/api/v1/workflows/+server');
const workflow: Module = await import('../../../src/routes/api/v1/workflows/[key]/+server');
const publication: Module =
	await import('../../../src/routes/api/v1/workflows/[key]/publication/+server');

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

async function issueKey(roleId: 'admin' | 'manager'): Promise<string> {
	const created = await createApiKey(testActor(), {
		name: `Ключ ${roleId}`,
		ownerUserId: TEST_USER_IDS[roleId],
		exchangeSystem: null
	});

	return created.key;
}

type Call = {
	key: string;
	body?: unknown;
	params?: Record<string, string>;
	headers?: Record<string, string>;
};

/** Вызов обработчика так, как его вызывает SvelteKit: адрес, заголовки, параметры пути. */
async function call(
	module: Module,
	method: 'GET' | 'POST' | 'PUT',
	options: Call
): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
	const url = new URL('http://localhost/api/v1/test');
	const request = new Request(url, {
		method,
		headers: {
			authorization: `Bearer ${options.key}`,
			'content-type': 'application/json',
			...options.headers
		},
		body: options.body === undefined ? undefined : JSON.stringify(options.body)
	});
	const event = {
		request,
		url,
		params: options.params ?? {},
		route: { id: '/api/v1/test' },
		locals: { requestId: crypto.randomUUID(), user: null, apiKey: null },
		getClientAddress: () => '198.51.100.10',
		setHeaders: () => {},
		isDataRequest: false,
		isSubRequest: false
	} as unknown as RequestEvent;

	const response = await (module[method] as Endpoint)(event);

	return {
		status: response.status,
		body: (await response.json()) as Record<string, unknown>,
		headers: response.headers
	};
}

const university = {
	kind: 'educational_institution',
	educationLevel: 'vo',
	legalName: 'Федеральное государственное бюджетное образовательное учреждение',
	shortName: 'Политех',
	inn: '7707083893',
	region: 'Москва'
};

describe('справочники через API', () => {
	it('заводит организацию один раз на ключ идемпотентности и правит её', async () => {
		const key = await issueKey('admin');
		const headers = { 'idempotency-key': 'org-1' };

		const created = await call(organizations, 'POST', { key, body: university, headers });
		const replayed = await call(organizations, 'POST', { key, body: university, headers });

		expect(created.status).toBe(200);
		expect(replayed.headers.get('idempotency-replay')).toBe('true');
		expect(replayed.body.id).toBe(created.body.id);

		const id = String(created.body.id);
		const updated = await call(organization, 'PUT', {
			key,
			params: { id },
			body: { ...university, region: 'Санкт-Петербург' }
		});

		expect(updated.status).toBe(200);
		expect(updated.body).toMatchObject({ id, region: 'Санкт-Петербург', isActive: true });
	});

	it('заводит программу и продукт и отдаёт их карточки', async () => {
		const key = await issueKey('admin');

		const createdProgram = await call(programs, 'POST', {
			key,
			body: { code: 'PRG-1', name: 'Программа', level: 'bachelor', priority: 3 }
		});
		expect(createdProgram.status).toBe(200);

		const readProgram = await call(program, 'GET', {
			key,
			params: { id: String(createdProgram.body.id) }
		});
		expect(readProgram.body).toMatchObject({ code: 'PRG-1', priority: 3, versions: [] });

		const createdProduct = await call(products, 'POST', {
			key,
			body: { code: 'PRD-1', name: 'Продукт' }
		});
		expect(createdProduct.status).toBe(200);

		const renamed = await call(product, 'PUT', {
			key,
			params: { id: String(createdProduct.body.id) },
			body: { code: 'PRD-1', name: 'Продукт 2', status: 'active' }
		});
		expect(renamed.body).toMatchObject({ name: 'Продукт 2', status: 'active' });

		const readProduct = await call(product, 'GET', {
			key,
			params: { id: String(createdProduct.body.id) }
		});
		expect(readProduct.body).toMatchObject({ name: 'Продукт 2', vendorName: null });
	});

	it('заводит человека, его роль в вузе и отдаёт контакты карточки', async () => {
		const key = await issueKey('admin');
		const org = await call(organizations, 'POST', { key, body: university });
		const organizationId = String(org.body.id);

		const person = await call(people, 'POST', {
			key,
			body: { lastName: 'Петров', firstName: 'Сергей', email: 'petrov@example.edu' }
		});
		expect(person.status).toBe(200);

		const contact = await call(contacts, 'POST', {
			key,
			body: {
				personId: person.body.id,
				organizationId,
				position: 'Проректор',
				roleKind: 'vice_rector',
				validFrom: '2026-01-01'
			}
		});
		expect(contact.status).toBe(200);

		const listed = await call(organizationContacts, 'GET', {
			key,
			params: { id: organizationId }
		});

		expect(listed.body.total).toBe(1);
		expect(listed.body.items).toMatchObject([
			{
				position: 'Проректор',
				person: { lastName: 'Петров', email: 'petrov@example.edu', contactsMasked: false }
			}
		]);

		const found = await call(people, 'GET', { key });
		expect(found.body.items).toMatchObject([
			{ lastName: 'Петров', organizations: [{ id: organizationId, shortName: 'Политех' }] }
		]);
	});

	it('назначает ответственного вместо автора карточки', async () => {
		const key = await issueKey('admin');
		const org = await call(organizations, 'POST', { key, body: university });
		const id = String(org.body.id);

		const assigned = await call(responsibles, 'POST', {
			key,
			params: { id },
			body: { userId: TEST_USER_IDS.lead }
		});

		expect(assigned.status).toBe(200);
		// Автор стал ответственным при заведении, новое назначение его закрыло.
		const current = (assigned.body.items as { userId: string; validTo: string | null }[]).filter(
			(row) => row.validTo === null
		);
		expect(current.map((row) => row.userId)).toEqual([TEST_USER_IDS.lead]);
		expect(assigned.body.total).toBe(2);
	});
});

describe('пространства и процессы через API', () => {
	it('отдаёт состав пространства, процессы и отказывает в публикации без черновика', async () => {
		const key = await issueKey('admin');

		const composition = await call(members, 'GET', { key, params: { key: 'b2b' } });
		expect(composition.status).toBe(200);
		expect(
			(composition.body.members as { userId: string }[]).map((member) => member.userId)
		).toContain(TEST_USER_IDS.manager);

		const list = await call(workflows, 'GET', { key });
		const items = list.body.items as { key: string; hasDraft: boolean }[];
		expect(items.length).toBeGreaterThan(0);

		const detail = await call(workflow, 'GET', { key, params: { key: items[0].key } });
		expect(detail.status).toBe(200);
		expect(detail.body).toMatchObject({ workflow: { key: items[0].key }, draft: null });

		const published = await call(publication, 'POST', { key, params: { key: items[0].key } });
		expect(published.status).toBe(404);
	});
});

describe('права ключа', () => {
	it('не даёт менеджеру то, чего не даёт его роль', async () => {
		const key = await issueKey('manager');

		const product = await call(products, 'POST', { key, body: { code: 'X', name: 'X' } });
		const processes = await call(workflows, 'GET', { key });
		const composition = await call(members, 'GET', { key, params: { key: 'b2b' } });

		expect([product.status, processes.status, composition.status]).toEqual([403, 403, 403]);
		expect(product.body).toMatchObject({ error: { code: 'forbidden' } });
	});
});
