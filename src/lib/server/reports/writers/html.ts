/**
 * Страница отчёта на печать — сводка.
 *
 * Собирается из того же объекта, что и книга: числа в PDF и числа в XLSX
 * приезжают из одного места. Но отвечает она на другой вопрос: PDF читают
 * глазами, поэтому в нём условия выборки, итоги, числа обеих диаграмм таблицами
 * и начало таблицы строк — первые `REPORT_PDF_ROWS`, с пометкой, сколько их
 * всего и где взять полную. Прежнее поведение — отказ выше потолка — снято:
 * годовой отчёт не выгружался в PDF вовсе, а «нет файла» хуже, чем «файл со
 * сводкой и честной пометкой».
 *
 * Самой диаграммы в серверном PDF нет намеренно: её рисует браузер, и картинка,
 * приехавшая с клиента, означала бы проверку чужого файла ради изображения,
 * которое и так есть на экране. Поэтому её числа печатаются таблицей.
 */
import {
	REPORT_MODE_LABELS,
	REPORT_PDF_ROWS,
	type ReportBucket,
	type ReportCell,
	type ReportFunnelChart,
	type ReportMovementChart,
	type ReportView
} from '$lib/contracts/reports';
import { formatDate, formatDateTime } from '$lib/format';

function escapeHtml(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;');
}

function cellHtml(cell: ReportCell): string {
	switch (cell.kind) {
		case 'text':
			return cell.value === null ? '' : escapeHtml(cell.value);
		case 'number':
			return cell.value === null ? '' : String(cell.value);
		case 'date':
			return cell.value === null ? '' : escapeHtml(formatDate(cell.value));
		case 'datetime':
			return cell.value === null ? '' : escapeHtml(formatDateTime(cell.value));
		case 'list':
			return escapeHtml(cell.values.join(', '));
		case 'link':
			return cell.value === null
				? ''
				: cell.url === null
					? escapeHtml(cell.value)
					: `<a href="${escapeHtml(cell.url)}">${escapeHtml(cell.value)}</a>`;
	}
}

function bucketList(title: string, buckets: readonly ReportBucket[]): string {
	if (buckets.length === 0) {
		return '';
	}

	const items = buckets
		.map((bucket) => `<li><span>${escapeHtml(bucket.label)}</span><b>${bucket.value}</b></li>`)
		.join('');

	return `<section class="summary"><h2>${escapeHtml(title)}</h2><ul>${items}</ul></section>`;
}

/**
 * Воронка таблицей — по одной на группу процесса. Заголовок называет процесс,
 * когда групп в выборке больше одной: одинаковые ключи стадий в B2B и B2C —
 * законная ситуация, и без имени процесса две строки читались бы как одна.
 */
function funnelHtml(funnel: ReportFunnelChart | null): string {
	if (funnel === null) {
		return '';
	}

	const stages = funnel.groups
		.map((group) =>
			bucketList(
				funnel.groups.length > 1
					? `Стадия на дату среза — ${group.groupName}`
					: 'Стадия на дату среза',
				group.stages
			)
		)
		.join('');

	return stages + bucketList('Закрыто за период', funnel.closed);
}

/**
 * Динамика переходов таблицей: строка — вид события, столбец — интервал оси.
 * Картинку рисует браузер, а в файл едут те же числа, из которых она нарисована.
 */
function movementTable(chart: ReportMovementChart): string {
	const head = chart.buckets
		.map((bucket) => `<th class="number">${escapeHtml(bucket.label)}</th>`)
		.join('');

	const body = chart.series
		.map(
			(series) =>
				`<tr><td>${escapeHtml(series.label)}</td>${series.values
					.map((value) => `<td class="number">${value}</td>`)
					.join('')}</tr>`
		)
		.join('');

	const migrated =
		chart.migrated === 0
			? ''
			: `<p class="rule">Перенос при изменении процесса: ${chart.migrated}. Переходом не считается и в серии не входит.</p>`;

	return `<section class="summary"><h2>Динамика переходов</h2>
		<table><thead><tr><th>Вид события</th>${head}</tr></thead><tbody>${body}</tbody></table>
		<p class="rule">${escapeHtml(chart.note)}</p>${migrated}</section>`;
}

