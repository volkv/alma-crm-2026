import type { RequestHandler } from './$types';
import { apiPageSchema, apiProductSchema } from '$lib/contracts/api';
import { catalogListQuerySchema } from '$lib/contracts/directory';
import { apiHandler, type ApiEndpointConfig } from '$lib/server/api/handler';
import { registerRoute } from '$lib/server/api/openapi';
import { listProducts } from '$lib/server/directory/read';

const listProductsEndpoint = {
	auth: 'key',
	query: catalogListQuerySchema,
	output: apiPageSchema(apiProductSchema),
	permission: 'products.read'
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

export const GET: RequestHandler = apiHandler(listProductsEndpoint, (ctx, { query }) =>
	listProducts(ctx, query)
);
