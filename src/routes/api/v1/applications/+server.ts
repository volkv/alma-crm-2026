import type { RequestHandler } from './$types';
import { applicationIntakeSchema, applicationResultSchema } from '$lib/contracts/integrations';
import { apiHandler, type ApiEndpointConfig } from '$lib/server/api/handler';
import { registerRoute } from '$lib/server/api/openapi';
import { receiveApplication } from '$lib/server/integrations/intake';

const applicationEndpoint = {
	auth: 'key',
	body: applicationIntakeSchema,
	output: applicationResultSchema,
	// Заявка заводит организацию, человека и взаимодействие: право то же, что у
	// заведения взаимодействия руками.
	permission: 'interactions.write',
	// Повтор после разрыва связи не должен создавать вторую запись. Своя защита
	// у заявки тоже есть — внешняя ссылка, — но ключ идемпотентности отвечает и
	// за повтор, посланный до того, как первый запрос успел записать её.
	idempotent: true
} satisfies ApiEndpointConfig;

registerRoute({
	method: 'post',
	path: '/v1/applications',
	summary: 'Заявка с сайта',
	description:
		'Принимает заявку с публичного сайта и превращает её во взаимодействие: находит или заводит ' +
		'организацию (сверка только по ИНН), контактное лицо и его роль, ставит взаимодействие на ' +
		'маршрут по умолчанию и назначает ответственным владельца ключа. ' +
		'`externalId` — идентификатор заявки на стороне сайта: повтор с тем же значением возвращает ' +
		'прежнее взаимодействие и `created: false`, а не создаёт второе.',
	tags: ['Интеграции'],
	config: applicationEndpoint
});

export const POST: RequestHandler = apiHandler(applicationEndpoint, async (ctx, { body }) =>
	receiveApplication(ctx, body)
);
