import type { RequestHandler } from './$types';
import { apiCollectionSchema, apiWorkflowSchema } from '$lib/contracts/api';
import { apiHandler, type ApiEndpointConfig } from '$lib/server/api/handler';
import { registerRoute } from '$lib/server/api/openapi';
import { listWorkflows } from '$lib/server/stages/process';

const listWorkflowsEndpoint = {
	auth: 'key',
	output: apiCollectionSchema(apiWorkflowSchema),
	permission: 'stages.configure'
} satisfies ApiEndpointConfig;

registerRoute({
	method: 'get',
	path: '/v1/workflows',
	summary: 'Процессы',
	description:
		'Описания работы, которые назначают пространствам: одно описание может обслуживать ' +
		'несколько мест. У каждого — число стадий действующей редакции, число пространств и ' +
		'незавершённых взаимодействий во всех них и признак неопубликованного черновика.',
	tags: ['Процесс'],
	config: listWorkflowsEndpoint,
	example: {
		items: [
			{
				id: 'e0f1a2b3-c4d5-4e6f-8a7b-8c9d0e1f2a3b',
				key: 'university',
				name: 'Работа с вузом',
				description: 'Путь от поиска контакта до отчёта по обучению',
				stageCount: 7,
				workspaces: 1,
				activeInteractions: 12,
				hasDraft: true
			}
		],
		total: 1
	}
});

export const GET: RequestHandler = apiHandler(listWorkflowsEndpoint, async (ctx) => {
	const items = await listWorkflows(ctx);

	return { items, total: items.length };
});
