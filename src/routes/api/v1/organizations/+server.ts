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
	config: listOrganizationsEndpoint,
	example: {
		items: [
			{
				id: '2f1c9a0e-6b3d-4a77-8f21-0c5e9d4b7a10',
				kind: 'educational_institution',
				educationLevel: 'vo',
				legalName: 'Федеральное государственное бюджетное образовательное учреждение',
				shortName: 'СПбПУ',
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
		],
		total: 1,
		page: 1,
		pageSize: 20
	}
});

export const GET: RequestHandler = apiHandler(listOrganizationsEndpoint, async (ctx, { query }) => {
	const result = await listOrganizations(ctx, query);

	return { ...result, items: result.items.map(toApiOrganization) };
});
