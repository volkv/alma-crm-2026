import type { RequestHandler } from './$types';
import { apiExchangeMessageSchema, apiPageSchema, toApiExchangeMessage } from '$lib/contracts/api';
import { exchangeQuerySchema } from '$lib/contracts/exchange';
import { apiHandler, type ApiEndpointConfig } from '$lib/server/api/handler';
import { registerRoute } from '$lib/server/api/openapi';
import { listExchangeMessages } from '$lib/server/integrations/exchange/messages';

const exchangeMessagesEndpoint = {
	auth: 'key',
	query: exchangeQuerySchema,
	output: apiPageSchema(apiExchangeMessageSchema),
	// Журнал обмена — техническая хроника интеграции, а не работа по вузу:
	// право на него общее, и областью доступа он не сужается.
	permission: 'integrations.manage'
} satisfies ApiEndpointConfig;

registerRoute({
	method: 'get',
	path: '/v1/exchange/messages',
	summary: 'Журнал обмена',
	description:
		'Хроника сообщений CMS и системы обучения, новые сверху: что ушло, что пришло, сколько было ' +
		'попыток, когда следующая и чем ответил получатель. Фильтры — `direction`, `system`, ' +
		'`state`; поиск `q` идёт по ключу объекта и по идентификатору события.\n\n' +
		'Это **чтение** журнала, а не маршрут обмена: сюда ходит наблюдение заказчика ключом ' +
		'администратора. Ключ машинного субъекта, которым CMS и LMS подают данные, сюда не ' +
		'допускается — у него нет ни этого права, ни доступа за пределы маршрутов обмена.',
	tags: ['Журнал обмена'],
	config: exchangeMessagesEndpoint,
	example: {
		items: [
			{
				id: 'e0f1a2b3-c4d5-4e6f-8a7b-8c9d0e1f2a3b',
				direction: 'outbound',
				system: 'lms',
				instance: 'moodle-prod',
				eventType: 'learning_group.requested',
				eventId: '0f1a2b3c-4d5e-4f60-8a1b-2c3d4e5f6a70',
				externalId: 'a3f1c2d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d:1',
				interactionId: 'a3f1c2d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
				interactionTitle: 'Переговоры с СЗПУ',
				state: 'sent',
				attempt: 1,
				nextAttemptAt: null,
				responseStatus: 200,
				lastError: null,
				createdAt: '2026-09-10T07:00:00.000Z',
				closedAt: '2026-09-10T07:00:02.000Z'
			}
		],
		total: 1,
		page: 1,
		pageSize: 20
	}
});

export const GET: RequestHandler = apiHandler(exchangeMessagesEndpoint, async (ctx, { query }) => {
	const result = await listExchangeMessages(ctx, query);

	return { ...result, items: result.items.map(toApiExchangeMessage) };
});
