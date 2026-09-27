/**
 * Выгрузка отчёта по данным об обучении в книгу XLSX.
 *
 * Четыре листа отвечают на четыре вопроса: «что за период в целом», «какие
 * программы впереди и почему», «как это распределено по вузам» и «из каких
 * загрузок это сложилось». Собирается книга из готового представления
 * дашборда, а не из своих запросов: отчёт, который считает сам, рано или
 * поздно разойдётся с экраном, с которого его выгрузили.
 *
 * Два правила таблиц, из-за которых здесь не просто `addRow`:
 *
 * - **числа приезжают числами.** Строка «1 234» в ячейке не суммируется и не
 *   сортируется, а выглядит как число — то есть врёт молча;
 * - **текст обезвреживается.** Значение, начинающееся с `=`, `+`, `-` или `@`,
 *   таблица читает как формулу, и название организации из чужой выгрузки
 *   выполнится у того, кто открыл файл. Правило одно на все выгрузки продукта —
 *   `spreadsheetText` (`src/lib/server/spreadsheet.ts`).
 */
import ExcelJS from 'exceljs';
import {
	coverageShare,
	statDashboardTiles,
	STAT_PERIOD_KIND_LABELS,
	STAT_PROGRAM_GROUP_LABELS,
	STAT_SNAPSHOT_MODE_LABELS,
	STAT_SOURCE_LABELS,
	type StatDashboardView,
	type StatMeasures
} from '$lib/contracts/stats';
import {
	describeFormula,
	RANKING_FACT_LABELS,
	RANKING_FACTS,
	RANKING_FORMULA_NOTE
} from '$lib/contracts/ranking';
import { formatDate, formatDateTime, formatIsoDay } from '$lib/format';
import { spreadsheetText } from '../spreadsheet';
import { statFileMime } from './format';

/** Текст, которого может не быть: пустая ячейка вместо выдуманного значения. */
function optionalText(value: string | null): string | null {
	return value === null ? null : spreadsheetText(value);
}

export type StatsReport = {
	fileName: string;
	contentType: string;
	/** Готовая книга: ответом она уходит как есть, а в тесте читается обратно. */
	body: Uint8Array<ArrayBuffer>;
};

/**
 * Имя файла: период и день выгрузки по московскому времени — тому же, по
 * которому в продукте считаются все календарные сутки. По UTC файл, снятый
 * вечером, назывался бы вчерашним числом, и две выгрузки одного рабочего дня
 * разъехались бы по датам.
 */
export function statsReportFileName(period: { start: string; end: string }, day: string): string {
	return `Данные об обучении ${period.start} — ${period.end} на ${day}.xlsx`;
}

type Column = { header: string; width: number };

function addSheet(workbook: ExcelJS.Workbook, name: string, columns: Column[]): ExcelJS.Worksheet {
	const sheet = workbook.addWorksheet(name);

	sheet.columns = columns.map((column) => ({ header: column.header, width: column.width }));
	sheet.getRow(1).font = { bold: true };
	// Шапка остаётся на месте: отчёт листают, а не читают первые десять строк.
	sheet.views = [{ state: 'frozen', ySplit: 1 }];

	return sheet;
}

/** Показатели строки в порядке колонок отчёта. */
function measureCells(measures: StatMeasures): (number | null)[] {
	return [
		measures.applications,
		measures.enrolled,
		measures.parallelStreams,
		measures.completed,
		measures.coveragePlan,
		measures.coverageFact,
		coverageShare(measures.coveragePlan, measures.coverageFact)
	];
}

const MEASURE_COLUMNS: Column[] = [
	{ header: 'Заявки', width: 12 },
	{ header: 'Зачислено', width: 12 },
	{ header: 'Параллельные потоки', width: 20 },
	{ header: 'Завершили обучение', width: 20 },
	{ header: 'Охват, план', width: 14 },
	{ header: 'Охват, факт', width: 14 },
	{ header: 'Охват, %', width: 10 }
];

function fillSummary(workbook: ExcelJS.Workbook, view: StatDashboardView, day: string): void {
	const sheet = workbook.addWorksheet('Сводка');

	sheet.columns = [{ width: 34 }, { width: 16 }, { width: 46 }, { width: 14 }, { width: 14 }];

	const head = (label: string, value: string): void => {
		sheet.addRow([spreadsheetText(label), spreadsheetText(value)]);
	};

	head('Отчётный период', `${formatDate(view.period.start)} — ${formatDate(view.period.end)}`);
	head('Вид периода', STAT_PERIOD_KIND_LABELS[view.period.kind]);
	head(
		'Данные актуальны на',
		view.updatedAt === null ? 'подтверждённых снимков нет' : formatDateTime(view.updatedAt)
	);
	head('Отчёт выгружен', formatDate(day));
	head('Пустая ячейка', 'данных нет; ноль означает записанный в выгрузке ноль');
	sheet.addRow([]);

	const tiles = sheet.addRow(['Показатель', 'Значение', 'Пояснение']);
	tiles.font = { bold: true };

	for (const tile of statDashboardTiles(view.totals)) {
		sheet.addRow([
			spreadsheetText(tile.unit === 'percent' ? `${tile.label}, %` : tile.label),
			tile.value,
			spreadsheetText(tile.value === null ? 'нет данных' : tile.hint)
		]);

		for (const extra of tile.extra) {
			sheet.addRow([
				spreadsheetText(`    ${extra.label}`),
				extra.value,
				extra.value === null ? 'нет данных' : null
			]);
		}
	}

	sheet.addRow([]);

	const groups = sheet.addRow([
		'Группа программ',
		'Программ',
		...MEASURE_COLUMNS.map((column) => column.header)
	]);
	groups.font = { bold: true };

	for (const group of view.groups) {
		sheet.addRow([
			spreadsheetText(STAT_PROGRAM_GROUP_LABELS[group.group]),
			group.programCount,
			...measureCells(group)
		]);
	}
}

