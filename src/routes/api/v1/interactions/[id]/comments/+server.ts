import { z } from 'zod';
import type { RequestHandler } from './$types';
import {
	apiCollectionSchema,
	apiCommentCreatedSchema,
	apiCommentRequestSchema,
	apiCommentSchema,
	toApiComment
} from '$lib/contracts/api';
import { id } from '$lib/contracts/common';
import { apiHandler, type ApiEndpointConfig } from '$lib/server/api/handler';
import { registerRoute } from '$lib/server/api/openapi';
import { listComments } from '$lib/server/interactions/read';
import { addComment } from '$lib/server/stages/commands';

const listCommentsEndpoint = {
	auth: 'key',
	params: z.object({ id: id('Некорректный идентификатор взаимодействия') }),
	output: apiCollectionSchema(apiCommentSchema),
	permission: 'interactions.read'
} satisfies ApiEndpointConfig;

const createCommentEndpoint = {
	auth: 'key',
	params: z.object({ id: id('Некорректный идентификатор взаимодействия') }),
	body: apiCommentRequestSchema,
	output: apiCommentCreatedSchema,
	permission: 'interactions.write',
	// Повтор после разрыва связи не должен оставлять в ленте два одинаковых
	// комментария: различить их по тексту нельзя, а удалять комментарии нечем.
	idempotent: true
} satisfies ApiEndpointConfig;

registerRoute({
	method: 'get',
	path: '/v1/interactions/{id}/comments',
	summary: 'Комментарии взаимодействия',
	description:
		'Лента комментариев, новые сверху. Страницами не режется: комментарии читают целиком, ' +
		'как переписку. Запись вне области доступа владельца ключа отдаётся как 404.',
	tags: ['Взаимодействия'],
	config: listCommentsEndpoint,
	example: {
		items: [
			{
				id: 'a6b7c8d9-e0f1-4a2b-8c3d-4e5f6a7b8c9d',
				authorId: '9c8b7a65-4321-4098-b7a6-5c4d3e2f1a09',
				authorName: 'Иванова Мария',
				body: 'Вуз просит перенести встречу на следующую неделю',
				createdAt: '2026-09-17T14:05:00.000Z'
			}
		],
		total: 1
	}
});

registerRoute({
	method: 'post',
	path: '/v1/interactions/{id}/comments',
	summary: 'Комментарий к взаимодействию',
	description:
		'Пишет комментарий от имени владельца ключа: автора телом не передают — иначе машина ' +
		'писала бы от чужого имени. Взаимодействие вне области доступа владельца ключа отвечает 404.\n\n' +
		'Комментарий — единственное, что внешняя система может записать в карточку, и ровно для ' +
		'того, чтобы оставить след: «заявка пришла с формы кафедры», «письмо доставлено». Двигать ' +
		'процесс комментарий не может.',
	tags: ['Взаимодействия'],
	config: createCommentEndpoint,
	bodyExample: { body: 'Заявка продублирована письмом на кафедру' },
	example: { id: 'a6b7c8d9-e0f1-4a2b-8c3d-4e5f6a7b8c9d' }
});

export const GET: RequestHandler = apiHandler(listCommentsEndpoint, async (ctx, { params }) => {
	const comments = await listComments(ctx, params.id);

	return { items: comments.map(toApiComment), total: comments.length };
});

export const POST: RequestHandler = apiHandler(createCommentEndpoint, (ctx, { params, body }) =>
	addComment(ctx, { interactionId: params.id, body: body.body })
);
