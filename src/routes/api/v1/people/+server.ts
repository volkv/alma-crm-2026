import type { RequestHandler } from './$types';
import {
	apiPageSchema,
	apiPersonListItemSchema,
	apiPersonSchema,
	toApiPerson,
	toApiPersonListItem
} from '$lib/contracts/api';
import { createPersonSchema, peopleListQuerySchema } from '$lib/contracts/directory';
import { apiHandler, type ApiEndpointConfig } from '$lib/server/api/handler';
import { registerRoute } from '$lib/server/api/openapi';
import { listPeople } from '$lib/server/directory/read';
import { createPerson } from '$lib/server/directory/write';

const listPeopleEndpoint = {
	auth: 'key',
	query: peopleListQuerySchema,
	output: apiPageSchema(apiPersonListItemSchema),
	permission: 'people.read'
} satisfies ApiEndpointConfig;

const createPersonEndpoint = {
	auth: 'key',
	body: createPersonSchema,
	output: apiPersonSchema,
	permission: 'people.write',
	// Двух одинаковых людей по ответу не различить, а слияния карточек нет:
	// повтор после разрыва связи обязан вернуть уже заведённого.
	idempotent: true
} satisfies ApiEndpointConfig;

registerRoute({
	method: 'get',
	path: '/v1/people',
	summary: 'Список людей',
	description:
		'Контактные лица организаций: страница списка с фильтром по организации (`organizationId`) и ' +
		'поиском по ФИО и наименованию организации. Видны люди с ролью в организации из области ' +
		'доступа владельца ключа и люди без ролей.\n\n' +
		'Почта и телефон открыты только при праве `people.read_pii`; иначе замаскированы, и ' +
		'`contactsMasked` это говорит. Выдача контактов оставляет след просмотра в журнале действий — ' +
		'одно событие на запрос.',
	tags: ['Контакты'],
	config: listPeopleEndpoint,
	example: {
		items: [
			{
				...{
					id: '3d4e5f6a-7b8c-4d9e-8f0a-1b2c3d4e5f6a',
					lastName: 'Петров',
					firstName: 'Сергей',
					middleName: 'Андреевич',
					email: 'petrov@example.edu',
					phone: '+7 812 000-00-00',
					notes: null,
					contactsMasked: false,
					retentionUntil: null,
					anonymizedAt: null
				},
				organizations: [{ id: '2f1c9a0e-6b3d-4a77-8f21-0c5e9d4b7a10', shortName: 'СПбПУ' }],
				retentionExpired: false
			}
		],
		total: 1,
		page: 1,
		pageSize: 20
	}
});

registerRoute({
	method: 'post',
	path: '/v1/people',
	summary: 'Завести человека',
	description:
		'Карточка человека без роли: должность и организацию добавляет `POST /v1/contacts`. ' +
		'Контакты хранятся зашифрованными; в ответе они открыты только при праве ' +
		'`people.read_pii` — право на запись и право видеть контакты разные.',
	tags: ['Контакты'],
	config: createPersonEndpoint,
	bodyExample: {
		lastName: 'Петров',
		firstName: 'Сергей',
		middleName: 'Андреевич',
		email: 'petrov@example.edu',
		phone: '+7 812 000-00-00'
	},
	example: {
		id: '3d4e5f6a-7b8c-4d9e-8f0a-1b2c3d4e5f6a',
		lastName: 'Петров',
		firstName: 'Сергей',
		middleName: 'Андреевич',
		email: 'petrov@example.edu',
		phone: '+7 812 000-00-00',
		notes: null,
		contactsMasked: false,
		retentionUntil: null,
		anonymizedAt: null
	}
});

export const GET: RequestHandler = apiHandler(listPeopleEndpoint, async (ctx, { query }) => {
	const result = await listPeople(ctx, query);

	return { ...result, items: result.items.map(toApiPersonListItem) };
});

export const POST: RequestHandler = apiHandler(createPersonEndpoint, async (ctx, { body }) =>
	toApiPerson(await createPerson(ctx, body))
);
