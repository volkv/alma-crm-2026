/**
 * Чтение таблицы из файла: XLS (BIFF), XLSX и CSV.
 *
 * Наружу все три формата выглядят одинаково — листы, строки, ячейки, — но
 * приходят они по-разному, и из чего именно собрана таблица, человеку надо
 * показать: «прочитано как CSV в windows-1251 с разделителем `;`» объясняет
 * съехавшие колонки лучше, чем любое сообщение об ошибке.
 *
 * Типы ячеек сохраняются. Дата, приехавшая датой, остаётся `Date`, число —
 * числом: превращать их в текст здесь значит терять ровно ту информацию,
 * ради которой книгу и прислали, а обратно «12.09.2026» и «12,5» разбираются
 * уже с догадками о формате.
 */
import type { CellObject, WorkBook, WorkSheet } from 'xlsx';
import { detectFormat, type SpreadsheetFormat } from './detect';
import { decodeText, detectDelimiter, type CsvDelimiter, type TextEncoding } from './encoding';
import { SpreadsheetError } from './errors';
import { XLSX } from './sheetjs';

/**
 * Значение ячейки. `null` — пустая ячейка; логическое значение приезжает из
 * книг, где колонку заполняли галочкой, и в строку не превращается: «ИСТИНА»
 * и «TRUE» — это уже перевод, а не данные.
 */
export type SpreadsheetCell = string | number | boolean | Date | null;

export type SpreadsheetSheet = {
	name: string;
	/** Строки листа. Все строки одной длины — по ширине заполненной области. */
	rows: SpreadsheetCell[][];
	/**
	 * Тот же лист текстом: как ячейка записана в файле.
	 *
	 * У книги это показ значения, и истина в ней — само значение. У текстового
	 * файла наоборот: значение — догадка разборщика, а истина — написанное.
	 * «12,5» в CSV он читает как 125 (запятая для него разделитель разрядов), а
	 * «0278000000» — как число без ведущего нуля; тому, кто разбирает выгрузку
	 * своими правилами, нужен исходный текст, иначе эти два числа уже не
	 * вернуть.
	 *
	 * Размер совпадает с `rows` ячейка в ячейку.
	 */
	texts: string[][];
};

/** Из чего собрана таблица — то, что показываем человеку рядом с разбором. */
export type SpreadsheetInfo = {
	format: SpreadsheetFormat;
	/** Кодировка текста; у книг её нет — там кодировка внутреннее дело файла. */
	encoding: TextEncoding | null;
	/** Разделитель CSV; у книг — `null`. */
	delimiter: CsvDelimiter | null;
	sheetNames: string[];
};

export type SpreadsheetContent = {
	info: SpreadsheetInfo;
	sheets: SpreadsheetSheet[];
};

/**
 * Общие настройки разбора.
 *
 * `dense` — строки листа массивом, а не словарём адресов `A1`: по таблице в
 * тысячи строк идём построчно, и собирать адреса строками ради этого незачем.
 *
 * `cellDates` — даты отдельным типом, иначе в ячейке окажется номер дня по
 * календарю Excel.
 *
 * `UTC` — полночь считается полуночью UTC. Без него дата из текстового файла
 * разбирается в часовом поясе сервера, и `2026-09-12` на машине западнее
 * Гринвича становится одиннадцатым числом.
 */
const PARSE_OPTIONS = { dense: true, cellDates: true, UTC: true } as const;

/** Текст ячейки: то, что записано в файле, до разбора значения. */
function toText(cell: CellObject | undefined): string {
	if (cell === undefined || cell.t === 'z' || cell.t === 'e' || cell.v === undefined) {
		return '';
	}

	if (cell.w !== undefined) {
		return cell.w;
	}

	// Показа у ячейки может и не быть — тогда текстом становится само значение.
	return cell.v instanceof Date ? cell.v.toISOString().slice(0, 10) : String(cell.v);
}

