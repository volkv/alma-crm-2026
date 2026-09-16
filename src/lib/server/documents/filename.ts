/**
 * Имя файла при скачивании.
 *
 * В хранилище файлы лежат под идентификаторами, поэтому имя, которое увидит
 * человек, собирается здесь — из названия документа и расширения по его типу.
 */
import { extensionForMime } from './mime';

/** Символы, недопустимые в имени файла хотя бы в одной из систем. */
// eslint-disable-next-line no-control-regex -- в имени файла управляющих байтов быть не должно
const UNSAFE_NAME_CHARS = /[\u0000-\u001f\u007f\\/:*?"<>|]/g;

/** Потолок длины основы имени: у файловых систем он около 255 байт. */
const MAX_BASE_LENGTH = 120;

export function documentFileName(title: string, mime: string): string {
	const base =
		title.replace(UNSAFE_NAME_CHARS, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_BASE_LENGTH) ||
		'Документ';

	const extension = extensionForMime(mime);

	if (extension === null || base.toLowerCase().endsWith(`.${extension}`)) {
		return base;
	}

	return `${base}.${extension}`;
}

/**
 * Кодирование по RFC 5987: `encodeURIComponent` оставляет `!'()*`, которые в
 * заголовке значат не то, что в URL.
 */
function encodeExtendedValue(value: string): string {
	return encodeURIComponent(value).replace(
		/['()*!]/g,
		(character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
	);
}

/**
 * Значение заголовка `Content-Disposition`.
 *
 * Имя пишется дважды: `filename` для тех, кто умеет только ASCII, и
 * `filename*` — то же имя в UTF-8 по RFC 5987. Без второго кириллица
 * превратится в мусор, без первого старый клиент не поймёт ничего.
 */
export function contentDisposition(fileName: string): string {
	// Кавычки и обратная косая ломают разбор заголовка, всё за пределами
	// печатаемого ASCII в нём просто недопустимо.
	const ascii = fileName.replace(/[^\u0020-\u007e]/g, '_').replace(/["\\]/g, '_');

	return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeExtendedValue(fileName)}`;
}
