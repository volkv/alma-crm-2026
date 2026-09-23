import { z } from 'zod';
import type { RequestHandler } from './$types';
import { apiOrganizationSchema, toApiOrganization } from '$lib/contracts/api';
import { id } from '$lib/contracts/common';
import { createOrganizationSchema } from '$lib/contracts/directory';
import { apiHandler, type ApiEndpointConfig } from '$lib/server/api/handler';
import { registerRoute } from '$lib/server/api/openapi';
import { getOrganization } from '$lib/server/directory/read';
import { updateOrganization } from '$lib/server/directory/write';

const getOrganizationEndpoint = {
	auth: 'key',
	params: z.object({ id: id('Некорректный идентификатор организации') }),
	output: apiOrganizationSchema,
	permission: 'organizations.read'
} satisfies ApiEndpointConfig;

const updateOrganizationEndpoint = {
	auth: 'key',
	params: z.object({ id: id('Некорректный идентификатор организации') }),
	body: createOrganizationSchema,
	output: apiOrganizationSchema,
	permission: 'organizations.write'
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

registerRoute({
	method: 'put',
	path: '/v1/organizations/{id}',
	summary: 'Изменить организацию',
	description:
		'Карточка заменяется целиком — тело то же, что при заведении. Правила проверки те же, что ' +
		'у формы справочника; организация вне области доступа владельца ключа отвечает 404.\n\n' +
		'Замена полная, как у формы: не переданное необязательное поле становится пустым, а ' +
		'`isActive` — `true`. Поэтому тело собирают из текущей карточки (`GET` того же адреса), а ' +
		'не из одних изменённых полей.',
	tags: ['Организации'],
	config: updateOrganizationEndpoint,
	bodyExample: {
		kind: 'educational_institution',
		educationLevel: 'vo',
		legalName: 'Федеральное государственное бюджетное образовательное учреждение',
		shortName: 'СПбПУ',
		inn: '7707083893',
		region: 'Санкт-Петербург',
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

export const GET: RequestHandler = apiHandler(getOrganizationEndpoint, async (ctx, { params }) =>
	toApiOrganization(await getOrganization(ctx, params.id))
);

export const PUT: RequestHandler = apiHandler(
	updateOrganizationEndpoint,
	async (ctx, { params, body }) =>
		toApiOrganization(await updateOrganization(ctx, { ...body, id: params.id }))
);
