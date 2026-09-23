import { redirect } from '@sveltejs/kit';
import { fail, message, setError, superValidate } from 'sveltekit-superforms';
import { zod4 } from 'sveltekit-superforms/adapters';
import { resolve } from '$app/paths';
import { academicYearOf, rankingWeightsSchema } from '$lib/contracts/ranking';
import { parseStatPeriodKey, statPeriodKey } from '$lib/contracts/stats';
import { actorFromEvent } from '$lib/server/actor';
import { AppError, ForbiddenError } from '$lib/server/errors';
import { errorIssues, toActionFailure, toPageError } from '$lib/server/http';
import { can } from '$lib/server/rbac';
import { setSetting } from '$lib/server/settings';
import { getRanking, listRankingPeriods } from '$lib/server/stats/ranking';
import { formatIsoDay } from '$lib/format';
import type { Actions, PageServerLoad } from './$types';

/**
 * Рейтинг программ и направлений по фактам системы за один период.
 *
 * Период всегда в адресе: без него экран открывается на текущем учебном году,
 * и дальше рейтинг — это ссылка. Веса формулы правит тот, у кого право
 * менять настройки, прямо здесь: формула и её разложение стоят рядом, и
 * смотреть, как правка весов двигает места, удобнее не уходя со страницы.
 */
const WEIGHTS_FORM_ID = 'ranking-weights';

export const load: PageServerLoad = async (event) => {
	const ctx = actorFromEvent(event);
	const period = parseStatPeriodKey(event.url.searchParams.get('period'));

	if (period === null || period.end < period.start) {
		redirect(
			303,
			`${resolve('/(app)/data/ranking')}?period=${statPeriodKey(academicYearOf(formatIsoDay()))}`
		);
	}

	try {
		const [periods, ranking] = await Promise.all([
			listRankingPeriods(ctx),
			getRanking(ctx, period)
		]);

		// Период из адреса, которого нет в подсказке (ссылка с другого экрана),
		// всё равно показывается выбранным, а не «выберите период».
		const listed = periods.some(
			(entry) => entry.start === period.start && entry.end === period.end
		);

		return {
			periods: listed ? periods : [{ kind: 'calendar' as const, ...period }, ...periods],
			ranking,
			// Форма весов видна только тому, кто может их менять; запись всё равно
			// проверяет право сама (`setSetting`).
			canConfigure: can(ctx, 'settings.write'),
			weightsForm: await superValidate(ranking.weights, zod4(rankingWeightsSchema), {
				id: WEIGHTS_FORM_ID
			})
		};
	} catch (failure) {
		toPageError(failure);
	}
};

export const actions: Actions = {
	weights: async (event) => {
		const form = await superValidate(event.request, zod4(rankingWeightsSchema), {
			id: WEIGHTS_FORM_ID
		});

		if (!form.valid) {
			return fail(400, { form });
		}

		try {
			await setSetting(actorFromEvent(event), 'ranking_weights', form.data);
		} catch (failure) {
			// Отказ по правам — не претензия к заполнению: он уходит своим кодом.
			if (failure instanceof ForbiddenError) {
				return toActionFailure(failure);
			}

			if (failure instanceof AppError) {
				return setError(form, '', [failure.message, ...errorIssues(failure)]);
			}

			throw failure;
		}

		return message(form, 'Веса рейтинга сохранены');
	}
};
