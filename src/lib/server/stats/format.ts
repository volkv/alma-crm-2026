/**
 * Формат файла снимка и его тип в хранилище документов.
 *
 * Тип определяется по содержимому, а не по расширению и не по тому, что
 * назвал браузер: `.csv` он отдаёт то как `text/csv`, то как
 * `application/vnd.ms-excel`, а внутри может оказаться что угодно. Хранилище
 * знает про обычный текст один тип — `text/plain`, — и CSV для него именно
 * текст; таблица из этого текста получается уже здесь.
 */
import { sniffDocumentMime, type AllowedDocumentMime } from '../documents/mime';
import { ValidationError } from '../errors';
import type { StatFileFormat } from './parse';

const FORMAT_MIMES = {
	xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
	csv: 'text/plain'
} as const satisfies Record<StatFileFormat, AllowedDocumentMime>;

/** Тип, под которым файл снимка лежит в хранилище документов. */
export function statFileMime(format: StatFileFormat): AllowedDocumentMime {
	return FORMAT_MIMES[format];
}

/** Формат по типу файла из базы. */
export function fileFormatOf(mime: string): StatFileFormat {
	const format = (Object.keys(FORMAT_MIMES) as StatFileFormat[]).find(
		(candidate) => FORMAT_MIMES[candidate] === mime
	);

	if (format === undefined) {
		throw new ValidationError('Файл снимка не в табличном формате', [
			`Тип файла — «${mime}», а импорт читает XLSX и CSV`
		]);
	}

	return format;
}

/** Формат загружаемого файла по его содержимому. */
export function detectStatFile(bytes: Uint8Array): {
	format: StatFileFormat;
	mime: AllowedDocumentMime;
} {
	const detected = sniffDocumentMime(bytes);

	if (detected === null) {
		throw new ValidationError('Не удалось распознать содержимое файла', [
			'Импорт читает книгу XLSX и таблицу CSV в кодировке UTF-8'
		]);
	}

	if (detected === FORMAT_MIMES.xlsx) {
		return { format: 'xlsx', mime: detected };
	}

	if (detected === FORMAT_MIMES.csv) {
		return { format: 'csv', mime: detected };
	}

	throw new ValidationError('Такой файл импорт не читает', [
		`Внутри файла — «${detected}», а нужны XLSX или CSV`
	]);
}
