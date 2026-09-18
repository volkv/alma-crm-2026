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
	config: listInteractionsEndpoint,
	example: {
		items: [
			{
				id: 'a3f1c2d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
				title: 'Переговоры с СПбПУ',
				status: 'active',
				ownerUserId: '9c8b7a65-4321-4098-b7a6-5c4d3e2f1a09',
				ownerName: 'Иванова Мария',
				institutionName: 'СПбПУ',
				customerName: null,
				stageKey: 'document_exchange',
				stageName: 'Обмен пакетом документов',
				stagePosition: 4,
				stageCategory: 'documents',
				dueAt: '2026-10-01T09:00:00.000Z',
				isOverdue: false,
				isPaused: false,
				isStale: false,
				openBlockers: 0,
				lastActivityAt: '2026-09-18T12:30:00.000Z'
			}
		],
		total: 1,
		page: 1,
		pageSize: 20
	}
});

export const GET: RequestHandler = apiHandler(listInteractionsEndpoint, async (ctx, { query }) => {
	const result = await listInteractions(ctx, query);

	return { ...result, items: result.items.map(toApiInteraction) };
});
