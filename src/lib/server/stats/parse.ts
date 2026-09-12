/**
 * Разбор таблицы из файла.
 *
 * Наружу оба формата выглядят одинаково: шапка и строки текстовых ячеек. Это
 * и есть граница разбора — дальше работает сопоставление колонок, которому
 * безразлично, из чего таблица приехала.
 *
 * Значения не приводятся к числам и датам здесь: «12 345» в ячейке — это
 * ответ вуза, и решать, число это или ошибка, должен тот, кто знает, в какое
 * поле колонка сопоставлена. Разбор отдаёт то, что написано.
 */
import ExcelJS from 'exceljs';
import type { CellValue } from 'exceljs';
import { MAX_STAT_FILE_ROWS } from '$lib/contracts/stats';
import { ValidationError } from '../errors';

/** Форматы, которые принимает импорт. */
export const STAT_FILE_FORMATS = ['xlsx', 'csv'] as const;

export type StatFileFormat = (typeof STAT_FILE_FORMATS)[number];

/** Таблица файла: имена колонок и строки значений как есть. */
export type SheetTable = {
	headers: string[];
	/**
	 * Строки данных без шапки. Длина строки может отличаться от длины шапки:
	 * выравнивать её здесь нельзя — недостающая и лишняя ячейка это разные
	 * ошибки, и заметить их должен разбор строки, а не разбор файла.
	 */
	rows: string[][];
	/** Сколько строк данных в файле всего, даже если прочитаны не все. */
	totalRows: number;
};

/** Разделители, которые встречаются в выгрузках: точка с запятой — у русского Excel. */
const CSV_DELIMITERS = [';', ',', '\t'] as const;

/**
 * Какой разделитель в файле. Считаются только те, что вне кавычек: название
 * организации с запятой внутри кавычек — обычное дело, и голый подсчёт
 * символов принял бы такой файл за таблицу из двух колонок.
 */
function detectDelimiter(firstLine: string): string {
	let best: string = CSV_DELIMITERS[0];
	let bestCount = 0;

	for (const delimiter of CSV_DELIMITERS) {
		let count = 0;
		let quoted = false;

		for (let index = 0; index < firstLine.length; index += 1) {
			const char = firstLine[index];

			if (char === '"') {
				quoted = !quoted;
			} else if (char === delimiter && !quoted) {
				count += 1;
			}
		}

		if (count > bestCount) {
			best = delimiter;
			bestCount = count;
		}
	}

	return best;
}

/** Первая строка файла — по ней определяется разделитель. */
function firstLineOf(text: string): string {
	const end = text.indexOf('\n');

	return end === -1 ? text : text.slice(0, end).replace(/\r$/, '');
}

/**
 * Разбор CSV по RFC 4180: кавычки, удвоенная кавычка внутри значения, перевод
 * строки внутри кавычек. Своя реализация, а не библиотека: правило короткое, а
 * зависимость ради него пришлось бы объяснять.
 */
function splitCsv(text: string, delimiter: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let value = '';
	let quoted = false;

	const pushValue = () => {
		row.push(value.trim());
		value = '';
	};

	const pushRow = () => {
		pushValue();
		rows.push(row);
		row = [];
	};

	for (let index = 0; index < text.length; index += 1) {
		const char = text[index];

		if (quoted) {
			if (char !== '"') {
				value += char;
				continue;
			}

			// Удвоенная кавычка внутри значения — это одна кавычка.
			if (text[index + 1] === '"') {
				value += '"';
				index += 1;
			} else {
				quoted = false;
			}

			continue;
		}

		if (char === '"') {
			quoted = true;
		} else if (char === delimiter) {
			pushValue();
		} else if (char === '\n') {
			pushRow();
		} else if (char !== '\r') {
			value += char;
		}
	}

	// Последняя строка без перевода в конце файла — такая же строка.
	if (value !== '' || row.length > 0) {
		pushRow();
	}

	return rows;
}

/** Пустая ли строка таблицы: в выгрузках между блоками попадаются пробелы. */
function isBlankRow(row: readonly string[]): boolean {
	return row.every((cell) => cell === '');
}

/**
 * Имена колонок. Колонка без названия всё равно должна быть адресуемой —
 * сопоставление хранится по имени, — поэтому безымянная получает номер, а
 * повтор — порядковый суффикс.
 */
function normalizeHeaders(raw: readonly string[]): string[] {
	const seen = new Map<string, number>();

	return raw.map((cell, index) => {
		const base = cell === '' ? `Колонка ${index + 1}` : cell;
		const used = seen.get(base) ?? 0;

		seen.set(base, used + 1);

		return used === 0 ? base : `${base} (${used + 1})`;
	});
}

function toTable(rows: string[][], limit: number): SheetTable {
	const meaningful = rows.filter((row) => !isBlankRow(row));
	const [header, ...body] = meaningful;

	if (header === undefined) {
		throw new ValidationError('В файле нет ни одной строки', [
			'Первая строка файла — это названия колонок, и без неё сопоставлять нечего'
		]);
	}

	if (body.length > MAX_STAT_FILE_ROWS) {
		throw new ValidationError('В файле слишком много строк', [
			`Строк данных — ${body.length}, за один раз принимаем не больше ${MAX_STAT_FILE_ROWS}`
		]);
	}

	return {
		headers: normalizeHeaders(header),
		rows: body.slice(0, limit),
		totalRows: body.length
	};
}

