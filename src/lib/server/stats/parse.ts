/**
 * Разбор файла снимка: таблица или JSON — одна внутренняя форма.
 *
 * Таблицы (XLS, XLSX, CSV) читает общий модуль `spreadsheet/read`: формат по
 * содержимому, кодировка, разделитель и листы — его работа, и второго места,
 * где это решается, в продукте нет. JSON разбирается здесь: это не таблица, а
 * список записей, и колонки у него получаются из ключей.
 *
 * Наружу оба пути выглядят одинаково — шапка, строки текстовых ячеек и
 * происхождение каждой строки. Это и есть граница разбора: дальше работает
 * сопоставление колонок, которому безразлично, из чего таблица приехала.
 *
 * Значения не приводятся к числам и датам здесь: «12 345» в ячейке — это
 * ответ вуза, и решать, число это или ошибка, должен тот, кто знает, в какое
 * поле колонка сопоставлена. Разбор отдаёт то, что написано.
 */
import {
	MAX_STAT_FILE_COLUMNS,
	MAX_STAT_FILE_ROWS,
	MAX_STAT_JSON_DEPTH,
	type StatFileSummary
} from '$lib/contracts/stats';
import { pluralize } from '$lib/format';
import { ValidationError } from '../errors';
import { decodeText } from '../spreadsheet/encoding';
import { readSpreadsheet, type SpreadsheetCell, type SpreadsheetSheet } from '../spreadsheet/read';

/** Строка таблицы вместе с тем, откуда она взялась. */
export type StatTableRow = {
	/**
	 * Место строки в источнике: номер строки листа (с единицы, шапка — тоже
	 * строка) или индекс элемента в массиве JSON (с нуля, как его адресует
	 * любой инструмент, которым файл откроют).
	 */
	origin: number;
	/**
	 * Ячейки строки как текст. Длина может отличаться от длины шапки:
	 * выравнивать её здесь нельзя — недостающая и лишняя ячейка это разные
	 * ошибки, и заметить их должен разбор строки, а не разбор файла.
	 */
	cells: string[];
};

/** Таблица файла: откуда прочитана, имена колонок и строки значений как есть. */
export type StatTable = {
	file: StatFileSummary;
	headers: string[];
	rows: StatTableRow[];
	/** Сколько строк данных в файле всего, даже если прочитаны не все. */
	totalRows: number;
	/**
	 * Что в файле странно, но отказом не стало. Молчать об этом нельзя: лишний
	 * лист книги и разные наборы ключей в JSON объясняют недостающие строки и
	 * пустые колонки лучше, чем они сами.
	 */
	warnings: string[];
};

/** Где лежит строка — словами, для претензии к ней. */
export function describeRowOrigin(file: StatFileSummary, origin: number): string {
	return file.format === 'json' ? `элемент ${origin}` : `строка ${origin}`;
}

/** Ключи, под которыми в JSON лежит список строк. */
const JSON_ROW_KEYS = ['rows', 'items', 'data'] as const;

/** Байты, которые могут стоять перед первым значащим символом JSON. */
const JSON_LEAD_BYTES = new Set([
	0x09, 0x0a, 0x0d, 0x20,
	// Половинки BOM и старший байт UTF-16: файл может быть не в UTF-8.
	0x00, 0xef, 0xbb, 0xbf, 0xfe, 0xff
]);

/** Сколько байт от начала файла смотрим, решая, JSON ли это. */
const JSON_PROBE_BYTES = 64;

/**
 * Похож ли файл на JSON. Решает содержимое, а не расширение: `.json` в имени
 * бывает у чего угодно, а выгрузку из чужой системы присылают и под именем
 * `отчёт.txt`.
 */
function looksLikeJson(bytes: Uint8Array): boolean {
	for (const byte of bytes.subarray(0, JSON_PROBE_BYTES)) {
		if (JSON_LEAD_BYTES.has(byte)) {
			continue;
		}

		// `{` или `[` — начало объекта и массива; всё остальное читаем таблицей.
		return byte === 0x7b || byte === 0x5b;
	}

	return false;
}

