import type { RequestHandler } from './$types';
import { apiOrganizationSchema, apiPageSchema, toApiOrganization } from '$lib/contracts/api';
import { createOrganizationSchema, organizationListQuerySchema } from '$lib/contracts/directory';
import { apiHandler, type ApiEndpointConfig } from '$lib/server/api/handler';
import { registerRoute } from '$lib/server/api/openapi';
import { listOrganizations } from '$lib/server/directory/read';
import { createOrganization } from '$lib/server/directory/write';

const listOrganizationsEndpoint = {
	auth: 'key',
	query: organizationListQuerySchema,
	output: apiPageSchema(apiOrganizationSchema),
	permission: 'organizations.read'
} satisfies ApiEndpointConfig;

const createOrganizationEndpoint = {
	auth: 'key',
	body: createOrganizationSchema,
	output: apiOrganizationSchema,
	permission: 'organizations.write',
	// Повтор после разрыва связи не должен заводить второй вуз: ИНН бывает не
	// у всех, и уникальность по нему дубль не остановит.
	idempotent: true
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

registerRoute({
	method: 'post',
	path: '/v1/organizations',
	summary: 'Создать организацию',
	description:
		'Та же проверка, что у формы справочника: ИНН с контрольной суммой и свободный, уровень ' +
		'образования только у учебных заведений, внешний идентификатор — в паре с системой. ' +
		'Физическое лицо так не заводится: оно появляется вместе с карточкой человека.\n\n' +
		'Владелец ключа сразу становится ответственным за новую организацию (кроме оператора): ' +
		'иначе запись тут же выпала бы из его области доступа.',
	tags: ['Организации'],
	config: createOrganizationEndpoint,
	bodyExample: {
		kind: 'educational_institution',
		educationLevel: 'vo',
		legalName: 'Федеральное государственное бюджетное образовательное учреждение',
		shortName: 'СПбПУ',
		inn: '7707083893',
		region: 'Москва',
		website: 'https://example.edu'
	},
	example: {
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
});

export const GET: RequestHandler = apiHandler(listOrganizationsEndpoint, async (ctx, { query }) => {
	const result = await listOrganizations(ctx, query);

	return { ...result, items: result.items.map(toApiOrganization) };
});

export const POST: RequestHandler = apiHandler(createOrganizationEndpoint, async (ctx, { body }) =>
	toApiOrganization(await createOrganization(ctx, body))
);
