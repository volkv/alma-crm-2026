import { json } from '@sveltejs/kit';
import { searchQuerySchema } from '$lib/search/contract';
import { actorFromEvent } from '$lib/server/actor';
import { search } from '$lib/server/search';
import type { RequestHandler } from './$types';

/**
 * Быстрый поиск палитры: `GET /search?q=…`.
 *
 * Маршрут лежит внутри оболочки приложения, а не в `/api/v1`: это подсказка для
 * страницы, она ходит с сессией и правами того, кто её открыл, и меняться может
 * вместе с палитрой. Публичный API живёт отдельно, представляется ключом и
 * такой свободы не имеет.
 *
 * Предметных отказов у поиска нет: право на каждую группу проверяется до
 * выборки (`$lib/server/search`), а записи вне области доступа просто не
 * находятся. Поэтому ошибку сервиса здесь никто не переводит в статус — всё,
 * что может прилететь оттуда, это сбой, и он обязан выглядеть сбоем.
 */
export const GET: RequestHandler = async (event) => {
	const query = searchQuerySchema.safeParse(event.url.searchParams.get('q'));

	if (!query.success) {
		return json(
			{ error: query.error.issues.map((issue) => issue.message).join('. ') },
			{ status: 400 }
		);
	}

	return json(await search(actorFromEvent(event), query.data));
};
