import { actorFromEvent } from '$lib/server/actor';
import { readProgramMaterialForDownload } from '$lib/server/directory/program-materials';
import { contentDisposition } from '$lib/server/documents/filename';
import { openStoredFile } from '$lib/server/documents/storage';
import { toPageError } from '$lib/server/http';
import type { RequestHandler } from './$types';

/**
 * Отдаёт файл материала программы.
 *
 * Свой маршрут, а не общий `/documents/[id]/download`: материал видит всякий,
 * кто видит программу, а общий маршрут пускает к документу без взаимодействия
 * только полный доступ. Пара «программа + документ» в адресе и есть проверка:
 * отдаётся только файл, приложенный к этой программе. Заголовки — те же, что у
 * скачивания документа.
 */
export const GET: RequestHandler = async (event) => {
	const ctx = actorFromEvent(event);

	try {
		const material = await readProgramMaterialForDownload(
			ctx,
			event.params.id,
			event.params.documentId
		);
		const file = await openStoredFile(material.filePath);

		return new Response(file, {
			headers: {
				'Content-Type': material.mime,
				'Content-Length': String(material.sizeBytes),
				'Content-Disposition': contentDisposition(material.fileName),
				'Cache-Control': 'no-store',
				'X-Content-Type-Options': 'nosniff'
			}
		});
	} catch (failure) {
		toPageError(failure);
	}
};
