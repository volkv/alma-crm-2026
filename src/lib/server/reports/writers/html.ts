/**
 * Страница отчёта на печать.
 *
 * Собирается из того же объекта, что и книга: числа в PDF и числа в XLSX
 * приезжают из одного места. Диаграммы в серверном PDF нет намеренно — её
 * рисует браузер, и картинка, приехавшая с клиента, означала бы проверку
 * чужого файла ради изображения, которое и так есть на экране.
 */
import {
	REPORT_MODE_LABELS,
	type ReportBucket,
	type ReportCell,
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

	const body =
		view.rows.length === 0
			? `<tr><td colspan="${view.meta.columns.length}" class="empty">Под фильтр не попало ни одной строки</td></tr>`
			: view.rows
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

	const filters = [
		{ label: 'Режим', value: REPORT_MODE_LABELS[view.meta.mode] },
		...view.meta.filters.filter((filter) => filter.label !== 'Режим'),
		{ label: 'Область доступа', value: view.meta.scope },
		{ label: 'Отчёт собран', value: formatDateTime(view.meta.generatedAt) },
		{ label: 'Строк в отчёте', value: String(view.totals.rowCount) }
	]
		.map((filter) => `<dt>${escapeHtml(filter.label)}</dt><dd>${escapeHtml(filter.value)}</dd>`)
		.join('');

	const summary = [
		view.charts.funnel === null
			? ''
			: bucketList('Стадия на дату среза', view.charts.funnel.stages) +
				bucketList('Закрыто за период', view.charts.funnel.closed),
		...view.charts.breakdowns.map((breakdown) => bucketList(breakdown.label, breakdown.points))
	].join('');

	return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><title>Отчёт по взаимодействиям</title><style>${STYLE}</style></head>
<body>
	<h1>Отчёт по взаимодействиям</h1>
	<p class="rule">${escapeHtml(view.meta.semantics)}</p>
	<dl>${filters}</dl>
	<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
	${summary}
</body></html>`;
}
