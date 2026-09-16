/**
 * Что за файл принесли.
 *
 * Определяется по первым байтам, а не по расширению и не по типу из
 * браузера: `.xls` в имени бывает у чего угодно, включая настоящий XLSX,
 * переименованный вручную, и HTML-таблицу, которую так сохранил 1С. Ошибка
 * здесь стоит дорого — разбор пойдёт не тем кодом и упадёт с невнятным
 * сообщением про повреждённый файл.
 */
import { SpreadsheetError } from './errors';

export const SPREADSHEET_FORMATS = ['xls', 'xlsx', 'csv'] as const;

export type SpreadsheetFormat = (typeof SPREADSHEET_FORMATS)[number];

/**
 * Подпись составного документа OLE2 — контейнер, в котором лежит книга BIFF.
 * Ту же подпись имеют `.doc` и `.ppt`: формат по ней узнаётся, а вот таблица
 * ли внутри — выяснится только при разборе.
 */
const OLE2_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

/** Подпись ZIP: в нём лежит XLSX (как и DOCX, и любой другой OOXML). */
const ZIP_SIGNATURE = [0x50, 0x4b];

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
	return (
		bytes.length >= signature.length && signature.every((byte, index) => bytes[index] === byte)
	);
}

/**
 * Формат файла по его первым байтам. Всё, что не книга, считается текстом;
 * текст ли это на самом деле, проверяет уже раскодировка (`decodeText`): для
 * этого надо знать кодировку, а её отсюда не видно.
 */
export function detectFormat(bytes: Uint8Array, fileName: string): SpreadsheetFormat {
	if (bytes.length === 0) {
		throw new SpreadsheetError('empty', `Файл «${fileName}» пуст`, [
			'В файле ноль байт — возможно, он не догрузился'
		]);
	}

	if (startsWith(bytes, OLE2_SIGNATURE)) {
		return 'xls';
	}

	if (startsWith(bytes, ZIP_SIGNATURE)) {
		return 'xlsx';
	}

	return 'csv';
}
