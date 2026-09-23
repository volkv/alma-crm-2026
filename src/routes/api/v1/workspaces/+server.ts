import type { RequestHandler } from './$types';
import { apiCollectionSchema, apiWorkspaceSchema } from '$lib/contracts/api';
import { apiHandler, type ApiEndpointConfig } from '$lib/server/api/handler';
import { registerRoute } from '$lib/server/api/openapi';
import { listWorkspaces } from '$lib/server/stages/process';

const listWorkspacesEndpoint = {
	auth: 'key',
	output: apiCollectionSchema(apiWorkspaceSchema),
	permission: 'stages.configure'
} satisfies ApiEndpointConfig;

registerRoute({
	method: 'get',
	path: '/v1/workspaces',
	summary: 'Пространства',
	description:
		'Рабочие места направлений, внутри которых идут взаимодействия: работа с учебными ' +
		'заведениями (`b2b`), коммерческое обучение (`b2c`) и всё, что заведено сверх них. У каждого пространства — число стадий ' +
		'действующей редакции его процесса и число незавершённых взаимодействий в нём.\n\n' +
		'Право `stages.configure` здесь не случайно: устройство процесса — это настройка системы, ' +
		'а не рабочие данные. Стадии действующей редакции отдаёт `GET /v1/workspaces/{key}`.',
	tags: ['Процесс'],
	config: listWorkspacesEndpoint,
	example: {
		items: [
			{
				id: 'b7c8d9e0-f1a2-4b3c-8d4e-5f6a7b8c9d0e',
				key: 'b2b',
				name: 'Работа с ВУЗ',
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

export const GET: RequestHandler = apiHandler(listWorkspacesEndpoint, async (ctx) => {
	const items = await listWorkspaces(ctx);

	return { items, total: items.length };
});
