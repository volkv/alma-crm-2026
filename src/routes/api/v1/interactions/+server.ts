import type { RequestHandler } from './$types';
import { apiPageSchema } from '$lib/contracts/api';
import {
	apiInteractionSchema,
	interactionListQuerySchema,
	toApiInteraction
} from '$lib/contracts/interactions';
import { apiHandler, type ApiEndpointConfig } from '$lib/server/api/handler';
import { registerRoute } from '$lib/server/api/openapi';
import { listInteractions } from '$lib/server/interactions/read';

const listInteractionsEndpoint = {
	auth: 'key',
	query: interactionListQuerySchema,
	output: apiPageSchema(apiInteractionSchema),
	permission: 'interactions.read'
} satisfies ApiEndpointConfig;

registerRoute({
	method: 'get',
	path: '/v1/interactions',
	summary: 'Список взаимодействий',
	description:
		'Страница списка с фильтрами по состоянию, ответственному, организации, смысловой группе ' +
		'текущей стадии и просрочке, плюс поиск по названию и наименованию организаций. ' +
		'Видны только те взаимодействия, чьи стороны входят в область доступа владельца ключа.',
	tags: ['Взаимодействия'],
	config: listInteractionsEndpoint
});

export const GET: RequestHandler = apiHandler(listInteractionsEndpoint, async (ctx, { query }) => {
	const result = await listInteractions(ctx, query);

	return { ...result, items: result.items.map(toApiInteraction) };
});
