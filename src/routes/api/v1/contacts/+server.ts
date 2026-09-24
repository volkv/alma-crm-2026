import type { RequestHandler } from './$types';
import { apiContactSchema, toApiContact } from '$lib/contracts/api';
import { createAffiliationSchema } from '$lib/contracts/directory';
import { apiHandler, type ApiEndpointConfig } from '$lib/server/api/handler';
import { registerRoute } from '$lib/server/api/openapi';
import { createAffiliation } from '$lib/server/directory/write';

const createContactEndpoint = {
	auth: 'key',
	body: createAffiliationSchema,
	output: apiContactSchema,
	permission: 'people.write',
	// Две одинаковые роли одного человека различить по ответу нельзя: повтор
	// после разрыва связи обязан вернуть уже заведённую.
	idempotent: true
} satisfies ApiEndpointConfig;

registerRoute({
	method: 'post',
	path: '/v1/contacts',
	summary: 'Добавить контакт организации',
	description:
		'Роль человека в организации: должность, вид роли, площадка, период полномочий и канал ' +
		'связи. Человека заводят заранее (`POST /v1/people`). Организация и человек вне области ' +
		'доступа владельца ключа отвечают 404; площадка другой организации — 400.',
	tags: ['Контакты'],
	config: createContactEndpoint,
	bodyExample: {
		personId: '3d4e5f6a-7b8c-4d9e-8f0a-1b2c3d4e5f6a',
		organizationId: '2f1c9a0e-6b3d-4a77-8f21-0c5e9d4b7a10',
		position: 'Проректор по цифровой трансформации',
		roleKind: 'vice_rector',
		isPrimary: true,
		validFrom: '2026-01-01',
		channel: 'почта'
	},
	example: {
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
});

export const POST: RequestHandler = apiHandler(createContactEndpoint, async (ctx, { body }) =>
	toApiContact(await createAffiliation(ctx, body))
);
