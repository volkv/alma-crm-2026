/**
 * Страница отчёта на печать — сводка или полный отчёт.
 *
 * Собирается из того же объекта, что и книга: числа в PDF и числа в XLSX
 * приезжают из одного места. PDF читают глазами, поэтому в нём условия
 * выборки, итоги и числа обеих диаграмм таблицами, а дальше — одно из двух:
 *
 * - **сводка** печатает начало таблицы строк — первые `REPORT_PDF_ROWS`, с
 *   пометкой, сколько их всего и где взять полную;
 * - **полный** печатает всю таблицу выборки, строка в строку с итогом.
 *
 * Какой это вид, файл говорит сам — в заголовке, в шапке условий и в подвале
 * каждой страницы: распечатку сводки, принятую за полный отчёт, пересчитали бы
 * по видимым строкам и получили бы неверные числа.
 *
 * Самой диаграммы в серверном PDF нет намеренно: её рисует браузер, и картинка,
 * приехавшая с клиента, означала бы проверку чужого файла ради изображения,
 * которое и так есть на экране. Поэтому её числа печатаются таблицей.
 */
import {
	REPORT_MODE_LABELS,
	REPORT_PDF_LAYOUT_LABELS,
	REPORT_PDF_ROWS,
	type ReportBucket,
	type ReportCell,
	type ReportFunnelChart,
	type ReportMovementChart,
	type ReportPdfLayout,
	type ReportView
} from '$lib/contracts/reports';
import { formatDate, formatDateTime, pluralize } from '$lib/format';

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
 * Воронка таблицей — по одной на пространство, и заголовок всегда называет его:
 * у пространств разные процессы, числа их стадий не складываются, а одинаковые
 * ключи стадий в двух процессах законны — без имени строки читались бы как одна.
 */
