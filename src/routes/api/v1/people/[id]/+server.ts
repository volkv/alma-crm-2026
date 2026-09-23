import { z } from 'zod';
import type { RequestHandler } from './$types';
import { apiPersonSchema, toApiPerson } from '$lib/contracts/api';
import { id } from '$lib/contracts/common';
import { createPersonSchema } from '$lib/contracts/directory';
import { apiHandler, type ApiEndpointConfig } from '$lib/server/api/handler';
import { registerRoute } from '$lib/server/api/openapi';
import { getPerson } from '$lib/server/directory/read';
import { updatePerson } from '$lib/server/directory/write';
import { assertPersonVisible } from '$lib/server/people/access';

const params = z.object({ id: id('Некорректный идентификатор человека') });

const getPersonEndpoint = {
	auth: 'key',
	params,
	output: apiPersonSchema,
	permission: 'people.read'
} satisfies ApiEndpointConfig;

const updatePersonEndpoint = {
	auth: 'key',
	params,
	body: createPersonSchema,
	output: apiPersonSchema,
	permission: 'people.write'
} satisfies ApiEndpointConfig;

registerRoute({
	method: 'get',
	path: '/v1/people/{id}',
	summary: 'Человек по идентификатору',
	description:
		'Человек вне области доступа владельца ключа отдаётся как 404. Контакты — по тем же ' +
		'правилам, что в списке: открыты при праве `people.read_pii`, выдача оставляет след ' +
		'просмотра в журнале.',
	tags: ['Контакты'],
	config: getPersonEndpoint,
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

registerRoute({
	method: 'put',
	path: '/v1/people/{id}',
	summary: 'Изменить человека',
	description:
		'Карточка заменяется целиком, поэтому кроме `people.write` нужно и `people.read_pii`: ' +
		'иначе замаскированный адрес лёг бы в базу вместо настоящего. Не переданные необязательные ' +
		'поля становятся пустыми. Обезличенного человека изменить нельзя — 409. Человек вне ' +
		'области доступа владельца ключа отвечает 404.',
	tags: ['Контакты'],
	config: updatePersonEndpoint,
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

export const GET: RequestHandler = apiHandler(getPersonEndpoint, async (ctx, { params }) =>
	toApiPerson(await getPerson(ctx, params.id))
);

export const PUT: RequestHandler = apiHandler(
	updatePersonEndpoint,
	async (ctx, { params, body }) => {
		// Правка идёт по идентификатору, и граница области проверяется здесь же,
		// до записи: чужой человек для ключа не существует, как и в чтении.
		await assertPersonVisible(ctx, params.id);

		return toApiPerson(await updatePerson(ctx, { ...body, id: params.id }));
	}
);
