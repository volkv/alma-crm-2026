import type { RequestHandler } from './$types';
import { apiCollectionSchema, apiDirectionSchema } from '$lib/contracts/api';
import { apiHandler, type ApiEndpointConfig } from '$lib/server/api/handler';
import { registerRoute } from '$lib/server/api/openapi';
import { listDirectionOptions } from '$lib/server/directory/responsibles';

const listDirectionsEndpoint = {
	auth: 'key',
	output: apiCollectionSchema(apiDirectionSchema),
	permission: 'directions.read'
} satisfies ApiEndpointConfig;

registerRoute({
	method: 'get',
	path: '/v1/directions',
	summary: 'Список ИТ-направлений',
	description:
		'Направления целиком, в порядке, в котором их показывает интерфейс. Страницами справочник ' +
		'не режется: направлений десятки, и внешней системе нужен весь список, чтобы разобрать ' +
		'ссылки на них в отчётах и в назначениях ответственных.',
	tags: ['Справочники'],
	config: listDirectionsEndpoint,
	example: {
		items: [{ id: '0a1b2c3d-4e5f-4061-8a2b-3c4d5e6f7081', name: 'Кибербезопасность' }],
		total: 1
	}
});

export const GET: RequestHandler = apiHandler(listDirectionsEndpoint, async (ctx) => {
	const items = await listDirectionOptions(ctx);

	return { items, total: items.length };
});
