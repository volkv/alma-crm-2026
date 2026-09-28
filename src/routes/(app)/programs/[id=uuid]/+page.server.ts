import { academicYearOf, rankingPlaceOf } from '$lib/contracts/ranking';
import { formatIsoDay } from '$lib/format';
import { actorFromEvent } from '$lib/server/actor';
import { getProgram } from '$lib/server/directory/read';
import { toPageError } from '$lib/server/http';
import { can } from '$lib/server/rbac';
import { getRanking } from '$lib/server/stats/ranking';
import { createVersionAction, loadCreateVersionForm } from './create-version-form.server';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const ctx = actorFromEvent(event);

	try {
		const detail = await getProgram(ctx, event.params.id);
		// Окно версии собирается после чтения карточки: чужая или несуществующая
		// программа отказывает раньше, чем для неё готовится форма.
		const createVersion = await loadCreateVersionForm(event, ctx, detail.program.id);

		// Место в рейтинге — за текущий учебный год и только тому, кто видит
		// данные об обучении: рейтинг считается по его области доступа.
		const ranking = can(ctx, 'stats.read')
			? await getRanking(ctx, academicYearOf(formatIsoDay()))
			: null;

		return {
			...detail,
			canWrite: can(ctx, 'programs.write'),
			/** Окно «Новая версия»; `null` — менять программу нельзя. */
			createVersion,
			ranking:
				ranking === null
					? null
					: { period: ranking.period, place: rankingPlaceOf(ranking.programs, event.params.id) }
		};
	} catch (error) {
		toPageError(error);
	}
};

export const actions: Actions = {
	createVersion: createVersionAction
};
