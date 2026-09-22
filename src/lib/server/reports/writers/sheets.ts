/**
 * Три листа книги отчёта — общие у `.xlsx` и `.xls`.
 *
 * «Отчёт» отвечает на вопрос, «Фильтры» — на вопрос «что это за числа», а
 * «Сводка» повторяет то, что показано диаграммами. Лист фильтров обязателен:
 * файл живёт дальше сам по себе, и без режима, периода и области доступа его
 * числа читаются двумя способами.
 *
 * Писатель не ходит в базу и ничего не пересчитывает — он переводит готовый
 * объект отчёта в ячейки. Отчёт, который считает сам, однажды разойдётся с
 * экраном, с которого его выгрузили.
 */
import { MOSCOW_OFFSET_MS } from '$lib/contracts/calendar';
import {
	REPORT_COLUMNS,
	REPORT_MODE_LABELS,
	type ReportBucket,
	type ReportCell,
	type ReportColumnKey,
	type ReportView
} from '$lib/contracts/reports';
import { formatDateTime } from '$lib/format';
import type { SpreadsheetWriteCell, SpreadsheetWriteSheet } from '../../spreadsheet/write';

// Момент в книге пишется стенными часами Москвы: SheetJS хранит дату числом
// дней и часовой пояс в файле не держит, поэтому несдвинутый момент читался бы
// как время по Гринвичу — то есть на три часа раньше того, что человек видел на
// экране. Смещение берётся из общего календаря: числа файла и числа экрана
// обязаны сходиться.

/** Заголовок колонки вместе с пометкой сорта: «Стадия (на 31.12.2026)». */
function headerLabel(label: string, note: string): string {
	return `${label} (${note})`;
}

function toWriteCell(cell: ReportCell): SpreadsheetWriteCell {
	switch (cell.kind) {
		case 'text':
			return cell.value;
		case 'number':
			return cell.value;
		case 'date':
			// Календарный день записывается полуночью по Гринвичу: так писатель
			// узнаёт в нём дату без времени и ставит формат ДД.ММ.ГГГГ.
			return cell.value === null ? null : new Date(`${cell.value}T00:00:00.000Z`);
		case 'datetime':
			return cell.value === null
				? null
				: new Date(new Date(cell.value).getTime() + MOSCOW_OFFSET_MS);
		case 'list':
			return cell.values.length === 0 ? null : cell.values.join(', ');
		case 'link':
			return cell.value;
	}
}

/** Адрес карточки из ячейки-ссылки; у остальных ячеек адреса нет. */
function cellUrl(cell: ReportCell): string | null {
	return cell.kind === 'link' ? cell.url : null;
}

function reportSheet(view: ReportView): SpreadsheetWriteSheet {
	const header = [
		...view.meta.columns.map((column) => headerLabel(column.label, column.note)),
		'Адрес карточки'
	];

	const rows = view.rows.map((row) => [
		...row.cells.map(toWriteCell),
		// Ссылка пишется текстом адреса в отдельной колонке: писатель книг умеет
		// ячейку `string | number | Date | null` и гиперссылок не ставит, а второй
		// писатель ради одной колонки дороже, чем видимый адрес.
		row.cells.map(cellUrl).find((url) => url !== null) ?? null
	]);

	return {
		name: 'Отчёт',
		columns: [
			...view.meta.columns.map((column) => ({ width: columnWidth(column.key) })),
			{ width: 52 }
		],
		rows: [header, ...rows]
	};
}

/** Ширины берутся из каталога колонок — он же задаёт их порядок. */
const WIDTHS = new Map<ReportColumnKey, number>(
	REPORT_COLUMNS.map((column) => [column.key, column.width])
);

function columnWidth(key: ReportColumnKey): number {
	return WIDTHS.get(key) ?? 20;
}

function filtersSheet(view: ReportView): SpreadsheetWriteSheet {
	const rows: SpreadsheetWriteCell[][] = [
		['Показатель', 'Значение'],
		['Режим', REPORT_MODE_LABELS[view.meta.mode]],
		...view.meta.filters.map((filter): SpreadsheetWriteCell[] => [filter.label, filter.value]),
		['Область доступа', view.meta.scope],
		['Отчёт собран', formatDateTime(view.meta.generatedAt)],
		['Строк в отчёте', view.totals.rowCount],
		['Взаимодействий в выборке', view.totals.interactionCount],
		[],
		['Правило', view.meta.semantics]
	];

	return { name: 'Фильтры', columns: [{ width: 28 }, { width: 96 }], rows };
}

function bucketRows(title: string, buckets: readonly ReportBucket[]): SpreadsheetWriteCell[][] {
	return [[title, 'Значение'], ...buckets.map((bucket) => [bucket.label, bucket.value])];
}

function summarySheet(view: ReportView): SpreadsheetWriteSheet {
	const rows: SpreadsheetWriteCell[][] = [];

	if (view.charts.funnel !== null) {
		const funnel = view.charts.funnel;

		// Воронка своя у каждого пространства: одинаковые ключи стадий в B2B и
		// B2C законны, и в одном списке две разные стадии слились бы в одну строку.
		for (const workspace of funnel.workspaces) {
			rows.push(
				...bucketRows(
					funnel.workspaces.length > 1
						? `Стадия на дату среза — ${workspace.workspaceName}`
						: 'Стадия на дату среза',
					workspace.stages
				)
			);
			rows.push([]);
		}

		rows.push(...bucketRows('Закрыто за период', funnel.closed));
		rows.push([]);
		rows.push(['В том числе на паузе', view.totals.paused]);
		rows.push(['В том числе просрочено', view.totals.overdue]);
		rows.push([]);
	}

	if (view.charts.movement !== null) {
		const movement = view.charts.movement;

		rows.push([
			movement.step === 'week' ? 'Неделя с' : 'Месяц',
			...movement.series.map((series) => series.label)
		]);

		movement.buckets.forEach((bucket, position) => {
			rows.push([bucket.label, ...movement.series.map((series) => series.values[position])]);
		});

		rows.push([]);
		rows.push(['Перенос при изменении процесса', movement.migrated]);
		rows.push([]);
	}

	for (const breakdown of view.charts.breakdowns) {
		rows.push(...bucketRows(breakdown.label, breakdown.points));

		if (breakdown.doubleCounted > 0) {
			rows.push([
				'Учтено дважды и более',
				breakdown.doubleCounted,
				'сумма по строкам больше числа строк отчёта'
			]);
		}

		rows.push([]);
	}

	return { name: 'Сводка', columns: [{ width: 40 }, { width: 14 }, { width: 52 }], rows };
}

/** Три листа книги в том порядке, в каком их открывают. */
export function reportSheets(view: ReportView): SpreadsheetWriteSheet[] {
	return [reportSheet(view), filtersSheet(view), summarySheet(view)];
}
