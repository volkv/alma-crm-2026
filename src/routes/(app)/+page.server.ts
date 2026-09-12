import { actorFromEvent } from '$lib/server/actor';
import { toPageError } from '$lib/server/http';
import { getWorkOverview } from '$lib/server/interactions/overview';
import type { PageServerLoad } from './$types';

/**
 * Главная — это сводка рабочего дня, и собирает её один сервис: плитки, полоса
 * распределения и списки обязаны сходиться между собой, а собранные по
 * отдельности они сойтись не обязаны.
 *
 * Сводка требует права на взаимодействия: без него главная — это 403, а не
 * пятисотая. Первая страница после входа — не то место, где отказ по правам
 * должен выглядеть поломкой.
 */
export const load: PageServerLoad = async (event) => {
	try {
		return { overview: await getWorkOverview(actorFromEvent(event)) };
	} catch (cause) {
		toPageError(cause);
	}
};
