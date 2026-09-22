import { redirect } from '@sveltejs/kit';
import { actorFromEvent } from '$lib/server/actor';
import { chooseWorkspaceForWork } from '$lib/server/interactions/read';
import { listPath } from '../w/[workspace]/interactions/filters';
import type { RequestHandler } from './$types';

/**
 * Прежний адрес списка — перенаправление в пространство.
 *
 * Выбор «где у этого человека работа» остался тем же, каким он был у доски, но
 * живёт теперь в одном месте и срабатывает однократно: он решает, куда отвести,
 * а не подменяет содержимое экрана при каждом заходе. Дальше в адресной строке
 * стоит ключ пространства, и ссылка, скопированная оттуда, у коллеги открывает
 * то же самое.
 *
 * Обработчик, а не страница: экрана здесь нет и быть не должно — ни в реестре
 * подсказок, ни в обходе системы. Ради старых ссылок и закладок: их разослано
 * письмами и задачами столько, что ломать их ради красоты маршрутов незачем.
 */
export const GET: RequestHandler = async (event) => {
	const workspace = await chooseWorkspaceForWork(actorFromEvent(event));

	if (workspace === null) {
		redirect(307, '/');
	}

	redirect(307, `${listPath(workspace.key)}${event.url.search}`);
};