/** Пустая ли строка таблицы: в выгрузках между блоками попадаются пробелы. */
function isBlankRow(row: readonly string[]): boolean {
	return row.every((cell) => cell === '');
}

/**
 * Хвост из пустых ячеек убирается: у книги ширина строки — это ширина
 * размеченной области листа, и без обрезки каждая строка выглядела бы длиннее
 * шапки. А вот пустая ячейка в середине значима — это пропуск в данных.
 */
function trimTrailing(cells: string[]): string[] {
	let end = cells.length;

	while (end > 0 && cells[end - 1] === '') {
		end -= 1;
	}

	return cells.slice(0, end);
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

/** Границы, общие для всех форматов: файл разбирается целиком в памяти. */
function assertRowsFit(totalRows: number): void {
	if (totalRows > MAX_STAT_FILE_ROWS) {
		throw new ValidationError('В файле слишком много строк', [
			`Строк данных — ${totalRows}, за один раз принимаем не больше ${MAX_STAT_FILE_ROWS}`
		]);
	}
}

function assertColumnsFit(headers: readonly string[]): void {
	if (headers.length > MAX_STAT_FILE_COLUMNS) {
		throw new ValidationError('В файле слишком много колонок', [
			`Колонок — ${headers.length}, размечаем не больше ${MAX_STAT_FILE_COLUMNS}`,
			'Оставьте в файле только те колонки, которые нужны показателям'
		]);
	}
}

/** Значение ячейки книги текстом. */
function cellText(cell: SpreadsheetCell): string {
	if (cell === null) {
		return '';
	}

	if (cell instanceof Date) {
		// Дата в выгрузке — это календарный день; время в ней всегда 00:00.
		return cell.toISOString().slice(0, 10);
	}

	return typeof cell === 'string' ? cell.trim() : String(cell);
}

/**
 * Строки листа текстом.
 *
 * У книги истина — значение ячейки: дата лежит датой, число числом, и
 * читать вместо них показ значит зависеть от формата, которым их показывают.
 * У текстового файла наоборот: значение — догадка разборщика («12,5» он
 * принимает за 125, а ИНН «0278000000» — за число без ведущего нуля), и
 * истина там — написанное.
 */
function sheetRows(sheet: SpreadsheetSheet, fromText: boolean): StatTableRow[] {
	return sheet.rows.map((cells, index) => ({
		origin: index + 1,
		cells: trimTrailing(
			fromText
				? (sheet.texts[index] ?? []).map((text) => text.trim())
				: cells.map((cell) => cellText(cell))
		)
	}));
}

/** Что вызывающий знает о файле сверх общего разбора. */
export type StatTableOptions = {
	/**
	 * Служебный ли лист книги — например, справочник значений для выпадающих
	 * списков, который шаблон кладёт вторым листом. Такой лист не данные, и
	 * предупреждать, что он не прочитан, — значит пугать человека его же
	 * шаблоном. Без признака служебных листов нет: о каждом лишнем сказано.
	 */
	isAuxiliarySheet?: (sheet: SpreadsheetSheet) => boolean;
};

function readSheetTable(
	fileName: string,
	bytes: Uint8Array,
	limit: number,
	options: StatTableOptions
): StatTable {
	const { info, sheets } = readSpreadsheet(bytes, fileName);
	// `readSpreadsheet` отказывает книге без листов, поэтому лист здесь есть.
	const sheet = sheets[0];
	const warnings: string[] = [];
	const unread = sheets.slice(1).filter((other) => !(options.isAuxiliarySheet?.(other) ?? false));

	if (unread.length > 0) {
		warnings.push(
			`В файле ${pluralize(sheets.length, ['лист', 'листа', 'листов'])} — прочитан первый, «${sheet.name}». Остальные не загружаются.`
		);
	}

	const file: StatFileSummary = {
		fileName,
		format: info.format,
		encoding: info.encoding,
		delimiter: info.delimiter,
		sheetName: sheet.name,
		sheetNames: [...info.sheetNames]
	};

	const meaningful = sheetRows(sheet, info.format === 'csv').filter(
		(row) => !isBlankRow(row.cells)
	);
	const [header, ...body] = meaningful;

	if (header === undefined) {
		throw new ValidationError('В файле нет ни одной строки', [
			'Первая строка файла — это названия колонок, и без неё сопоставлять нечего'
		]);
	}

	const headers = normalizeHeaders(header.cells);

	assertColumnsFit(headers);
	assertRowsFit(body.length);

	return { file, headers, rows: body.slice(0, limit), totalRows: body.length, warnings };
}

/** Список записей в разобранном JSON: сам массив или массив по известному ключу. */
function jsonRecords(parsed: unknown, fileName: string): unknown[] {
	if (Array.isArray(parsed)) {
		return parsed;
	}

	if (parsed === null || typeof parsed !== 'object') {
		throw new ValidationError(`В файле «${fileName}» не список строк`, [
			'Ждём массив объектов или объект с массивом строк внутри',
			`В файле — ${parsed === null ? 'null' : typeof parsed}`
		]);
	}

	const found = JSON_ROW_KEYS.filter((key) =>
		Array.isArray((parsed as Record<string, unknown>)[key])
	);

	// Ключей-кандидатов три, потому что именно так называют список выгрузки
	// разные системы. Когда их в файле сразу несколько, выбирать нельзя: не
	// тот список — это молча не те числа в отчёте.
	if (found.length > 1) {
		throw new ValidationError(`В файле «${fileName}» несколько списков строк`, [
			`Массивы лежат по ключам: ${found.join(', ')}`,
			'Оставьте в файле один список — какой из них таблица, выбирать наугад нельзя'
		]);
	}

	if (found.length === 0) {
		throw new ValidationError(`В файле «${fileName}» не найден список строк`, [
			`Ждём массив объектов или объект с массивом по ключу ${JSON_ROW_KEYS.join(', ')}`,
			`В файле ключи: ${Object.keys(parsed).slice(0, 10).join(', ') || 'ни одного'}`
		]);
	}

	return (parsed as Record<string, unknown[]>)[found[0]];
}

/**
 * Запись JSON плоским набором колонок. Вложенный объект разворачивается через
 * точку (`org.inn`), массив — через индекс (`tags.0`): колонка обязана быть
 * адресуемой именем, а имя — говорить, откуда значение взялось.
 */
function flatten(value: unknown, path: string, depth: number, into: Map<string, string>): void {
	if (value === null || value === undefined) {
		into.set(path, '');

		return;
	}

	if (typeof value === 'object') {
		if (depth >= MAX_STAT_JSON_DEPTH) {
			throw new ValidationError('JSON вложен слишком глубоко', [
				`Колонка «${path}» лежит глубже ${MAX_STAT_JSON_DEPTH} уровней`,
				'Разложите записи в плоский список: колонка — это одно значение'
			]);
		}

		const entries: [string, unknown][] = Array.isArray(value)
			? value.map((item, index) => [String(index), item])
			: Object.entries(value);

		// Пустой объект — это пустое значение, а не отсутствие колонки: колонку
		// в шапке он всё-таки занимает. Пустая же запись целиком (`path` ещё
		// пуст) колонок не приносит — это строка, в которой ничего не заполнено.
		if (entries.length === 0) {
			if (path !== '') {
				into.set(path, '');
			}

			return;
		}

		for (const [key, item] of entries) {
			flatten(item, path === '' ? key : `${path}.${key}`, depth + 1, into);
		}

		return;
	}

	into.set(path, typeof value === 'string' ? value.trim() : String(value));
}

function flattenRecord(record: unknown, origin: number, fileName: string): Map<string, string> {
	if (record === null || typeof record !== 'object' || Array.isArray(record)) {
		throw new ValidationError(`В файле «${fileName}» есть запись без колонок`, [
			`Элемент ${origin} — ${record === null ? 'null' : Array.isArray(record) ? 'массив' : typeof record}, а ждём объект «колонка: значение»`
		]);
	}

	const values = new Map<string, string>();

	flatten(record, '', 0, values);

	return values;
}

/** Сколько предупреждений о разных наборах ключей показываем. */
const MAX_KEY_WARNINGS = 5;

/**
 * Колонки JSON: ключи всех записей в порядке первой встречи и их имена в шапке.
 *
 * Имя и ключ разведены, потому что имя колонки может оказаться пустым (`{"": 1}`
 * — законный JSON), а колонка обязана быть адресуемой; значения при этом
 * достаются по исходному ключу.
 *
 * Разный набор ключей — не отказ: выгрузка, где у части записей нет
 * необязательного поля, — обычное дело, и терять из-за неё весь файл нельзя.
 * Но и молчать об этом нельзя: пустая колонка у половины строк объясняется
 * именно этим.
 */
function jsonColumns(
	records: readonly Map<string, string>[],
	warnings: string[]
): { keys: string[]; headers: string[] } {
	const keys: string[] = [];
	const seen = new Set<string>();

	for (const record of records) {
		for (const key of record.keys()) {
			if (!seen.has(key)) {
				seen.add(key);
				keys.push(key);
			}
		}
	}

	const headers = normalizeHeaders(keys);
	const reported = new Set<string>();

	for (const [index, record] of records.entries()) {
		keys.forEach((key, column) => {
			if (record.has(key) || reported.has(key)) {
				return;
			}

			reported.add(key);

			if (reported.size <= MAX_KEY_WARNINGS) {
				warnings.push(
					`Колонка «${headers[column]}» есть не у всех записей: в элементе ${index} её нет. Значение останется пустым.`
				);
			}
		});
	}

	if (reported.size > MAX_KEY_WARNINGS) {
		warnings.push(`И ещё ${reported.size - MAX_KEY_WARNINGS} колонок есть не у всех записей.`);
	}

	return { keys, headers };
}

function readJsonTable(fileName: string, bytes: Uint8Array, limit: number): StatTable {
	// Кодировку определяет тот же модуль, что и у таблиц: JSON из чужой системы
	// приезжает и в windows-1251, и с меткой порядка байтов.
	const { text, encoding } = decodeText(bytes, fileName);
	let parsed: unknown;

	try {
		parsed = JSON.parse(text);
	} catch (cause) {
		throw new ValidationError(`Файл «${fileName}» не разбирается как JSON`, [
			'Проверьте файл: лишняя запятая в конце списка или одинарные кавычки — самое частое',
			String(cause instanceof Error ? cause.message : cause)
		]);
	}

	const file: StatFileSummary = {
		fileName,
		format: 'json',
		encoding,
		delimiter: null,
		sheetName: null,
		sheetNames: []
	};

	const records = jsonRecords(parsed, fileName);
	const warnings: string[] = [];

	if (records.length === 0) {
		throw new ValidationError('В файле нет ни одной строки', [
			'Список записей пуст, и сопоставлять нечего'
		]);
	}

	// Граница по строкам проверяется до разворота записей: разворачивать файл,
	// который всё равно не примем, незачем.
	assertRowsFit(records.length);

	// Разворачиваются все записи, а не только те, что попадут в превью: шапка
	// обязана быть одной и той же и на сопоставлении, и на разборе файла целиком.
	const values = records.map((record, index) => flattenRecord(record, index, fileName));
	const { keys, headers } = jsonColumns(values, warnings);

	assertColumnsFit(headers);

	const rows = values.slice(0, limit).map((record, index) => ({
		origin: index,
		cells: keys.map((key) => record.get(key) ?? '')
	}));

	return { file, headers, rows, totalRows: records.length, warnings };
}

/**
 * Прочитать файл снимка. Формат определяется по содержимому: расширение и тип
 * из браузера выбирает человек, и решать по ним значит разбирать файл не тем
 * кодом.
 */
export function readStatTable(
	fileName: string,
	bytes: Uint8Array,
	limit = MAX_STAT_FILE_ROWS,
	options: StatTableOptions = {}
): StatTable {
	return looksLikeJson(bytes)
		? readJsonTable(fileName, bytes, limit)
		: readSheetTable(fileName, bytes, limit, options);
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
