/**
 * Тип файла снимка в хранилище документов.
 *
 * Формат файла определяет разбор (`stats/parse.ts`) — по содержимому, а не по
 * расширению и не по тому, что назвал браузер: `.csv` он отдаёт то как
 * `text/csv`, то как `application/vnd.ms-excel`, а внутри может оказаться что
 * угодно. Здесь остаётся только перевод разобранного формата в тип хранилища.
 *
 * Хранилище знает про обычный текст один тип — `text/plain`, — и CSV с JSON
 * для него именно текст: таблицу из этого текста собирает разбор.
 */
import type { StatFileFormat } from '$lib/contracts/stats';
import type { AllowedDocumentMime } from '../documents/mime';

const FORMAT_MIMES = {
	xls: 'application/vnd.ms-excel',
	xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
	csv: 'text/plain',
	json: 'text/plain'
} as const satisfies Record<StatFileFormat, AllowedDocumentMime>;

/** Тип, под которым файл снимка лежит в хранилище документов. */
export function statFileMime(format: StatFileFormat): AllowedDocumentMime {
	return FORMAT_MIMES[format];
}
