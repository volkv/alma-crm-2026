import type { RequestHandler } from './$types';
import { apiCollectionSchema, apiProcessGroupSchema } from '$lib/contracts/api';
import { apiHandler, type ApiEndpointConfig } from '$lib/server/api/handler';
import { registerRoute } from '$lib/server/api/openapi';
import { listProcessGroups } from '$lib/server/stages/process';

const listProcessGroupsEndpoint = {
	auth: 'key',
	output: apiCollectionSchema(apiProcessGroupSchema),
	permission: 'stages.configure'
} satisfies ApiEndpointConfig;

registerRoute({
	method: 'get',
	path: '/v1/process-groups',
	summary: 'Группы процесса',
	description:
		'Маршруты, по которым идут взаимодействия: учебные заведения (`b2b`), лица (`b2c`) и всё, ' +
		'что заведено сверх них. У каждой группы — число стадий действующей редакции и число ' +
		'незавершённых взаимодействий на ней.\n\n' +
		'Право `stages.configure` здесь не случайно: устройство процесса — это настройка системы, ' +
		'а не рабочие данные. Стадии действующей редакции отдаёт `GET /v1/process-groups/{key}`.',
	tags: ['Процесс'],
	config: listProcessGroupsEndpoint,
	example: {
		items: [
			{
				id: 'b7c8d9e0-f1a2-4b3c-8d4e-5f6a7b8c9d0e',
				key: 'b2b',
				name: 'Учебные заведения',
				description: 'Работа с вузами и колледжами',
				position: 1,
				stageCount: 7,
				activeInteractions: 12,
				hasDraft: false
			}
		],
		total: 1
	}
});

export const GET: RequestHandler = apiHandler(listProcessGroupsEndpoint, async (ctx) => {
	const items = await listProcessGroups(ctx);

	return { items, total: items.length };
});
