import { z } from 'zod';
import type { RequestHandler } from './$types';
import { apiCollectionSchema, apiContactSchema, toApiContact } from '$lib/contracts/api';
import { id } from '$lib/contracts/common';
import { apiHandler, type ApiEndpointConfig } from '$lib/server/api/handler';
import { registerRoute } from '$lib/server/api/openapi';
import { getOrganization, listAffiliations } from '$lib/server/directory/read';

const listContactsEndpoint = {
	auth: 'key',
	params: z.object({ id: id('Некорректный идентификатор организации') }),
	output: apiCollectionSchema(apiContactSchema),
	permission: 'people.read'
} satisfies ApiEndpointConfig;

registerRoute({
	method: 'get',
	path: '/v1/organizations/{id}/contacts',
	summary: 'Контакты организации',
	description:
		'Роли людей в организации — действующие и закрытые — вместе с самими людьми. Страницами не ' +
		'режется: это состав одной карточки. Организация вне области доступа владельца ключа ' +
		'отвечает 404. Контакты людей — по правилам `GET /v1/people`: открыты при праве ' +
		'`people.read_pii`, выдача оставляет след просмотра в журнале.',
	tags: ['Контакты'],
	config: listContactsEndpoint,
	example: {
		items: [
			{
				id: '4e5f6a7b-8c9d-4e0f-8a1b-2c3d4e5f6a7b',
				person: {
					id: '3d4e5f6a-7b8c-4d9e-8f0a-1b2c3d4e5f6a',
					lastName: 'Петров',
					firstName: 'Сергей',
					middleName: 'Андреевич',
					email: 'petrov@example.edu',
					phone: '+7 812 000-00-00',
					notes: null,
					contactsMasked: false,
					retentionUntil: null,
					anonymizedAt: null
				},
				organizationId: '2f1c9a0e-6b3d-4a77-8f21-0c5e9d4b7a10',
				siteId: null,
				position: 'Проректор по цифровой трансформации',
				roleKind: 'vice_rector',
				isPrimary: true,
				validFrom: '2026-01-01',
				validTo: null,
				channel: 'почта'
			}
		],
		total: 1
	}
});

export const GET: RequestHandler = apiHandler(listContactsEndpoint, async (ctx, { params }) => {
	// Список ролей сам область не проверяет, а отдаёт пустоту: «нет контактов» и
	// «нет такой организации» для ключа должны различаться так же, как на экране.
	const organization = await getOrganization(ctx, params.id);
	const contacts = await listAffiliations(ctx, organization.id);

	return { items: contacts.map(toApiContact), total: contacts.length };
});