/** Значение ячейки SheetJS в нашем виде. */
function toCell(cell: CellObject | undefined): SpreadsheetCell {
	if (cell === undefined || cell.t === 'z' || cell.v === undefined || cell.v === null) {
		return null;
	}

	// `#DIV/0!` — это не значение, а след поломанной формулы в чужом файле.
	// Пустая ячейка честнее строки с текстом ошибки: считать по ней всё равно
	// нечего, а строка выглядела бы как данные.
	if (cell.t === 'e') {
		return null;
	}

	if (cell.v instanceof Date) {
		return cell.v;
	}

	if (typeof cell.v === 'number' || typeof cell.v === 'boolean') {
		return cell.v;
	}

	return String(cell.v);
}

/**
 * Лист в виде прямоугольной таблицы.
 *
 * Строки выравниваются по ширине заполненной области: пропуск в середине и
 * хвост из пустых ячеек — это одно и то же «здесь ничего не написали», а
 * рваные строки заставили бы каждого, кто читает таблицу, проверять длину.
 */
function toSheet(name: string, worksheet: WorkSheet | undefined): SpreadsheetSheet {
	const ref = worksheet?.['!ref'];
	const data = worksheet?.['!data'];

	if (ref === undefined || data === undefined) {
		return { name, rows: [], texts: [] };
	}

	const range = XLSX.utils.decode_range(ref);
	const width = range.e.c + 1;
	const rows: SpreadsheetCell[][] = [];
	const texts: string[][] = [];

	for (let rowIndex = 0; rowIndex <= range.e.r; rowIndex += 1) {
		const row: CellObject[] = data[rowIndex] ?? [];

		rows.push(Array.from({ length: width }, (_, column) => toCell(row[column])));
		texts.push(Array.from({ length: width }, (_, column) => toText(row[column])));
	}

	return { name, rows, texts };
}

function toSheets(workbook: WorkBook, fileName: string): SpreadsheetSheet[] {
	if (workbook.SheetNames.length === 0) {
		throw new SpreadsheetError('no_sheets', `В файле «${fileName}» нет ни одного листа`);
	}

	return workbook.SheetNames.map((name) => toSheet(name, workbook.Sheets[name]));
}

function readWorkbook(bytes: Uint8Array, format: 'xls' | 'xlsx', fileName: string): WorkBook {
	try {
		return XLSX.read(bytes, { ...PARSE_OPTIONS, type: 'array' });
	} catch (cause) {
		throw new SpreadsheetError(
			'unreadable',
			`Файл «${fileName}» не читается как книга ${format.toUpperCase()}`,
			[
				'Откройте файл в Excel или LibreOffice и сохраните заново',
				String(cause instanceof Error ? cause.message : cause)
			]
		);
	}
}

function readCsv(
	bytes: Uint8Array,
	fileName: string
): { workbook: WorkBook; encoding: TextEncoding; delimiter: CsvDelimiter } {
	const { text, encoding } = decodeText(bytes, fileName);
	const delimiter = detectDelimiter(text);

	try {
		return {
			workbook: XLSX.read(text, { ...PARSE_OPTIONS, type: 'string', FS: delimiter }),
			encoding,
			delimiter
		};
	} catch (cause) {
		throw new SpreadsheetError('unreadable', `Файл «${fileName}» не разбирается как таблица`, [
			String(cause instanceof Error ? cause.message : cause)
		]);
	}
}

/**
 * Прочитать файл как таблицу. Формат определяется по содержимому, имя файла
 * нужно только для сообщений об ошибке — по расширению здесь не решается
 * ничего.
 */
export function readSpreadsheet(bytes: Uint8Array, fileName: string): SpreadsheetContent {
	const format = detectFormat(bytes, fileName);

	if (format === 'csv') {
		const { workbook, encoding, delimiter } = readCsv(bytes, fileName);

		return {
			info: { format, encoding, delimiter, sheetNames: [...workbook.SheetNames] },
			sheets: toSheets(workbook, fileName)
		};
	}

	const workbook = readWorkbook(bytes, format, fileName);

	return {
		info: { format, encoding: null, delimiter: null, sheetNames: [...workbook.SheetNames] },
		sheets: toSheets(workbook, fileName)
	};
}
