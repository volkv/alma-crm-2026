import { z } from 'zod';
import type { RequestHandler } from './$types';
import { apiDocumentMarksSchema, toApiDocumentMarks } from '$lib/contracts/api';
import { id } from '$lib/contracts/common';
import { markDocumentStatusSchema, markMomentFromDay } from '$lib/contracts/documents';
import { apiHandler, type ApiEndpointConfig } from '$lib/server/api/handler';
import { registerRoute } from '$lib/server/api/openapi';
import { markDocument } from '$lib/server/documents/status';

/** Документ задан адресом: подменить его телом запроса нельзя. */
const markBody = markDocumentStatusSchema.omit({ documentId: true });

const documentMarksEndpoint = {
	auth: 'key',
	params: z.object({ id: id('Некорректный идентификатор документа') }),
	body: markBody,
	output: apiDocumentMarksSchema,
	permission: 'documents.write',
	// Отметка ставится один раз, и повтор без ключа идемпотентности приходит не
	// вторым фактом, а отказом 409 — по которому не понять, чья это отметка:
	// своя, доехавшая дважды, или чужая.
	idempotent: true
} satisfies ApiEndpointConfig;

registerRoute({
	method: 'post',
	path: '/v1/documents/{id}/marks',
	summary: 'Отметка по документу',
	description:
		'Фиксирует факт по документу: `agreed` — согласован, `approved` — утверждён, `in_effect` — ' +
		'введён в действие. Это три независимых факта, а не ступени одного статуса: документ бывает ' +
		'согласован и не утверждён, а день введения в действие вообще приходит из договора.\n\n' +
		'Каждый факт ставится **один раз**: повтор отвечает 409, снять отметку нельзя вовсе — ' +
		'исправленный документ заводят новой редакцией, и отметки ей ставят заново. День (`at`) ' +
		'можно назвать задним числом, от дня появления документа в системе до сегодняшнего по ' +
		'московскому календарю; без него отметка встаёт текущим моментом. Необязательный `note` — ' +
		'чем отметка объясняется: номер протокола, кто подписал экземпляр. Он виден в карточке ' +
		'документа и в журнал действий не попадает.\n\n' +
		'Если документ приложен к взаимодействию, отметка ещё и **подтверждает стадию**, которая её ' +
		'ждёт (`requiresDocumentMark` в описании процесса): подтверждение ставится той же ' +
		'транзакцией, а взаимодействие движок никуда не двигает — переход остаётся решением ' +
		'сотрудника. ' +
		'Документ вне области доступа владельца ключа отвечает 404, а не отказом. ' +
		'Повтор с тем же `Idempotency-Key` возвращает прежний ответ и второй отметки не ставит.',
	tags: ['Документы'],
	config: documentMarksEndpoint,
	bodyExample: { fact: 'approved', at: '2026-09-17', note: 'Протокол учёного совета № 14' },
	example: {
		id: 'e4f5a6b7-c8d9-4e0f-9a1b-2c3d4e5f6a7b',
		title: 'Соглашение о сотрудничестве',
		interactionId: 'a3f1c2d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
		agreedAt: '2026-09-16T07:00:00.000Z',
		approvedAt: '2026-09-16T21:00:00.000Z',
		inEffectAt: null,
		agreedNote: null,
		approvedNote: 'Протокол учёного совета № 14',
		inEffectNote: null
	}
});

export const POST: RequestHandler = apiHandler(
	documentMarksEndpoint,
	async (ctx, { params, body }) => {
		const marked = await markDocument(
			ctx,
			params.id,
			body.fact,
			body.at === null ? undefined : markMomentFromDay(body.at),
			body.note
		);

		return toApiDocumentMarks(marked);
	}
);
