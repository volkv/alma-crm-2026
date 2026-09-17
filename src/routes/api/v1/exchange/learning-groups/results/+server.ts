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
	config: resultEndpoint
});

export const POST: RequestHandler = apiHandler(resultEndpoint, async (ctx, { body }) =>
	receiveLearningGroupResult(ctx, body)
);
