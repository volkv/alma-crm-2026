import { actorFromEvent } from '$lib/server/actor';
import { readDocumentForDownload } from '$lib/server/documents/read';
import { contentDisposition } from '$lib/server/documents/filename';
import { openStoredFile } from '$lib/server/documents/storage';
import { toPageError } from '$lib/server/http';
import type { RequestHandler } from './$types';

/**
 * Отдаёт файл документа.
 *
 * Маршрут лежит не в `/api`, а внутри оболочки приложения, потому что это
 * ссылка со страницы, а не операция публичного API: сюда приходят с сессионной
 * кукой, и отвечать надо страницей ошибки, а не JSON. Поэтому и предметную
 * ошибку переводит тот же `toPageError`, что и загрузчики страниц.
 *
 * Файл читается потоком из хранилища: класть документ на 25 МиБ целиком в
 * память ради того, чтобы тут же отдать его в сокет, незачем.
 */
export const GET: RequestHandler = async (event) => {
	const ctx = actorFromEvent(event);

	try {
		const download = await readDocumentForDownload(ctx, event.params.id);
		const file = await openStoredFile(download.filePath);

		return new Response(file, {
			headers: {
				'Content-Type': download.document.mime,
				'Content-Length': String(download.sizeBytes),
				'Content-Disposition': contentDisposition(download.fileName),
				// Документы бывают персональными и конфиденциальными: ни браузеру,
				// ни промежуточному кэшу их хранить нельзя.
				'Cache-Control': 'no-store',
				// Тип файла задаём мы, и подбирать его по содержимому браузер не должен.
				'X-Content-Type-Options': 'nosniff'
			}
		});
	} catch (failure) {
		toPageError(failure);
	}
};
