import { z } from 'zod';
import type { RequestHandler } from './$types';
import { apiOrganizationSchema, toApiOrganization } from '$lib/contracts/api';
import { id } from '$lib/contracts/common';
import { apiHandler, type ApiEndpointConfig } from '$lib/server/api/handler';
import { registerRoute } from '$lib/server/api/openapi';
import { getOrganization } from '$lib/server/directory/read';

const getOrganizationEndpoint = {
	auth: 'key',
	params: z.object({ id: id('Некорректный идентификатор организации') }),
	output: apiOrganizationSchema,
	permission: 'organizations.read'
} satisfies ApiEndpointConfig;

registerRoute({
	method: 'get',
	path: '/v1/organizations/{id}',
	summary: 'Организация по идентификатору',
	description:
		'Организация вне области доступа владельца ключа отдаётся как 404, а не как 403: ' +
		'иначе перебором идентификаторов можно было бы узнать, что существует за её пределами.',
	tags: ['Организации'],
	config: getOrganizationEndpoint
});

export const GET: RequestHandler = apiHandler(getOrganizationEndpoint, async (ctx, { params }) =>
	toApiOrganization(await getOrganization(ctx, params.id))
);
