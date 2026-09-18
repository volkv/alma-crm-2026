import type { RequestHandler } from './$types';
import { apiContractSchema, apiPageSchema, toApiContract } from '$lib/contracts/api';
import { contractListQuerySchema } from '$lib/contracts/directory';
import { apiHandler, type ApiEndpointConfig } from '$lib/server/api/handler';
import { registerRoute } from '$lib/server/api/openapi';
import { listContracts } from '$lib/server/directory/contracts';

const listContractsEndpoint = {
	auth: 'key',
	query: contractListQuerySchema,
	output: apiPageSchema(apiContractSchema),
	permission: 'organizations.read'
} satisfies ApiEndpointConfig;

registerRoute({
	method: 'get',
	path: '/v1/contracts',
	summary: 'Список договоров',
	description:
		'Страница списка договоров с позициями: продукт, сроки лицензии и статус по передаче. ' +
		'Фильтры — контрагент (`organizationId`) и состояние (`status`). В отличие от каталогов ' +
		'продуктов и программ список сужается областью доступа владельца ключа: договор — это ' +
		'обязательство с конкретным вузом, и видит его тот, кто видит сам вуз. Договор вне области ' +
		'в список не попадает.',
	tags: ['Организации'],
	config: listContractsEndpoint,
	example: {
		items: [
			{
				id: '6c8f1d2e-4a5b-4c6d-8e9f-0a1b2c3d4e5f',
				organizationId: '2f1c9a0e-6b3d-4a77-8f21-0c5e9d4b7a10',
				number: 'РТК-2026/14',
				signedOn: '2026-02-01',
				validUntil: '2027-01-31',
				status: 'active',
				items: [
					{
						id: '9d0e1f2a-3b4c-4d5e-8f60-1a2b3c4d5e6f',
						productId: '7b2c9a41-3d4e-4f50-9a1b-2c3d4e5f6a7b',
						productCode: 'PRD-CLOUD',
						productName: 'Облачная платформа',
						licenseSignedAt: '2026-02-10',
						licenseUntil: '2027-02-09',
						transferStatus: 'передан вузу'
					}
				],
				createdAt: '2026-02-01T09:00:00.000Z',
				updatedAt: '2026-02-10T12:00:00.000Z'
			}
		],
		total: 1,
		page: 1,
		pageSize: 20
	}
});

export const GET: RequestHandler = apiHandler(listContractsEndpoint, async (ctx, { query }) => {
	const result = await listContracts(ctx, query);

	return { ...result, items: result.items.map(toApiContract) };
});