function funnelHtml(funnel: ReportFunnelChart | null): string {
	if (funnel === null) {
		return '';
	}

	const stages = funnel.workspaces
		.map((workspace) =>
			bucketList(`Стадия на дату среза — ${workspace.workspaceName}`, workspace.stages)
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
	h2 { font-size: 11px; margin: 12px 0 4px; break-after: avoid; page-break-after: avoid; }
	.summary { break-inside: avoid; page-break-inside: avoid; }
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

/**
 * Сколько строк таблицы печатает одна часть полного PDF.
 *
 * Полный отчёт печатается частями и склеивается службой (`gotenberg.ts`):
 * память Chromium растёт с объёмом вёрстки быстрее, чем линейно, и таблица на
 * пять тысяч строк одним куском занимала в службе печати больше гигабайта
 * при потолке контейнера на стенде в 768 МБ (замер — `docs/reports.md`, «PDF:
 * сводка и полный отчёт»). Часть того же размера, что сводка, не требует от
 * службы больше памяти, чем сводка, которая и так печатается.
 */
export const REPORT_PDF_PART_ROWS = REPORT_PDF_ROWS;

/** Одна часть PDF: страница и её подвал. */
type ReportPdfPart = { page: string; footer: string };

/**
 * Подвал печати: нумерацию страниц подставляет сам движок печати. Идентификатор
 * отчёта и вид PDF стоят на каждой странице: распечатку разбирают по листам, и
 * лист без шапки обязан называть сборку, из которой он взят. Нумерация идёт
 * внутри части — сквозную движок не знает, — поэтому у многочастного файла
 * подвал называет и часть.
 *
 * Подвал — одна строка с явными разделителями и словом «стр.»: раскладка
 * по краям в шаблоне подвала не держалась, и номер страницы печатался вплотную
 * к идентификатору, так что «…60a1/11» читалось как часть идентификатора.
 */
function footerHtml(
	reportId: string,
	layout: ReportPdfLayout,
	part: number,
	parts: number
): string {
	const partLabel = parts > 1 ? `часть ${part} из ${parts} · ` : '';

	return `<!doctype html><html><head><meta charset="utf-8"><style>
		body { font: 8px "DejaVu Sans", Arial, sans-serif; color: #4b5563; margin: 0 0.4in; }
	</style></head><body><div>Отчёт по взаимодействиям · ${REPORT_PDF_LAYOUT_LABELS[layout].toLowerCase()} · ${escapeHtml(reportId)} · ${partLabel}стр. <span class="pageNumber"></span> из <span class="totalPages"></span></div></body></html>`;
}

/** Сколько строк таблицы печатает PDF этого вида. */
function pdfRowCount(view: ReportView, layout: ReportPdfLayout): number {
	return layout === 'full' ? view.rows.length : Math.min(view.rows.length, REPORT_PDF_ROWS);
}

/**
 * Пометка о совпадении видов: при выборке не длиннее `REPORT_PDF_ROWS` сводка
 * печатает всю таблицу, как и полный отчёт.
 */
function sameContentNote(rowCount: number): string {
	return `В выборке ${pluralize(rowCount, ['строка', 'строки', 'строк'])} — не больше ${REPORT_PDF_ROWS}, поэтому сводка и полный PDF содержат одно и то же.`;
}

/** Вид PDF словами — для заголовка и шапки условий. */
function layoutNote(view: ReportView, layout: ReportPdfLayout): string {
	const printed = pdfRowCount(view, layout);

	if (layout === 'full') {
		return `Полный отчёт — вся таблица выборки, строк: ${printed}`;
	}

	return printed < view.rows.length
		? `Сводка — итоги и начало таблицы, строк: ${printed} из ${view.rows.length}`
		: `Сводка — итоги и вся таблица выборки, строк: ${printed}`;
}

function rowsHtml(view: ReportView, rows: ReportView['rows']): string {
	return rows
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
}

/** Шапка отчёта: заголовок, правило семантики, условия выборки и итоги. */
function headerHtml(view: ReportView, layout: ReportPdfLayout): string {
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
		{ label: 'Идентификатор отчёта', value: view.meta.reportId },
		{ label: 'Отчёт собран', value: formatDateTime(view.meta.generatedAt) },
		{ label: 'Вид PDF', value: layoutNote(view, layout) },
		{ label: 'Режим', value: REPORT_MODE_LABELS[view.meta.mode] },
		...view.meta.filters.filter((filter) => filter.label !== 'Режим'),
		{ label: 'Область доступа', value: view.meta.scope },
		...totals
	]
		.map((filter) => `<dt>${escapeHtml(filter.label)}</dt><dd>${escapeHtml(filter.value)}</dd>`)
		.join('');

	const printed = pdfRowCount(view, layout);

	// Пометка о сокращении стоит над таблицей, а не под ней: читающий обязан
	// узнать, что строк больше, до того, как начнёт считать по видимым.
	// Выборка не длиннее сводки — сводка и полный PDF печатают одно и то же.
	// Без пометки два файла с разными названиями ищут друг в друге разницу.
	const cut =
		printed < view.rows.length
			? `<p class="cut">Показаны первые ${printed} строк из ${view.rows.length}; вся таблица — в полном PDF и в выгрузках XLSX и JSON по той же ссылке.</p>`
			: view.rows.length <= REPORT_PDF_ROWS
				? `<p class="rule">${escapeHtml(sameContentNote(view.rows.length))}</p>`
				: '';

	return `<h1>Отчёт по взаимодействиям — ${REPORT_PDF_LAYOUT_LABELS[layout].toLowerCase()}</h1>
	<p class="rule">${escapeHtml(view.meta.semantics)}</p>
	<dl>${filters}</dl>
	${cut}`;
}

/** Числа диаграмм таблицами — после таблицы строк, в последней части. */
function chartsHtml(view: ReportView): string {
	return [
		funnelHtml(view.charts.funnel),
		view.charts.movement === null ? '' : movementTable(view.charts.movement),
		...view.charts.breakdowns.map((breakdown) => bucketList(breakdown.label, breakdown.points))
	].join('');
}

/**
 * PDF отчёта частями. Сводка — всегда одна часть. Полный отчёт режется по
 * `REPORT_PDF_PART_ROWS` строк: шапка с условиями — в первой части, числа
 * диаграмм — в последней, заголовок таблицы — в каждой. Части склеиваются в
 * этом же порядке, и строки в склеенном файле идут подряд, как в выборке.
 */
export function reportPdfParts(view: ReportView, layout: ReportPdfLayout): ReportPdfPart[] {
	const head = view.meta.columns
		.map(
			(column) => `<th>${escapeHtml(column.label)}<small>${escapeHtml(column.note)}</small></th>`
		)
		.join('');

	const printed = view.rows.slice(0, pdfRowCount(view, layout));
	const chunks: ReportView['rows'][] = [];

	for (let start = 0; start < printed.length; start += REPORT_PDF_PART_ROWS) {
		chunks.push(printed.slice(start, start + REPORT_PDF_PART_ROWS));
	}

	if (chunks.length === 0) {
		chunks.push([]);
	}

	const title = `Отчёт по взаимодействиям — ${REPORT_PDF_LAYOUT_LABELS[layout].toLowerCase()}`;

	return chunks.map((rows, index) => {
		const first = index === 0;
		const last = index === chunks.length - 1;
		const body =
			rows.length === 0
				? `<tr><td colspan="${view.meta.columns.length}" class="empty">Под фильтр не попало ни одной строки</td></tr>`
				: rowsHtml(view, rows);

		const page = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><title>${title}</title><style>${STYLE}</style></head>
<body>
	${first ? headerHtml(view, layout) : ''}
	<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
	${last ? chartsHtml(view) : ''}
</body></html>`;

		return {
			page,
			footer: footerHtml(view.meta.reportId, layout, index + 1, chunks.length)
		};
	});
}
