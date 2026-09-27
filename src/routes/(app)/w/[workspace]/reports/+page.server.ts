import { error } from '@sveltejs/kit';
import { columnsForMode } from '$lib/contracts/reports';
import { actorFromEvent } from '$lib/server/actor';
import { toPageError } from '$lib/server/http';
import { readFilterOptions } from '$lib/server/reports/options';
import { readReportQuery } from '$lib/server/reports/query';
import { buildReportPage } from '$lib/server/reports/rows';
import { can } from '$lib/server/rbac';
import type { PageServerLoad } from './$types';

/**
 * Отчёты пространства. Своего права у раздела нет: отчёт показывает ровно то,
 * что человек и так видит в списке взаимодействий, и отдельное право либо дало
 * бы ему лишнее, либо спрятало своё.
 *
 * Отчёт живёт внутри пространства, и пространство берётся из адреса, а не из
 * фильтра: у направлений разные процессы — свои стадии и метрики, — и
 * сквозного отчёта, складывающего их числа, нет. Незнакомый ключ и чужое
 * пространство отвечают 404 ещё в загрузчике ветки (`w/[workspace]`); сборщик
 * отчёта проверяет то же сам — его зовут и выгрузка, и машинный вызов.
 *
 * На экран уезжает страница строк, а итоги и серии диаграмм — целиком: их
 * считает база по всей выборке, а не перебор видимых пятидесяти строк, и это то
 * самое место, где отчёт и диаграмма могли бы разойтись.
 */
export const load: PageServerLoad = async (event) => {
	const ctx = actorFromEvent(event);

	// Вошёл — не значит «можно»: адрес набирают руками.
	if (!can(ctx, 'interactions.read')) {
		error(403, 'Отчёты доступны только с правом «Просмотр взаимодействий»');
	}

	const { workspace } = await event.parent();

	try {
		const query = readReportQuery(event.url, workspace.key);
		const requested = Number.parseInt(event.url.searchParams.get('page') ?? '', 10);
		const [report, options] = await Promise.all([
			buildReportPage(ctx, query, requested),
			readFilterOptions(ctx, workspace.key)
		]);

		return {
			meta: report.view.meta,
			totals: report.view.totals,
			charts: report.view.charts,
			rows: report.view.rows,
			page: report.page,
			pages: report.pages,
			pageSize: report.pageSize,
			query,
			options,
			/** Каталог колонок режима — из него собран переключатель набора. */
			available: columnsForMode(query.mode)
		};
	} catch (failure) {
		toPageError(failure);
	}
};
