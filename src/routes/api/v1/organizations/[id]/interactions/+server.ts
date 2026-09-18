import { z } from 'zod';
import type { RequestHandler } from './$types';
import { apiPageSchema } from '$lib/contracts/api';
import { id } from '$lib/contracts/common';
import {
	apiInteractionSchema,
	interactionListQuerySchema,
	toApiInteraction
} from '$lib/contracts/interactions';
import { apiHandler, type ApiEndpointConfig } from '$lib/server/api/handler';
import { registerRoute } from '$lib/server/api/openapi';
import { listInteractions } from '$lib/server/interactions/read';

/**
 * Организация задана адресом, поэтому тем же фильтром из строки запроса её
 * подменить нельзя: иначе один и тот же отбор задавался бы двумя способами, и
 * однажды они разошлись бы.
 */
const organizationInteractionsQuery = interactionListQuerySchema.omit({ organizationId: true });

const organizationInteractionsEndpoint = {
	auth: 'key',
	params: z.object({ id: id('Некорректный идентификатор организации') }),
	query: organizationInteractionsQuery,
	output: apiPageSchema(apiInteractionSchema),
	permission: 'interactions.read'
} satisfies ApiEndpointConfig;

registerRoute({
	method: 'get',
	path: '/v1/organizations/{id}/interactions',
	summary: 'Взаимодействия организации',
	description:
		'Страница взаимодействий, одной из сторон которых является эта организация. Фильтры те же, ' +
		'что у общего списка, кроме организации: её задаёт адрес.\n\n' +
		'Организация вне области доступа владельца ключа даёт пустую страницу, а не отказ: ' +
		'по разнице между «нет взаимодействий» и «нет доступа» перебором узнавали бы, какие вузы ' +
		'существуют за её пределами.',
	tags: ['Организации'],
	config: organizationInteractionsEndpoint,
	example: {
		items: [
			{
				id: 'a3f1c2d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
				title: 'Переговоры с СПбПУ',
				status: 'active',
				ownerUserId: '9c8b7a65-4321-4098-b7a6-5c4d3e2f1a09',
				ownerName: 'Иванова Мария',
				institutionName: 'СПбПУ',
				customerName: null,
				stageKey: 'document_exchange',
				stageName: 'Обмен пакетом документов',
				stagePosition: 4,
				stageCategory: 'documents',
				dueAt: '2026-10-01T09:00:00.000Z',
				isOverdue: false,
				isPaused: false,
				isStale: false,
				openBlockers: 0,
				lastActivityAt: '2026-09-18T12:30:00.000Z'
			}
		],
		total: 1,
		page: 1,
		pageSize: 20
	}
});

export const GET: RequestHandler = apiHandler(
	organizationInteractionsEndpoint,
	async (ctx, { params, query }) => {
		const result = await listInteractions(ctx, { ...query, organizationId: params.id });

		return { ...result, items: result.items.map(toApiInteraction) };
	}
);