const STYLE = `
	* { box-sizing: border-box; }
	body { font: 10px/1.4 "DejaVu Sans", Arial, sans-serif; color: #10151f; margin: 0; }
	h1 { font-size: 15px; margin: 0 0 4px; }
	h2 { font-size: 11px; margin: 12px 0 4px; }
	.rule { font-size: 9px; color: #4b5563; margin: 0 0 8px; }
	dl { display: grid; grid-template-columns: max-content 1fr; gap: 1px 10px; margin: 0 0 10px; font-size: 9px; }
	dt { color: #4b5563; }
	dd { margin: 0; }
	table { border-collapse: collapse; width: 100%; }
	thead { display: table-header-group; }
	tr { page-break-inside: avoid; }
	th, td { border: 0.5px solid #cbd5e1; padding: 3px 4px; text-align: left; vertical-align: top; }
	th { background: #eef2f7; font-weight: 600; }
	th small { display: block; font-weight: 400; color: #4b5563; }
	td.number { text-align: right; }
	a { color: #0b57d0; text-decoration: none; }
	.summary ul { list-style: none; padding: 0; margin: 0; font-size: 9px; }
	.summary li { display: flex; justify-content: space-between; border-bottom: 0.5px solid #e2e8f0; padding: 1px 0; }
	.empty { font-size: 10px; color: #4b5563; }
	.cut { font-size: 9px; color: #10151f; background: #fdf2c7; padding: 3px 5px; margin: 0 0 6px; }
`;

/** Подвал печати: нумерацию страниц подставляет сам движок печати. */
export function reportFooterHtml(): string {
	return `<!doctype html><html><head><meta charset="utf-8"><style>
		body { font: 8px "DejaVu Sans", Arial, sans-serif; color: #4b5563; width: 100%; margin: 0 0.4in; }
		.line { display: flex; justify-content: space-between; }
	</style></head><body><div class="line">
		<span>Отчёт по взаимодействиям</span>
		<span class="pageNumber"></span>/<span class="totalPages"></span>
	</div></body></html>`;
}

export function reportHtml(view: ReportView): string {
	const head = view.meta.columns
		.map(
			(column) => `<th>${escapeHtml(column.label)}<small>${escapeHtml(column.note)}</small></th>`
		)
		.join('');

	const printed = view.rows.slice(0, REPORT_PDF_ROWS);

	const body =
		printed.length === 0
			? `<tr><td colspan="${view.meta.columns.length}" class="empty">Под фильтр не попало ни одной строки</td></tr>`
			: printed
					.map(
						(row) =>
							`<tr>${row.cells
								.map(
									(cell, position) =>
										`<td${view.meta.columns[position].kind === 'number' ? ' class="number"' : ''}>${cellHtml(cell)}</td>`
								)
								.join('')}</tr>`
					)
					.join('');

	// Пометка о сокращении стоит над таблицей, а не под ней: читающий обязан
	// узнать, что строк больше, до того, как начнёт считать по видимым.
	const cut =
		printed.length < view.rows.length
			? `<p class="cut">Показаны первые ${printed.length} строк из ${view.rows.length}; полная таблица — в выгрузках XLSX и JSON по той же ссылке.</p>`
			: '';

	const totals = [
		{ label: 'Строк в отчёте', value: String(view.totals.rowCount) },
		{ label: 'Взаимодействий', value: String(view.totals.interactionCount) },
		...(view.meta.mode === 'snapshot'
			? [
					{ label: 'На паузе', value: String(view.totals.paused) },
					{ label: 'Просрочено', value: String(view.totals.overdue) }
				]
			: [])
	];

	const filters = [
		{ label: 'Режим', value: REPORT_MODE_LABELS[view.meta.mode] },
		...view.meta.filters.filter((filter) => filter.label !== 'Режим'),
		{ label: 'Область доступа', value: view.meta.scope },
		{ label: 'Отчёт собран', value: formatDateTime(view.meta.generatedAt) },
		...totals
	]
		.map((filter) => `<dt>${escapeHtml(filter.label)}</dt><dd>${escapeHtml(filter.value)}</dd>`)
		.join('');

	const summary = [
		funnelHtml(view.charts.funnel),
		view.charts.movement === null ? '' : movementTable(view.charts.movement),
		...view.charts.breakdowns.map((breakdown) => bucketList(breakdown.label, breakdown.points))
	].join('');

	return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><title>Отчёт по взаимодействиям</title><style>${STYLE}</style></head>
<body>
	<h1>Отчёт по взаимодействиям</h1>
	<p class="rule">${escapeHtml(view.meta.semantics)}</p>
	<dl>${filters}</dl>
	${cut}
	<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
	${summary}
</body></html>`;
}
