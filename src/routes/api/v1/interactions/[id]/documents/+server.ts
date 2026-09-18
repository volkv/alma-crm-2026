import { z } from 'zod';
import type { RequestHandler } from './$types';
import { apiDocumentSchema, apiPageSchema, toApiDocument } from '$lib/contracts/api';
import { id } from '$lib/contracts/common';
import { documentListQuerySchema } from '$lib/contracts/documents';
import { apiHandler, type ApiEndpointConfig } from '$lib/server/api/handler';
import { registerRoute } from '$lib/server/api/openapi';
import { assertInteractionAccessible, listDocuments } from '$lib/server/documents/read';

/** Взаимодействие задано адресом: тем же фильтром из строки запроса его не подменить. */
const interactionDocumentsQuery = documentListQuerySchema.omit({ interactionId: true });

const interactionDocumentsEndpoint = {
	auth: 'key',
	params: z.object({ id: id('Некорректный идентификатор взаимодействия') }),
	query: interactionDocumentsQuery,
	output: apiPageSchema(apiDocumentSchema),
	permission: 'documents.read'
} satisfies ApiEndpointConfig;

registerRoute({
	method: 'get',
	path: '/v1/interactions/{id}/documents',
	summary: 'Документы взаимодействия',
	description:
		'Метаданные файлов: название, вид, формат, размер, отметки «согласован», «утверждён», ' +
		'«вступил в силу» и ссылка на редакцию, которая файл заменила. По умолчанию отдаются только ' +
		'действующие редакции — `revisions=all` показывает и заменённые.\n\n' +
		'**Содержимого файла здесь нет.** Документы соглашений скачивают люди из интерфейса, где ' +
		'каждое скачивание ложится в журнал отдельной строкой; машине отдаётся только вложение ' +
		'обмена и только по маршруту обмена.',
	tags: ['Документы'],
	config: interactionDocumentsEndpoint,
	example: {
		items: [
			{
				id: 'e4f5a6b7-c8d9-4e0f-9a1b-2c3d4e5f6a7b',
				title: 'Соглашение о сотрудничестве',
				kind: 'generated',
				uploadedKind: null,
				mime: 'application/pdf',
				sizeBytes: 148213,
				createdAt: '2026-09-16T10:12:00.000Z',
				agreedAt: '2026-09-17T08:00:00.000Z',
				approvedAt: null,
				inEffectAt: null,
				interactionId: 'a3f1c2d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
				authorName: 'Иванова Мария',
				supersededById: null,
				supersededAt: null
			}
		],
		total: 1,
		page: 1,
		pageSize: 20
	}
});

export const GET: RequestHandler = apiHandler(
	interactionDocumentsEndpoint,
	async (ctx, { params, query }) => {
		// Сначала само взаимодействие: список документов чужой записи иначе
		// отвечал бы пустой страницей, и «файлов нет» было бы неотличимо от
		// «записи нет». Отказ здесь такой же, как у карточки, — 404.
		await assertInteractionAccessible(ctx, params.id);

		const result = await listDocuments(ctx, { ...query, interactionId: params.id });

		return { ...result, items: result.items.map(toApiDocument) };
	}
);
