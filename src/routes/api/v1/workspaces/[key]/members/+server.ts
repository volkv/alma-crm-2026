import { z } from 'zod';
import type { RequestHandler } from './$types';
import { apiWorkspaceMembersSchema, toApiWorkspaceMembers } from '$lib/contracts/api';
import { apiHandler, type ApiEndpointConfig } from '$lib/server/api/handler';
import { registerRoute } from '$lib/server/api/openapi';
import { NotFoundError } from '$lib/server/errors';
import { listWorkspaceMemberships } from '$lib/server/rbac/workspaces';

const membersEndpoint = {
	auth: 'key',
	params: z.object({
		key: z
			.string()
			.min(1, { error: 'Укажите ключ пространства' })
			.max(100, { error: 'Ключ пространства не длиннее 100 символов' })
	}),
	output: apiWorkspaceMembersSchema,
	permission: 'users.manage'
} satisfies ApiEndpointConfig;

registerRoute({
	method: 'get',
	path: '/v1/workspaces/{key}/members',
	summary: 'Состав пространства',
	description:
		'Сотрудники, включённые в пространство, с ролью, датой включения и числом незавершённых ' +
		'взаимодействий пространства, за которые каждый отвечает. Администратор и машинный субъект ' +
		'видят все пространства по роли и в составе не числятся.\n\n' +
		'Право `users.manage`: состав пространства — это выданный доступ, тот же, что на экране ' +
		'настройки пространств. Изменять состав через API нельзя — это работа администратора в ' +
		'интерфейсе.',
	tags: ['Процесс'],
	config: membersEndpoint,
	example: {
		workspace: { id: 'b7c8d9e0-f1a2-4b3c-8d4e-5f6a7b8c9d0e', key: 'b2b', name: 'Работа с ВУЗ' },
		members: [
			{
				userId: '9c8b7a65-4321-4098-b7a6-5c4d3e2f1a09',
				fullName: 'Иванова Мария',
				roleName: 'Менеджер',
				isActive: true,
				since: '2026-09-01T09:00:00.000Z',
				ownedActive: 12
			}
		]
	}
});

export const GET: RequestHandler = apiHandler(membersEndpoint, async (ctx, { params }) => {
	const { workspaces } = await listWorkspaceMemberships(ctx);
	const workspace = workspaces.find((row) => row.key === params.key);

	if (workspace === undefined) {
		throw new NotFoundError('Пространство не найдено');
	}

	return toApiWorkspaceMembers(workspace);
});