function decodeUtf8(bytes: Uint8Array): string {
	let text: string;

	try {
		text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
	} catch (cause) {
		throw new ValidationError('Файл читается не как UTF-8', [
			'Сохраните выгрузку в кодировке UTF-8 или пришлите её в формате XLSX',
			String(cause)
		]);
	}

	// BOM в начале файла Excel пишет сам; в имени первой колонки он не нужен.
	return text.replace(/^\ufeff/, '');
}

export function parseCsv(bytes: Uint8Array, limit: number): SheetTable {
	const text = decodeUtf8(bytes);

	return toTable(splitCsv(text, detectDelimiter(firstLineOf(text))), limit);
}

/** Значение ячейки xlsx текстом: формулы, ссылки и форматированный текст — тоже текст. */
function cellToText(value: CellValue): string {
	if (value === null || value === undefined) {
		return '';
	}

	if (value instanceof Date) {
		// Дата в выгрузке — это календарный день; время в ней всегда 00:00.
		return value.toISOString().slice(0, 10);
	}

	if (typeof value === 'object') {
		if ('richText' in value) {
			return value.richText
				.map((part) => part.text)
				.join('')
				.trim();
		}

		if ('formula' in value || 'sharedFormula' in value) {
			return cellToText(value.result ?? null);
		}

		if ('text' in value) {
			return String(value.text).trim();
		}

		if ('error' in value) {
			// Ошибка формулы — это не значение: строка получит претензию на
			// разборе, а не молча превратится в текст «#DIV/0!».
			return '';
		}
	}

	return String(value).trim();
}

export async function parseXlsx(bytes: Uint8Array, limit: number): Promise<SheetTable> {
	const workbook = new ExcelJS.Workbook();

	try {
		// `load` объявлен через собственный `Buffer extends ArrayBuffer`, поэтому
		// содержимое передаётся отдельным буфером: копия здесь дешевле, чем
		// приведение мимо объявлений библиотеки.
		await workbook.xlsx.load(bytes.slice().buffer as ArrayBuffer);
	} catch (cause) {
		throw new ValidationError('Файл не читается как книга XLSX', [String(cause)]);
	}

	const sheet = workbook.worksheets[0];

	if (sheet === undefined) {
		throw new ValidationError('В книге нет ни одного листа', [
			'Данные берутся с первого листа книги'
		]);
	}

	const rows: string[][] = [];

	sheet.eachRow({ includeEmpty: false }, (row) => {
		const cells: string[] = [];

		// `eachCell` пропускает пустые ячейки, а место колонки значимо: разбор
		// идёт по номеру столбца, иначе пропуск в середине сдвинул бы всё вправо.
		for (let column = 1; column <= sheet.columnCount; column += 1) {
			cells.push(cellToText(row.getCell(column).value));
		}

		rows.push(cells);
	});

	return toTable(rows, limit);
}

export async function readTable(
	format: StatFileFormat,
	bytes: Uint8Array,
	limit = MAX_STAT_FILE_ROWS
): Promise<SheetTable> {
	return format === 'xlsx' ? parseXlsx(bytes, limit) : parseCsv(bytes, limit);
}

/**
 * Целое число из ячейки. Возвращает `null` для пустой ячейки и `'invalid'`
 * для того, что числом не является: ноль, пропуск и мусор — три разных
 * ответа, и слить их в один значит потерять данные.
 */
export function parseCount(raw: string): number | null | 'invalid' {
	const value = raw.trim();

	if (value === '' || value === '-' || value === '—') {
		return null;
	}

	// Разряды в выгрузках разделяют пробелом (в том числе неразрывным), а
	// дробную часть — запятой.
	const normalized = value.replaceAll(/\s/g, '').replace(',', '.');

	if (!/^-?\d+(\.0+)?$/.test(normalized)) {
		return 'invalid';
	}

	const number = Number.parseFloat(normalized);

	return Number.isSafeInteger(number) ? number : 'invalid';
}

/** Разделители даты, которые встречаются в выгрузках. */
const DATE_PATTERNS: readonly RegExp[] = [
	/^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})$/,
	/^(?<day>\d{1,2})[./](?<month>\d{1,2})[./](?<year>\d{4})$/
];

/**
 * Календарная дата из ячейки в виде `ГГГГ-ММ-ДД` или `null`, если ячейка
 * пуста. `'invalid'` — значение есть, но датой не является.
 */
export function parseCalendarDate(raw: string): string | null | 'invalid' {
	const value = raw.trim();

	if (value === '') {
		return null;
	}

	for (const pattern of DATE_PATTERNS) {
		const parts = pattern.exec(value)?.groups;

		if (parts === undefined) {
			continue;
		}

		const year = Number(parts.year);
		const month = Number(parts.month);
		const day = Number(parts.day);
		const date = new Date(Date.UTC(year, month - 1, day));

		// `Date` охотно принимает 31 февраля и превращает его в 3 марта. Обратная
		// сверка ловит это: дата из файла обязана существовать.
		if (
			date.getUTCFullYear() !== year ||
			date.getUTCMonth() !== month - 1 ||
			date.getUTCDate() !== day
		) {
			return 'invalid';
		}

		return date.toISOString().slice(0, 10);
	}

	return 'invalid';
}
