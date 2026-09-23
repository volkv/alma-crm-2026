import type { RequestHandler } from './$types';
import { apiPageSchema, apiProductSchema } from '$lib/contracts/api';
import { catalogListQuerySchema, createProductSchema } from '$lib/contracts/directory';
import { apiHandler, type ApiEndpointConfig } from '$lib/server/api/handler';
import { registerRoute } from '$lib/server/api/openapi';
import { listProducts } from '$lib/server/directory/read';
import { createProduct } from '$lib/server/directory/write';

const listProductsEndpoint = {
	auth: 'key',
	query: catalogListQuerySchema,
	output: apiPageSchema(apiProductSchema),
	permission: 'products.read'
} satisfies ApiEndpointConfig;

const createProductEndpoint = {
	auth: 'key',
	body: createProductSchema,
	output: apiProductSchema,
	permission: 'products.write',
	// Повтор после разрыва связи должен вернуть созданный продукт, а не
	// конфликт по собственному же коду.
	idempotent: true
} satisfies ApiEndpointConfig;

registerRoute({
	method: 'get',
	path: '/v1/products',
	summary: 'Список продуктов',
	description:
		'Страница каталога продуктов с фильтром по состоянию и поиском по названию и коду. ' +
		'Каталог общий, областью доступа владельца ключа он не сужается.',
	tags: ['Справочники'],
	config: listProductsEndpoint,
	example: {
		items: [
			{
				id: '7b2c9a41-3d4e-4f50-9a1b-2c3d4e5f6a7b',
				code: 'PRD-CLOUD',
				name: 'Облачная платформа',
				vendorOrganizationId: '2f1c9a0e-6b3d-4a77-8f21-0c5e9d4b7a10',
				description: 'Учебные стенды и лицензии для кафедры',
				status: 'active'
			}
		],
		total: 1,
		page: 1,
		pageSize: 20
	}
});

registerRoute({
	method: 'post',
	path: '/v1/products',
	summary: 'Завести продукт',
	description:
		'Продукт попадает в общий каталог оператора. Код уникален: занятый отвечает 409. ' +
		'Вендор — организация справочника; несуществующий отвечает 400. Без явного `status` ' +
		'продукт заводится черновиком (`draft`).',
	tags: ['Справочники'],
	config: createProductEndpoint,
	bodyExample: {
		code: 'PRD-CLOUD',
		name: 'Облачная платформа',
		vendorOrganizationId: '2f1c9a0e-6b3d-4a77-8f21-0c5e9d4b7a10',
		description: 'Учебные стенды и лицензии для кафедры',
		status: 'active'
	},
	example: {
		id: '7b2c9a41-3d4e-4f50-9a1b-2c3d4e5f6a7b',
		code: 'PRD-CLOUD',
		name: 'Облачная платформа',
		vendorOrganizationId: '2f1c9a0e-6b3d-4a77-8f21-0c5e9d4b7a10',
		description: 'Учебные стенды и лицензии для кафедры',
		status: 'active'
	}
});

export const GET: RequestHandler = apiHandler(listProductsEndpoint, (ctx, { query }) =>
	listProducts(ctx, query)
);

export const POST: RequestHandler = apiHandler(createProductEndpoint, (ctx, { body }) =>
	createProduct(ctx, body)
);
