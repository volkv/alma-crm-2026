import type { RequestHandler } from './$types';
import {
	applicationIntakeResponseSchema,
	applicationSubmittedSchema
} from '$lib/contracts/exchange';
import { apiHandler, type ApiEndpointConfig } from '$lib/server/api/handler';
import { registerRoute } from '$lib/server/api/openapi';
import { receiveApplication } from '$lib/server/integrations/exchange/intake';

const applicationEndpoint = {
	auth: 'key',
	body: applicationSubmittedSchema,
	output: applicationIntakeResponseSchema,
	permission: 'exchange.intake',
	// Маршрут обмена: сюда допускается ключ машинного субъекта роли `service`, и
	// только сюда. Признак объявлен на маршруте, а не выведен из права: у такого
	// ключа область `all`, и на обычном маршруте он увидел бы весь продукт.
	service: true,
	// Повтор после разрыва связи не должен создавать вторую запись. Своих защит у
	// заявки две — журнал обмена по `eventId` и внешняя ссылка взаимодействия, —
	// но ключ идемпотентности отвечает и за повтор, посланный до того, как первый
	// запрос успел их записать.
	idempotent: true
} satisfies ApiEndpointConfig;

registerRoute({
	method: 'post',
	path: '/v1/applications',
	summary: 'Заявка с сайта',
	description:
		'Принимает заявку CMS публичного сайта в конверте обмена и превращает её во взаимодействие: ' +
		'находит или заводит контрагента (вуз и юрлицо — по ИНН, затем по ОГРН; физлицо — по почте, ' +
		'затем по телефону), контактное лицо и его роль, ставит взаимодействие на первую стадию ' +
		'процесса своей группы и назначает ответственным сотрудника из настроек обмена.\n\n' +
		'`data.externalId` — идентификатор заявки на стороне сайта; вместе с системой и экземпляром ' +
		'подключения он и есть ключ дедупликации. Повтор с тем же `externalId` **обновляет** ' +
		'взаимодействие полным снимком, а порядок задаёт `data.revision`: сообщение с ревизией не ' +
		'больше применённой отвечает `unchanged` и ничего не меняет. Повтор того же `eventId` ' +
		'отдаёт сохранённый ответ.',
	tags: ['Обмен'],
	config: applicationEndpoint
});

export const POST: RequestHandler = apiHandler(applicationEndpoint, async (ctx, { body }) =>
	receiveApplication(ctx, body)
);
