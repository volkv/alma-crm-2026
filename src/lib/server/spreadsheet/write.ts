/**
 * Сборка таблицы на выдачу: книги XLS (BIFF8) и XLSX и текстовый CSV.
 *
 * BIFF8 — единственный формат `.xls`, который SheetJS пишет с кириллицей:
 * строки в нём хранятся в UTF-16. В BIFF5 и раньше текст лежит в кодовой
 * странице, и тот же вызов молча отдаёт книгу, где вместо русских букв
 * подчёркивания.
 *
 * Дата в обоих форматах собирается из частей по UTC, а не отдаётся библиотеке
 * как `Date`. SheetJS переводит `Date` в номер дня по часовому поясу процесса:
 * та же полночь UTC на сервере западнее Гринвича записывается предыдущим
 * числом. Отчёт, в котором дата зависит от `TZ` контейнера, — это отчёт, по
 * которому нельзя сверяться.
 */
import type { CellObject, WorkSheet } from 'xlsx';
import { spreadsheetText } from '../spreadsheet';
import { encodeText, type CsvDelimiter, type OutputEncoding } from './encoding';
import { SpreadsheetError } from './errors';
import { XLSX } from './sheetjs';

/** Значение ячейки на запись. */
export type SpreadsheetWriteCell = string | number | Date | null;

export type SpreadsheetColumn = {
	/** Ширина в знаках — так её задают и Excel, и LibreOffice. */
	width: number;
};

export type SpreadsheetWriteSheet = {
	name: string;
	columns?: readonly SpreadsheetColumn[];
	rows: readonly (readonly SpreadsheetWriteCell[])[];
};

/** Кодировка и метка порядка байтов у текстовой выгрузки. */
export type CsvOutput =
	/**
	 * BOM ставится только здесь и только осознанно: без него Excel открывает
	 * UTF-8 как `windows-1251` и показывает «Ð�Ñ€Ð¾Ð³Ñ€Ð°Ð¼Ð¼Ð°», а с ним
	 * файл, отданный другой системе, начинается с трёх лишних байтов.
	 */
	| { encoding: Extract<OutputEncoding, 'utf-8'>; bom: boolean }
	/** У однобайтовой кодировки метки порядка байтов не бывает. */
	| { encoding: Extract<OutputEncoding, 'windows-1251'> };

/** Начало отсчёта дней в Excel: 30.12.1899 — в нём номер 0. */
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);

const MS_IN_DAY = 86_400_000;

/**
 * Первый день, который Excel считает правильно. До 01.03.1900 его календарь
 * сдвинут на сутки: там есть 29 февраля 1900 года, которого не было. Даты
 * старше просто не пишем — сдвинутая на день дата хуже отказа.
 */
const EXCEL_FIRST_SAFE_DAY = Date.UTC(1900, 2, 1);

/** Имя листа в BIFF8: длина и запрещённые знаки — ограничение формата. */
const MAX_SHEET_NAME_LENGTH = 31;

const FORBIDDEN_SHEET_NAME_CHARS = /[[\]:*?/\\]/;

const DATE_FORMAT = 'DD.MM.YYYY';

const DATE_TIME_FORMAT = 'DD.MM.YYYY HH:MM';

function isMidnightUtc(value: Date): boolean {
	return value.getTime() % MS_IN_DAY === 0;
}

function excelSerial(value: Date, label: string): number {
	const time = value.getTime();

	if (Number.isNaN(time)) {
		throw new SpreadsheetError('unsupported_value', 'В таблицу попала недействительная дата', [
			label
		]);
	}

	if (time < EXCEL_FIRST_SAFE_DAY) {
		throw new SpreadsheetError(
			'unsupported_value',
			'Даты раньше 1 марта 1900 года таблицы показывают со сдвигом на сутки',
			[label]
		);
	}

	return (time - EXCEL_EPOCH_MS) / MS_IN_DAY;
}

function toWorkbookCell(value: SpreadsheetWriteCell, label: string): CellObject | null {
	if (value === null || value === '') {
		return null;
	}

	if (typeof value === 'number') {
		if (!Number.isFinite(value)) {
			throw new SpreadsheetError(
				'unsupported_value',
				'В таблицу попало число, которого в ней быть не может',
				[`${label}: ${value}`]
			);
		}

		return { t: 'n', v: value };
	}

	if (value instanceof Date) {
		return {
			t: 'n',
			v: excelSerial(value, label),
			z: isMidnightUtc(value) ? DATE_FORMAT : DATE_TIME_FORMAT
		};
	}

	// Обезвреживание формул — общее правило всех выгрузок продукта, см.
	// `src/lib/server/spreadsheet.ts`.
	return { t: 's', v: spreadsheetText(value) };
}

function checkSheetNames(sheets: readonly SpreadsheetWriteSheet[]): void {
	if (sheets.length === 0) {
		throw new SpreadsheetError('unsupported_value', 'В книге нет ни одного листа');
	}

	const seen = new Set<string>();

	for (const sheet of sheets) {
		if (sheet.name === '' || sheet.name.length > MAX_SHEET_NAME_LENGTH) {
			throw new SpreadsheetError(
				'unsupported_value',
				`Имя листа «${sheet.name}» не подходит для книги XLS`,
				[`Допустимая длина — от одного знака до ${MAX_SHEET_NAME_LENGTH}`]
			);
		}

		if (FORBIDDEN_SHEET_NAME_CHARS.test(sheet.name)) {
			throw new SpreadsheetError(
				'unsupported_value',
				`Имя листа «${sheet.name}» не подходит для книги XLS`,
				['В имени листа не бывает знаков [ ] : * ? / \\']
			);
		}

		if (seen.has(sheet.name)) {
			throw new SpreadsheetError('unsupported_value', `Лист «${sheet.name}» в книге не один`, [
				'Имена листов в книге различаются'
			]);
		}

		seen.add(sheet.name);
	}
}

