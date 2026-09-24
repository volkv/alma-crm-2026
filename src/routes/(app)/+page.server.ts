import { actorFromEvent } from '$lib/server/actor';
import { toPageError } from '$lib/server/http';
import { getMyDay } from '$lib/server/interactions/my-day';
import { getWorkOverview } from '$lib/server/interactions/overview';
import type { PageServerLoad } from './$types';

/**
 * Главная — сводка рабочего дня: «Мой день» (что требует внимания сегодня) и
 * картина портфеля. Оба блока считаются на один момент времени, чтобы числа в
 * плитках и строки списка не расходились.
 *
 * Сводка требует права на взаимодействия: без него главная — это 403, а не
 * пятисотая. Первая страница после входа — не то место, где отказ по правам
 * должен выглядеть поломкой.
 */
export const load: PageServerLoad = async (event) => {
	const ctx = actorFromEvent(event);
	const now = new Date();

	try {
		const [overview, myDay] = await Promise.all([getWorkOverview(ctx, now), getMyDay(ctx, now)]);

		return { overview, myDay };
	} catch (cause) {
		toPageError(cause);
	}
};
