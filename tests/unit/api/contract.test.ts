import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
	API_ERROR_CODES,
	apiErrorSchema,
	apiOrganizationSchema,
	apiPageSchema,
	toApiOrganization
} from '$lib/contracts/api';
import type { OrganizationView } from '$lib/contracts/directory';

vi.mock('$lib/server/config', () => ({
	getConfig: () => ({ ORIGIN: 'https://crm.example.org' })
}));

const { organizationListQuerySchema } = await import('$lib/contracts/directory');
const { buildOpenApiDocument, registerRoute } = await import('$lib/server/api/openapi');

describe('конверт ошибки', () => {
	it('принимает ответ, который отдаёт обёртка', () => {
		const parsed = apiErrorSchema.parse({
			error: {
				code: 'validation',
				message: 'Запрос не прошёл проверку',
				requestId: '00000000-0000-4000-8000-00000000fee1',
				details: { issues: ['query.page: Номер страницы — целое число'] }
			}
		});

		expect(parsed.error.details).toEqual({
			issues: ['query.page: Номер страницы — целое число']
		});
	});

	it('обходится без подробностей', () => {
		expect(
			apiErrorSchema.parse({ error: { code: 'not_found', message: 'нет', requestId: 'r' } }).error
				.details
		).toBeUndefined();
	});

	it('не пропускает код вне словаря и ответ без идентификатора запроса', () => {
		expect(
			apiErrorSchema.safeParse({ error: { code: 'teapot', message: 'x', requestId: 'r' } }).success
		).toBe(false);
		expect(apiErrorSchema.safeParse({ error: { code: 'internal', message: 'x' } }).success).toBe(
			false
		);
	});

	it('описывает и предметные ошибки, и транспортные', () => {
		expect(API_ERROR_CODES).toContain('validation');
		expect(API_ERROR_CODES).toContain('forbidden');
		expect(API_ERROR_CODES).toContain('not_found');
		expect(API_ERROR_CODES).toContain('conflict');
		expect(API_ERROR_CODES).toContain('unauthorized');
		expect(API_ERROR_CODES).toContain('rate_limited');
		expect(API_ERROR_CODES).toContain('idempotency_mismatch');
		expect(API_ERROR_CODES).toContain('internal');
	});
});

describe('конверт страницы', () => {
	it('повторяет поля внутреннего постраничного результата', () => {
		const schema = apiPageSchema(z.string());

		expect(schema.parse({ items: ['a'], total: 1, page: 1, pageSize: 20 })).toEqual({
			items: ['a'],
			total: 1,
			page: 1,
			pageSize: 20
		});
		expect(schema.safeParse({ items: ['a'], total: 1, page: 0, pageSize: 20 }).success).toBe(false);
	});
});

describe('организация в ответе API', () => {
	const view: OrganizationView = {
		id: '11111111-2222-4333-8444-555555555555',
		kind: 'educational_institution',
		educationLevel: 'vo',
		legalName: 'Федеральное государственное учреждение',
		shortName: 'Вуз',
		inn: '7707083893',
		kpp: null,
		ogrn: null,
		region: 'Москва',
		website: null,
		notes: null,
		isActive: true,
		externalSource: null,
		externalId: null,
		createdAt: new Date('2026-09-12T10:00:00.000Z'),
		updatedAt: new Date('2026-09-12T11:30:00.000Z')
	};

	it('отдаёт моменты времени строками ISO 8601', () => {
		const organization = toApiOrganization(view);

		expect(organization.createdAt).toBe('2026-09-12T10:00:00.000Z');
		expect(organization.updatedAt).toBe('2026-09-12T11:30:00.000Z');
		expect(apiOrganizationSchema.parse(organization)).toEqual(organization);
	});

	it('не пропускает объект базы мимо перевода', () => {
		expect(apiOrganizationSchema.safeParse(view).success).toBe(false);
	});
});

describe('сборка документа OpenAPI', () => {
	registerRoute({
		method: 'get',
		path: '/v1/probe',
		summary: 'Проверочный маршрут',
		tags: ['Проверка'],
		config: {
			auth: 'key',
			params: z.object({ id: z.uuid() }),
			// Схема списка собрана из полей с `default` и `transform` — именно на них
			// генератор OpenAPI ломается, если его подключить неправильно.
			query: organizationListQuerySchema,
			body: z.object({ note: z.string() }),
			output: apiPageSchema(apiOrganizationSchema),
			permission: 'organizations.read',
			idempotent: true
		}
	});

	const document = buildOpenApiDocument();

	it('собирается в версии 3.1 с описанием сервера', () => {
		expect(document.openapi).toBe('3.1.0');
		expect(document.info.title).toBe('LCT CRM API');
		expect(document.servers?.[0]?.url).toBe('https://crm.example.org/api');
	});

	it('объявляет ключ доступа как единственный способ представиться', () => {
		expect(document.components?.securitySchemes?.bearerAuth).toMatchObject({
			type: 'http',
			scheme: 'bearer'
		});
		expect(document.security).toEqual([{ bearerAuth: [] }]);
	});

	it('описывает маршрут вместе с его ошибками', () => {
		const operation = document.paths?.['/v1/probe']?.get;

		expect(operation?.summary).toBe('Проверочный маршрут');
		expect(operation?.security).toEqual([{ bearerAuth: [] }]);
		expect(Object.keys(operation?.responses ?? {}).sort()).toEqual([
			'200',
			'400',
			'401',
			'403',
			'404',
			'409',
			'422',
			'429',
			'500'
		]);
		expect(operation?.responses?.['401'].content?.['application/json'].schema).toEqual({
			$ref: '#/components/schemas/Error'
		});
	});

	it('переносит параметры запроса и тело из схем', () => {
		const operation = document.paths?.['/v1/probe']?.get;
		const parameters = (operation?.parameters ?? []) as { name: string; in: string }[];

		expect(parameters.map((parameter) => `${parameter.in}:${parameter.name}`).sort()).toEqual([
			'path:id',
			'query:kind',
			'query:page',
			'query:pageSize',
			'query:q'
		]);
		expect(operation?.requestBody).toBeDefined();
	});

	it('не раздваивает маршрут при повторной регистрации', () => {
		registerRoute({
			method: 'get',
			path: '/v1/probe',
			summary: 'Он же ещё раз',
			config: { auth: 'key', output: z.object({}) }
		});

		expect(buildOpenApiDocument().paths?.['/v1/probe']?.get?.summary).toBe('Проверочный маршрут');
	});
});
