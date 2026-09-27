import { json } from '@sveltejs/kit';
import { actorFromEvent } from '$lib/server/actor';
import { readPackageDefaults } from '$lib/server/documents/package';
import { toPageError } from '$lib/server/http';
import type { RequestHandler } from './$types';

/**
 * Что подставить в форму сборки пакета дела: `GET /documents/package-defaults/<дело>`.
 *
 * Подсказка форме карточки, а не публичный API: ходит с сессией и правами того,
 * кто открыл карточку. Право на сборку и область доступа проверяет сервис;
 * его отказ становится статусом ответа, как у страницы.
 */
export const GET: RequestHandler = async (event) => {
	try {
		return json(await readPackageDefaults(actorFromEvent(event), event.params.id));
	} catch (error) {
		toPageError(error);
	}
};
