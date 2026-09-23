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
	// И только ключ сайта: право `exchange.intake` есть у любого ключа обмена, а
	// заявки подаёт CMS, а не система обучения.
	exchangeSystem: 'cms',
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
		'процесса своего пространства и назначает ответственным сотрудника из настроек обмена.\n\n' +
		'`data.externalId` — идентификатор заявки на стороне сайта; вместе с системой и экземпляром ' +
		'подключения он и есть ключ дедупликации. Повтор с тем же `externalId` **обновляет** ' +
		'взаимодействие полным снимком, а порядок задаёт `data.revision`: сообщение с ревизией не ' +
		'больше применённой отвечает `unchanged` и ничего не меняет. Повтор того же `eventId` ' +
		'отдаёт сохранённый ответ.',
	tags: ['Обмен'],
	config: applicationEndpoint,
	bodyExample: {
		schemaVersion: '1.0',
		eventId: '0f1a2b3c-4d5e-4f60-8a1b-2c3d4e5f6a70',
		eventType: 'application.submitted',
		occurredAt: '2026-09-18T09:00:00+03:00',
		source: { system: 'cms', instance: 'site-prod' },
		data: {
			externalId: 'site-2026-000123',
			revision: 1,
			form: 'b2b',
			applicant: {
				kind: 'educational_institution',
				name: 'СПбПУ',
				inn: '7707083893',
				ogrn: '1027700132195',
				educationLevel: 'vo'
			},
			contact: {
				lastName: 'Петров',
				firstName: 'Пётр',
				middleName: null,
				email: 'petrov@example.edu',
				phone: '+7 900 000-00-00',
				position: 'Заведующий кафедрой'
			},
			interest: 'Курсы по облачной платформе для третьего курса',
			programCodes: ['PRG-09.03.01'],
			productCodes: ['PRD-CLOUD'],
			comment: null,
			transferStatus: null,
			consent: null,
			attachments: []
		}
	},
	example: {
		schemaVersion: '1.1',
		result: 'created',
		data: {
			externalId: 'site-2026-000123',
			interactionId: 'a3f1c2d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
			organizationId: '2f1c9a0e-6b3d-4a77-8f21-0c5e9d4b7a10',
			contactPersonId: '3e4f5a6b-7c8d-4e9f-8a0b-1c2d3e4f5a6b',
			applicationStatus: 'received',
			processGroup: 'b2b',
			needsReview: false
		}
	}
});

export const POST: RequestHandler = apiHandler(applicationEndpoint, async (ctx, { body }) =>
	receiveApplication(ctx, body)
);
