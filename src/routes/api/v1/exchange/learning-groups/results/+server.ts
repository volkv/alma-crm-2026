import type { RequestHandler } from './$types';
import {
	learningGroupResultResponseSchema,
	learningGroupResultSchema
} from '$lib/contracts/exchange';
import { apiHandler, type ApiEndpointConfig } from '$lib/server/api/handler';
import { registerRoute } from '$lib/server/api/openapi';
import { receiveLearningGroupResult } from '$lib/server/integrations/exchange/results';

const resultEndpoint = {
	auth: 'key',
	body: learningGroupResultSchema,
	output: learningGroupResultResponseSchema,
	permission: 'exchange.results',
	service: true,
	// Результат потока подаёт система обучения: ключ сайта сюда не проходит, даже
	// имея то же право.
	exchangeSystem: 'lms',
	idempotent: true
} satisfies ApiEndpointConfig;

registerRoute({
	method: 'post',
	path: '/v1/exchange/learning-groups/results',
	summary: 'Результат учебной группы',
	description:
		'Принимает результат потока из системы обучения: сохраняет его строкой истории и ' +
		'подтверждает стадию, которой нужны данные обучения. Взаимодействие при этом **не двигается**: ' +
		'переход по стадиям — решение сотрудника, и права на него у ключа обмена нет.\n\n' +
		'Повторный результат по той же группе — обычное дело (промежуточный и итоговый). Актуальным ' +
		'считается результат с наибольшим `occurredAt`; результат старше сохранённого отвечает ' +
		'`unchanged`. Если открыта другая стадия, сообщение всё равно принимается: факт засчитается, ' +
		'когда взаимодействие дойдёт до нужной стадии, и об этом говорит поле `data.note`.',
	tags: ['Обмен'],
	config: resultEndpoint,
	example: {
		schemaVersion: '1.0',
		result: 'created',
		data: {
			groupExternalId: 'LMS-2026-000412',
			learningGroupId: 'f5a6b7c8-d9e0-4f1a-9b2c-3d4e5f6a7b8c',
			interactionId: 'a3f1c2d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
			stageConfirmed: true,
			note: 'Стадия «Обучение» подтверждена результатом потока'
		}
	}
});

export const POST: RequestHandler = apiHandler(resultEndpoint, async (ctx, { body }) =>
	receiveLearningGroupResult(ctx, body)
);
