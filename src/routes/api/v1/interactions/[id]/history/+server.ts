import { z } from 'zod';
import type { RequestHandler } from './$types';
import { apiInteractionHistorySchema, toApiInteractionHistory } from '$lib/contracts/api';
import { id } from '$lib/contracts/common';
import { apiHandler, type ApiEndpointConfig } from '$lib/server/api/handler';
import { registerRoute } from '$lib/server/api/openapi';
import { listInteractionChanges } from '$lib/server/interactions/read';
import { getInteractionStatus } from '$lib/server/stages/status';

const historyEndpoint = {
	auth: 'key',
	params: z.object({ id: id('Некорректный идентификатор взаимодействия') }),
	output: apiInteractionHistorySchema,
	permission: 'interactions.read'
} satisfies ApiEndpointConfig;

registerRoute({
	method: 'get',
	path: '/v1/interactions/{id}/history',
	summary: 'История взаимодействия',
	description:
		'Две ленты одним ответом: записи о стадиях — где взаимодействие стояло, сколько шло, чем ' +
		'кончило, — и предметные изменения плана: сроки, стороны, программы, ответственный.\n\n' +
		'Стадия названа ключом и именем из снимка на момент входа: процесс группы могли изменить, ' +
		'а пройденная стадия обязана остаться такой, какой её видел исполнитель. Запись вне области ' +
		'доступа владельца ключа отдаётся как 404, а не как 403.',
	tags: ['Взаимодействия'],
	config: historyEndpoint,
	example: {
		interactionId: 'a3f1c2d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
		processRevision: 2,
		current: {
			id: 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e',
			stageKey: 'document_exchange',
			stageName: 'Обмен пакетом документов',
			stagePosition: 4,
			stageCategory: 'documents',
			enteredAt: '2026-09-15T09:00:00.000Z',
			leftAt: null,
			outcome: null,
			outcomeReason: null,
			responsibleUserId: '9c8b7a65-4321-4098-b7a6-5c4d3e2f1a09',
			responsibleName: 'Иванова Мария',
			resultText: null,
			confirmedAt: null,
			dueAt: '2026-10-01T09:00:00.000Z',
			activeSeconds: 259200,
			pausedSeconds: 0,
			overdueSeconds: 0,
			isOverdue: false,
			isPaused: false,
			documentIds: []
		},
		stages: [
			{
				id: 'c2d3e4f5-a6b7-4c8d-9e0f-1a2b3c4d5e6f',
				stageKey: 'contact_search',
				stageName: 'Поиск контактных лиц',
				stagePosition: 1,
				stageCategory: 'contact',
				enteredAt: '2026-09-01T09:00:00.000Z',
				leftAt: '2026-09-15T09:00:00.000Z',
				outcome: 'completed',
				outcomeReason: null,
				responsibleUserId: '9c8b7a65-4321-4098-b7a6-5c4d3e2f1a09',
				responsibleName: 'Иванова Мария',
				resultText: 'Договорились о встрече',
				confirmedAt: '2026-09-15T08:50:00.000Z',
				dueAt: '2026-09-08T09:00:00.000Z',
				activeSeconds: 1209600,
				pausedSeconds: 0,
				overdueSeconds: 604800,
				isOverdue: true,
				isPaused: false,
				documentIds: []
			}
		],
		changes: [
			{
				id: 'd3e4f5a6-b7c8-4d9e-8f01-2a3b4c5d6e7f',
				changedAt: '2026-09-14T11:00:00.000Z',
				authorId: '9c8b7a65-4321-4098-b7a6-5c4d3e2f1a09',
				authorName: 'Иванова Мария',
				field: 'agreementPeriodEnd',
				oldValue: null,
				newValue: '2027-06-30',
				reason: 'Срок соглашения согласован с вузом'
			}
		]
	}
});

export const GET: RequestHandler = apiHandler(historyEndpoint, async (ctx, { params }) => {
	const [status, changes] = await Promise.all([
		getInteractionStatus(ctx, params.id),
		listInteractionChanges(ctx, params.id)
	]);

	return toApiInteractionHistory(status, changes);
});
