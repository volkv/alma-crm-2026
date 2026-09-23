import { redirect } from '@sveltejs/kit';
import { resolve } from '$app/paths';
import { academicYearOf } from '$lib/contracts/ranking';
import {
	groupSnapshotPeriodSchema,
	parseStatPeriodKey,
	statPeriodKey,
	type StatPeriod
} from '$lib/contracts/stats';
import { formatIsoDay } from '$lib/format';
import { actorFromEvent } from '$lib/server/actor';
import { ValidationError } from '$lib/server/errors';
import { toActionFailure, toPageError } from '$lib/server/http';
import { requirePermission } from '$lib/server/rbac';
import { buildGroupSnapshot, previewGroupSnapshot } from '$lib/server/stats/groups';
import { listRankingPeriods } from '$lib/server/stats/ranking';
import type { Actions, PageServerLoad } from './$types';

/**
 * Сборка снимка из результатов учебных групп: период → предпросмотр →
 * снимок на шаге проверки.
 *
 * Период живёт в адресе, как на остальных экранах данных: предпросмотр — это
 * ссылка «вот что попадёт за 2025/2026», которую можно показать коллеге до
 * того, как собирать. Вид периода берётся из того же списка, что предлагает
 * выбор: учебный год и календарный период с одинаковыми датами — разные
 * снимки, и угадывать вид по датам нельзя.
 */
function periodFrom(periods: readonly StatPeriod[], raw: string | null): StatPeriod | null {
	const key = parseStatPeriodKey(raw);

	return (
		periods.find(
			(period) => key !== null && period.start === key.start && period.end === key.end
		) ?? null
	);
}

export const load: PageServerLoad = async (event) => {
	const ctx = actorFromEvent(event);

	requirePermission(ctx, 'stats.import');

	try {
		const periods = await listRankingPeriods(ctx);
		const period = periodFrom(periods, event.url.searchParams.get('period'));

		if (period === null) {
			redirect(
				303,
				`${resolve('/(app)/data/collect')}?period=${statPeriodKey(academicYearOf(formatIsoDay()))}`
			);
		}

		const preview = await previewGroupSnapshot(ctx, {
			periodKind: period.kind,
			periodStart: period.start,
			periodEnd: period.end
		});

		return { periods, preview };
	} catch (failure) {
		toPageError(failure);
	}
};

export const actions: Actions = {
	build: async (event) => {
		const form = await event.request.formData();
		const parsed = groupSnapshotPeriodSchema.safeParse({
			periodKind: form.get('periodKind'),
			periodStart: form.get('periodStart'),
			periodEnd: form.get('periodEnd')
		});

		if (!parsed.success) {
			return toActionFailure(
				new ValidationError(
					'Период сборки не прошёл проверку',
					parsed.error.issues.map((issue) => issue.message)
				)
			);
		}

		let snapshotId: string;

		try {
			snapshotId = (await buildGroupSnapshot(actorFromEvent(event), parsed.data)).id;
		} catch (failure) {
			return toActionFailure(failure);
		}

		redirect(303, resolve('/(app)/data/[id=uuid]/check', { id: snapshotId }));
	}
};
