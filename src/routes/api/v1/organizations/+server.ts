import type { RequestHandler } from './$types';
import { apiOrganizationSchema, apiPageSchema, toApiOrganization } from '$lib/contracts/api';
import { organizationListQuerySchema } from '$lib/contracts/directory';
import { apiHandler, type ApiEndpointConfig } from '$lib/server/api/handler';
import { registerRoute } from '$lib/server/api/openapi';
import { listOrganizations } from '$lib/server/directory/read';

const listOrganizationsEndpoint = {
	auth: 'key',
	query: organizationListQuerySchema,
	output: apiPageSchema(apiOrganizationSchema),
	permission: 'organizations.read'
} satisfies ApiEndpointConfig;

registerRoute({
	method: 'get',
	path: '/v1/organizations',
	summary: 'Список организаций',
	description:
		'Страница списка с фильтром по типу организации и поиском по наименованию и ИНН. ' +
		'Видно только те организации, которые входят в область доступа владельца ключа.',
	tags: ['Организации'],
	config: listOrganizationsEndpoint
});

export const GET: RequestHandler = apiHandler(listOrganizationsEndpoint, async (ctx, { query }) => {
	const result = await listOrganizations(ctx, query);

	return { ...result, items: result.items.map(toApiOrganization) };
});
