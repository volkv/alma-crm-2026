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
	config: getOrganizationEndpoint,
	example: {
		id: '2f1c9a0e-6b3d-4a77-8f21-0c5e9d4b7a10',
		kind: 'educational_institution',
		educationLevel: 'vo',
		legalName: 'Федеральное государственное бюджетное образовательное учреждение',
		shortName: 'СЗПУ',
		inn: '7707083893',
		kpp: '770701001',
		ogrn: '1027700132195',
		region: 'Москва',
		website: 'https://example.edu',
		notes: null,
		isActive: true,
		externalSource: null,
		externalId: null,
		createdAt: '2026-09-12T10:00:00.000Z',
		updatedAt: '2026-09-12T11:30:00.000Z'
	}
});

export const GET: RequestHandler = apiHandler(getOrganizationEndpoint, async (ctx, { params }) =>
	toApiOrganization(await getOrganization(ctx, params.id))
);
