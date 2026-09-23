import { z } from 'zod';
import type { RequestHandler } from './$types';
import {
	apiAssignResponsibleRequestSchema,
	apiCollectionSchema,
	apiResponsibleSchema,
	toApiResponsible
} from '$lib/contracts/api';
import { id } from '$lib/contracts/common';
import type { ActorContext } from '$lib/server/actor';
import { apiHandler, type ApiEndpointConfig } from '$lib/server/api/handler';
import { registerRoute } from '$lib/server/api/openapi';
import { getOrganization } from '$lib/server/directory/read';
import { assignResponsible, listResponsibles } from '$lib/server/directory/responsibles';

const params = z.object({ id: id('Некорректный идентификатор организации') });
const output = apiCollectionSchema(apiResponsibleSchema);

const listResponsiblesEndpoint = {
	auth: 'key',
	params,
	output,
	permission: 'organizations.read'
} satisfies ApiEndpointConfig;

const assignResponsibleEndpoint = {
	auth: 'key',
	params,
	body: apiAssignResponsibleRequestSchema,
	output,
	permission: 'responsibles.manage',
	// Повтор назначения, которое уже прошло, ответил бы 409 «уже отвечает», и
	// клиент после разрыва связи не узнал бы, что его запрос выполнен.
	idempotent: true
} satisfies ApiEndpointConfig;

const example = {
	items: [
		{
			id: '5f6a7b8c-9d0e-4f1a-8b2c-3d4e5f6a7b8c',
			userId: '9c8b7a65-4321-4098-b7a6-5c4d3e2f1a09',
			userFullName: 'Иванова Мария',
			directionId: null,
			directionName: null,
			validFrom: '2026-09-01T09:00:00.000Z',
			validTo: null,
			assignedByFullName: 'Смирнов Олег'
		}
	],
	total: 1
};

registerRoute({
	method: 'get',
	path: '/v1/organizations/{id}/responsibles',
	summary: 'Ответственные за организацию',
	description:
		'Назначения — сначала действующие, затем закрытые, от свежих к старым. Назначение не ' +
		'удаляется, а закрывается, поэтому список отвечает и на вопрос «кто вёл вуз тогда». ' +
		'Организация вне области доступа владельца ключа отвечает 404.',
	tags: ['Организации'],
	config: listResponsiblesEndpoint,
	example
});

registerRoute({
	method: 'post',
	path: '/v1/organizations/{id}/responsibles',
	summary: 'Назначить ответственного',
	description:
		'Назначает ответственного за вуз целиком (`directionId: null`) или по ИТ-направлению; ' +
		'прежнее действующее назначение на ту же пару закрывается. Общее назначение и назначения ' +
		'по направлениям не сосуществуют — конфликт отвечает 409. Назначать можно себя и своих ' +
		'подчинённых; администратор — любого сотрудника.\n\n' +
		'`transferInteractions: true` передаёт новому ответственному незавершённые ' +
		'взаимодействия прежнего и требует ещё права `interactions.reassign`. В ответе — ' +
		'назначения организации после изменения.',
	tags: ['Организации'],
	config: assignResponsibleEndpoint,
	bodyExample: {
		userId: '9c8b7a65-4321-4098-b7a6-5c4d3e2f1a09',
		directionId: null,
		transferInteractions: false
	},
	example
});

async function responsiblesOf(ctx: ActorContext, organizationId: string) {
	const rows = await listResponsibles(ctx, organizationId);

	return { items: rows.map(toApiResponsible), total: rows.length };
}

export const GET: RequestHandler = apiHandler(listResponsiblesEndpoint, async (ctx, { params }) => {
	// Список назначений читают с карточки, а видимость карточки решает её
	// чтение: вне области организация для ключа не существует.
	const organization = await getOrganization(ctx, params.id);

	return responsiblesOf(ctx, organization.id);
});

export const POST: RequestHandler = apiHandler(
	assignResponsibleEndpoint,
	async (ctx, { params, body }) => {
		await assignResponsible(ctx, { organizationId: params.id, ...body });

		return responsiblesOf(ctx, params.id);
	}
);
