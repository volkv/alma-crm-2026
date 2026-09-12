import { redirect } from '@sveltejs/kit';
import { resolve } from '$app/paths';
import { readTableQuery } from '$lib/components/data-table/query';
import {
	parseStatPeriodKey,
	statPeriodKey,
	STAT_DASHBOARD_SORT_KEYS,
	type StatDashboardOrganizationRow,
	type StatDashboardSortKey
} from '$lib/contracts/stats';
import { actorFromEvent } from '$lib/server/actor';
import { toPageError } from '$lib/server/http';
import { can } from '$lib/server/rbac';
import { getStatsDashboard } from '$lib/server/stats/dashboard';
import { listPeriods } from '$lib/server/stats/read';
import type { PageServerLoad } from './$types';

/**
 * Дашборд портфеля данных за один отчётный период.
 *
 * Период всегда стоит в адресе, даже когда его не выбирали: дашборд без
 * периода пришлось бы или считать по всем периодам сразу (а они не
 * складываются — одни и те же обучающиеся посчитались бы дважды), или
 * показывать пустым. Поэтому обращение без периода уводит на последний, по
 * которому есть данные, и дальше экран — это ссылка.
 */

/** Сколько программ показывает дашборд: это верхушка рейтинга, а не отчёт. */
const TOP_PROGRAMS = 5;

/** Порядок по умолчанию: распределение открывают ради самых больших чисел. */
const DEFAULT_SORT: StatDashboardSortKey = 'enrolled';

function sortKeyOf(raw: string | null): StatDashboardSortKey {
	return STAT_DASHBOARD_SORT_KEYS.includes(raw as StatDashboardSortKey)
		? (raw as StatDashboardSortKey)
		: DEFAULT_SORT;
}

function sortValue(row: StatDashboardOrganizationRow, key: StatDashboardSortKey): number | null {
	switch (key) {
		case 'programs':
			return row.programCount;
		case 'applications':
			return row.applications;
		case 'enrolled':
			return row.enrolled;
		case 'coverage':
			return row.coveragePlan === null || row.coverageFact === null || row.coveragePlan === 0
				? null
				: row.coverageFact / row.coveragePlan;
		case 'organization':
			return null;
	}
}

/**
 * Порядок строк распределения. Строки без данных уходят вниз при любом
 * направлении: «нет данных» наверху списка «самых больших» читалось бы как
 * рекорд.
 */
function sortOrganizations(
	rows: readonly StatDashboardOrganizationRow[],
	key: StatDashboardSortKey,
	direction: 'asc' | 'desc'
): StatDashboardOrganizationRow[] {
	const sign = direction === 'desc' ? -1 : 1;

	return [...rows].sort((left, right) => {
		if (key !== 'organization') {
			const a = sortValue(left, key);
			const b = sortValue(right, key);

			if (a === null || b === null) {
				if (a !== b) {
					return a === null ? 1 : -1;
				}
			} else if (a !== b) {
				return (a - b) * sign;
			}
		}

		// Последний ключ — название: у равных чисел порядок не должен зависеть
		// от того, в каком порядке их вернула база.
		return left.organizationName.localeCompare(right.organizationName) * sign;
	});
}

function samePeriod(left: { start: string; end: string }, right: { start: string; end: string }) {
	return left.start === right.start && left.end === right.end;
}

export const load: PageServerLoad = async (event) => {
	const ctx = actorFromEvent(event);
	const requested = parseStatPeriodKey(event.url.searchParams.get('period'));
	const table = readTableQuery(event.url);
	const sortBy = sortKeyOf(table.sortBy);
	const sortDirection = table.sortBy === null ? 'desc' : table.sortDirection;

	try {
		const periods = await listPeriods(ctx);

		if (periods.length === 0) {
			return {
				periods,
				dashboard: null,
				topPrograms: [],
				organizations: [],
				sortBy,
				sortDirection,
				canImport: can(ctx, 'stats.import')
			};
		}

		const period =
			periods.find((entry) => requested !== null && samePeriod(entry, requested)) ?? null;

		// Период в адресе испорчен, не назван или по нему нет данных: дашборд
		// открывается на последнем, а не на пустом экране. Перенаправление летит
		// сквозь `toPageError` — оно не ошибка предметной области.
		if (period === null) {
			redirect(303, `${resolve('/(app)/data/dashboard')}?period=${statPeriodKey(periods[0])}`);
		}

		const dashboard = await getStatsDashboard(ctx, period);

		return {
			periods,
			dashboard,
			topPrograms: dashboard.ranking.slice(0, TOP_PROGRAMS),
			organizations: sortOrganizations(dashboard.organizations, sortBy, sortDirection),
			sortBy,
			sortDirection,
			canImport: can(ctx, 'stats.import')
		};
	} catch (failure) {
		toPageError(failure);
	}
};
