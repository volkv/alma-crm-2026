import { academicYearOf, rankingPlaceOf } from '$lib/contracts/ranking';
import { formatIsoDay } from '$lib/format';
import { actorFromEvent } from '$lib/server/actor';
import { getProgram } from '$lib/server/directory/read';
import { toPageError } from '$lib/server/http';
import { can } from '$lib/server/rbac';
import { getRanking } from '$lib/server/stats/ranking';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const ctx = actorFromEvent(event);

	try {
		const detail = await getProgram(ctx, event.params.id);

		// Место в рейтинге — за текущий учебный год и только тому, кто видит
		// данные об обучении: рейтинг считается по его области доступа.
		const ranking = can(ctx, 'stats.read')
			? await getRanking(ctx, academicYearOf(formatIsoDay()))
			: null;

		return {
			...detail,
			canWrite: can(ctx, 'programs.write'),
			ranking:
				ranking === null
					? null
					: { period: ranking.period, place: rankingPlaceOf(ranking.programs, event.params.id) }
		};
	} catch (error) {
		toPageError(error);
	}
};