function buildWorksheet(sheet: SpreadsheetWriteSheet): WorkSheet {
	const data: CellObject[][] = [];
	let width = 0;

	sheet.rows.forEach((row, rowIndex) => {
		const cells: CellObject[] = [];

		row.forEach((value, column) => {
			const cell = toWorkbookCell(value, `лист «${sheet.name}», строка ${rowIndex + 1}`);

			// Пустые ячейки остаются дырами массива: их пропускает и запись BIFF,
			// и тогда в файле не окажется пустых строковых ячеек, которые Excel
			// показывает как «значение есть, но его не видно».
			if (cell !== null) {
				cells[column] = cell;
			}
		});

		width = Math.max(width, row.length);
		data[rowIndex] = cells;
	});

	const worksheet: WorkSheet = {
		'!data': data,
		'!ref': XLSX.utils.encode_range({
			s: { r: 0, c: 0 },
			e: { r: Math.max(sheet.rows.length, 1) - 1, c: Math.max(width, 1) - 1 }
		})
	};

	if (sheet.columns !== undefined) {
		worksheet['!cols'] = sheet.columns.map((column) => ({ wch: column.width }));
	}

	return worksheet;
}

/**
 * Книга в выбранном формате. Ограничения на имена листов у BIFF8 и у OOXML
 * одинаковы, ячейки собираются одним и тем же кодом, и различие ровно одно —
 * какой файл попросить у библиотеки.
 */
function writeWorkbook(
	sheets: readonly SpreadsheetWriteSheet[],
	bookType: 'biff8' | 'xlsx',
	label: string
): Buffer {
	checkSheetNames(sheets);

	const workbook = XLSX.utils.book_new();

	for (const sheet of sheets) {
		XLSX.utils.book_append_sheet(workbook, buildWorksheet(sheet), sheet.name);
	}

	// `write` объявлен как `any`: проверяем то, что он на самом деле вернул, а не
	// то, что мы у него попросили.
	const output: unknown = XLSX.write(workbook, { type: 'buffer', bookType });

	if (!Buffer.isBuffer(output)) {
		throw new SpreadsheetError('unsupported_value', `Книга ${label} не собралась`, [
			`Вместо файла получили ${typeof output}`
		]);
	}

	return output;
}

/** Книга `.xls` в формате BIFF8. */
export function writeXls(sheets: readonly SpreadsheetWriteSheet[]): Buffer {
	return writeWorkbook(sheets, 'biff8', 'XLS');
}

/**
 * Книга `.xlsx`. Пишется тем же модулем, что и `.xls`, намеренно: две выгрузки
 * одних и тех же строк обязаны совпадать до ячейки, а два писателя на разных
 * библиотеках расходятся на первом же значении, которое одна из них округляет
 * или экранирует по-своему. Оформления здесь нет — ни у одной выгрузки продукта
 * оно не является требованием, а ширины колонок задаёт вызывающий.
 */
export function writeXlsx(sheets: readonly SpreadsheetWriteSheet[]): Buffer {
	return writeWorkbook(sheets, 'xlsx', 'XLSX');
}

function pad(value: number, length: number): string {
	return String(value).padStart(length, '0');
}

/**
 * Дата в тексте выгрузки — днём и месяцем по UTC, как её и записали. Время
 * показывается, только если оно в значении есть: «12.09.2026 00:00» в колонке
 * с датами читается как «полночь», хотя времени там не было.
 */
function toCsvDate(value: Date): string {
	const day = `${pad(value.getUTCDate(), 2)}.${pad(value.getUTCMonth() + 1, 2)}.${value.getUTCFullYear()}`;

	return isMidnightUtc(value)
		? day
		: `${day} ${pad(value.getUTCHours(), 2)}:${pad(value.getUTCMinutes(), 2)}`;
}

function toCsvValue(value: SpreadsheetWriteCell): string {
	if (value === null) {
		return '';
	}

	if (value instanceof Date) {
		return toCsvDate(value);
	}

	// Дробная часть отделяется точкой — так же, как её пишет остальная выгрузка
	// продукта. Русский Excel в такой ячейке увидит текст, а не число.
	if (typeof value === 'number') {
		return String(value);
	}

	return spreadsheetText(value);
}

function toCsvField(value: SpreadsheetWriteCell, delimiter: CsvDelimiter): string {
	const text = toCsvValue(value);

	// Кавычки нужны только там, где без них строка развалится: лишние кавычки
	// вокруг каждого значения делают файл нечитаемым глазами.
	return /["\r\n]/.test(text) || text.includes(delimiter)
		? `"${text.replaceAll('"', '""')}"`
		: text;
}

/**
 * Текстовая выгрузка. Разделитель по умолчанию — точка с запятой: с ней
 * русский Excel открывает файл сразу, а не одной колонкой.
 */
export function writeCsv(
	rows: readonly (readonly SpreadsheetWriteCell[])[],
	output: CsvOutput,
	delimiter: CsvDelimiter = ';'
): Buffer {
	// Конец строки `\r\n` — так CSV пишут и Excel, и LibreOffice.
	const text = rows
		.map((row) => row.map((cell) => toCsvField(cell, delimiter)).join(delimiter))
		.join('\r\n');
	const body = encodeText(text, output.encoding);

	if (output.encoding === 'utf-8' && output.bom) {
		return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]);
	}

	return body;
}