/**
 * Рейтинг программ по фактам системы. Балл обязан объясняться: рядом с ним
 * лежат сами факты, их вклад, поправка за ручной приоритет и место по одним
 * фактам, а последней строкой — формула, по которой всё это сложено, с
 * пометкой, что она — предложение, а не утверждённое правило.
 */
function fillPrograms(workbook: ExcelJS.Workbook, view: StatDashboardView): void {
	const sheet = addSheet(workbook, 'Программы', [
		{ header: 'Место', width: 8 },
		{ header: 'Место по фактам', width: 16 },
		{ header: 'Код', width: 16 },
		{ header: 'Программа', width: 44 },
		{ header: 'Балл', width: 10 },
		{ header: 'Организаций', width: 14 },
		...RANKING_FACTS.flatMap((fact) => [
			{ header: RANKING_FACT_LABELS[fact], width: 18 },
			{ header: `${RANKING_FACT_LABELS[fact]}, вклад`, width: 22 }
		]),
		{ header: 'Ручной приоритет', width: 18 },
		{ header: 'Приоритет, вклад', width: 18 }
	]);

	for (const entry of view.ranking.programs) {
		sheet.addRow([
			entry.place,
			entry.factPlace,
			spreadsheetText(entry.code),
			spreadsheetText(entry.name),
			entry.score,
			entry.organizationCount,
			...entry.components.flatMap((part) => [part.value, part.contribution]),
			entry.priority,
			entry.priorityBonus
		]);
	}

	sheet.addRow([]);
	sheet.addRow([
		spreadsheetText(`${RANKING_FORMULA_NOTE}: ${describeFormula(view.ranking.weights)}`)
	]);
}

function fillOrganizations(workbook: ExcelJS.Workbook, view: StatDashboardView): void {
	const sheet = addSheet(workbook, 'Вузы и площадки', [
		{ header: 'Организация', width: 44 },
		{ header: 'Программ', width: 12 },
		...MEASURE_COLUMNS
	]);

	for (const row of view.organizations) {
		sheet.addRow([spreadsheetText(row.organizationName), row.programCount, ...measureCells(row)]);
	}
}

function fillSources(workbook: ExcelJS.Workbook, view: StatDashboardView): void {
	const sheet = addSheet(workbook, 'Источники', [
		{ header: 'Источник', width: 18 },
		{ header: 'Режим', width: 16 },
		{ header: 'Файл', width: 40 },
		{ header: 'Загрузил', width: 26 },
		{ header: 'Подтверждён', width: 20 },
		{ header: 'Строк в периоде', width: 16 }
	]);

	for (const source of view.sources) {
		sheet.addRow([
			spreadsheetText(STAT_SOURCE_LABELS[source.source]),
			spreadsheetText(STAT_SNAPSHOT_MODE_LABELS[source.mode]),
			optionalText(source.fileName),
			optionalText(source.authorName),
			source.confirmedAt === null ? null : formatDateTime(source.confirmedAt),
			source.rowCount
		]);
	}
}

/**
 * Книга по готовому дашборду. День выгрузки передаётся отдельно, чтобы имя
 * файла проверялось без часов: «сегодня» в тесте и «сегодня» на сервере — это
 * два разных дня ровно в тот момент, когда это заметят позже всего.
 */
export async function buildStatsReport(
	view: StatDashboardView,
	day: string = formatIsoDay()
): Promise<StatsReport> {
	const workbook = new ExcelJS.Workbook();

	fillSummary(workbook, view, day);
	fillPrograms(workbook, view);
	fillOrganizations(workbook, view);
	fillSources(workbook, view);

	// `writeBuffer` объявлен через собственный `Buffer extends ArrayBuffer`
	// (см. `parse.ts`), а телу ответа нужен `Uint8Array` над обычным
	// `ArrayBuffer` — иначе книга не подходит под `BodyInit`.
	const written = (await workbook.xlsx.writeBuffer()) as ArrayBuffer;

	return {
		fileName: statsReportFileName(view.period, day),
		contentType: statFileMime('xlsx'),
		body: new Uint8Array(written)
	};
}
