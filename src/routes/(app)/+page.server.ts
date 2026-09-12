import { actorFromEvent } from '$lib/server/actor';
import { getWorkOverview } from '$lib/server/interactions/overview';
import type { PageServerLoad } from './$types';

/**
 * Главная — это сводка рабочего дня, и собирает её один сервис: плитки, полоса
 * распределения и списки обязаны сходиться между собой, а собранные по
 * отдельности они сойтись не обязаны.
 */
export const load: PageServerLoad = async (event) => ({
	overview: await getWorkOverview(actorFromEvent(event))
});
