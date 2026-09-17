import { error } from '@sveltejs/kit';
import { REPORT_PAGE_SIZE, columnsForMode } from '$lib/contracts/reports';
import { actorFromEvent } from '$lib/server/actor';
import { toPageError } from '$lib/server/http';
import { readFilterOptions } from '$lib/server/reports/options';
import { readReportQuery } from '$lib/server/reports/query';
import { buildReport } from '$lib/server/reports/rows';
import { can } from '$lib/server/rbac';
import type { PageServerLoad } from './$types';

/**
 * Раздел отчётов. Своего права у него нет: отчёт показывает ровно то, что
 * человек и так видит в списке взаимодействий, и отдельное право либо дало бы
 * ему лишнее, либо спрятало своё.
 *
 * На экран уезжает страница строк, а итоги и серии диаграмм — целиком: они
 * посчитаны по всей выборке, а не по видимым пятидесяти строкам, и это то самое
 * место, где отчёт и диаграмма могли бы разойтись.
 */
export const load: PageServerLoad = async (event) => {
	const ctx = actorFromEvent(event);

	// Вошёл — не значит «можно»: адрес набирают руками.
	if (!can(ctx, 'interactions.read')) {
		error(403, 'Отчёты доступны только с правом «Просмотр взаимодействий»');
	}

	try {
		const query = readReportQuery(event.url);
		const [view, options] = await Promise.all([buildReport(ctx, query), readFilterOptions(ctx)]);

		const requested = Number.parseInt(event.url.searchParams.get('page') ?? '', 10);
		const pages = Math.max(1, Math.ceil(view.rows.length / REPORT_PAGE_SIZE));
		const page = Number.isInteger(requested) && requested >= 1 ? Math.min(requested, pages) : 1;
		const offset = (page - 1) * REPORT_PAGE_SIZE;

		return {
			meta: view.meta,
			totals: view.totals,
			charts: view.charts,
			rows: view.rows.slice(offset, offset + REPORT_PAGE_SIZE),
			page,
			pages,
			pageSize: REPORT_PAGE_SIZE,
			query,
			options,
			/** Каталог колонок режима — из него собран переключатель набора. */
			available: columnsForMode(query.mode)
		};
	} catch (failure) {
		toPageError(failure);
	}
};
