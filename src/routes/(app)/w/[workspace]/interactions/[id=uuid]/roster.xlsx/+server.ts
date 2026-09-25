import { error } from '@sveltejs/kit';
import { DOCUMENT_FORMAT_MIME_TYPES } from '$lib/contracts/documents';
import { learningGroupRosterSchema } from '$lib/contracts/exchange';
import { actorFromEvent } from '$lib/server/actor';
import { contentDisposition } from '$lib/server/documents/filename';
import { toPageError } from '$lib/server/http';
import { exportLearningGroupRoster } from '$lib/server/integrations/exchange/roster';
import type { RequestHandler } from './$types';

/**
 * Список слушателей одного потока — книгой по шаблону загрузки пользователей
 * в систему обучения.
 *
 * Маршрут лежит внутри оболочки приложения, а не в `/api`: это ссылка из
 * диалога «Слушатели потока», сюда приходят с сессионной кукой, а отказ
 * рисуется страницей ошибки, как у приглашения на встречу. Поток — параметр
 * `group`: одна выгрузка — одна группа, как и сам диалог. Права, область и
 * отозванные согласия проверяет сервис списка, а не маршрут.
 */
export const GET: RequestHandler = async (event) => {
	const ctx = actorFromEvent(event);
	const input = learningGroupRosterSchema.safeParse({
		interactionId: event.params.id,
		learningGroupId: event.url.searchParams.get('group')
	});

	// Испорченный параметр адреса — не предметная ошибка: до сервиса такой
	// запрос не доходит.
	if (!input.success) {
		error(400, 'Укажите поток, список которого выгрузить');
	}

	try {
		const file = await exportLearningGroupRoster(ctx, input.data);

		return new Response(file.body, {
			headers: {
				'Content-Type': DOCUMENT_FORMAT_MIME_TYPES.xlsx,
				'Content-Disposition': contentDisposition(file.fileName),
				// Книга несёт почту и телефоны слушателей: ни браузеру, ни кэшу её
				// не хранить.
				'Cache-Control': 'no-store',
				'X-Content-Type-Options': 'nosniff'
			}
		});
	} catch (failure) {
		toPageError(failure);
	}
};
