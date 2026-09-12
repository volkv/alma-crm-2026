import { z } from 'zod';
import type { RequestHandler } from './$types';
import { id } from '$lib/contracts/common';
import { apiInteractionDetailSchema, toApiInteractionDetail } from '$lib/contracts/interactions';
import { apiHandler, type ApiEndpointConfig } from '$lib/server/api/handler';
import { registerRoute } from '$lib/server/api/openapi';
import { getInteraction } from '$lib/server/interactions/read';
import { getInteractionStatus } from '$lib/server/stages/status';

const getInteractionEndpoint = {
	auth: 'key',
	params: z.object({ id: id('Некорректный идентификатор взаимодействия') }),
	output: apiInteractionDetailSchema,
	permission: 'interactions.read'
} satisfies ApiEndpointConfig;

registerRoute({
	method: 'get',
	path: '/v1/interactions/{id}',
	summary: 'Взаимодействие по идентификатору',
	description:
		'Карточка со сторонами, программами, продуктами и лентой стадий. Контактов людей здесь нет: ' +
		'их отдаёт только интерфейс, где маскирование делает сериализатор персональных данных. ' +
		'Запись вне области доступа владельца ключа отдаётся как 404, а не как 403.',
	tags: ['Взаимодействия'],
	config: getInteractionEndpoint
});

export const GET: RequestHandler = apiHandler(getInteractionEndpoint, async (ctx, { params }) => {
	const [interaction, status] = await Promise.all([
		getInteraction(ctx, params.id),
		getInteractionStatus(ctx, params.id)
	]);

	return toApiInteractionDetail(interaction, status, {
		isStale: status.isStale,
		openBlockers: status.blockers.filter((blocker) => blocker.resolvedAt === null).length
	});
});
