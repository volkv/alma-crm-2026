/**
 * Проверка того, что файл — действительно то, чем назвался.
 *
 * Тип, присланный клиентом, ничего не доказывает: `Content-Type` выбирает
 * браузер по расширению, а расширение выбирает человек. Поэтому тип
 * определяется по содержимому — по сигнатуре в первых байтах, а для форматов
 * Office ещё и по составу zip-архива, — и должен совпасть с заявленным.
 *
 * Список допустимых типов и потолок размера живут в контрактах: одна и та же
 * граница работает на форме, в API и здесь.
 */
import PizZip from 'pizzip';
import { ALLOWED_DOCUMENT_MIME_TYPES, MAX_DOCUMENT_SIZE_BYTES } from '$lib/contracts/documents';
import { ValidationError } from '../errors';

export type AllowedDocumentMime = (typeof ALLOWED_DOCUMENT_MIME_TYPES)[number];

export const DOCX_MIME: AllowedDocumentMime =
	'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const PDF_MIME: AllowedDocumentMime = 'application/pdf';

/** Расширение файла для каждого допустимого типа: по нему строится имя при скачивании. */
const EXTENSIONS: Record<AllowedDocumentMime, string> = {
	'application/pdf': 'pdf',
	'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
	'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
	'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
	'application/msword': 'doc',
	'application/vnd.ms-excel': 'xls',
	'image/png': 'png',
	'image/jpeg': 'jpg',
	'text/plain': 'txt',
	'application/zip': 'zip'
};

/**
 * Расширение по типу или `null`, если тип неизвестен. Тип приходит из базы,
 * то есть формально это произвольная строка, и придумывать ей расширение
 * наугад нельзя.
 */
export function extensionForMime(mime: string): string | null {
	return Object.hasOwn(EXTENSIONS, mime) ? EXTENSIONS[mime as AllowedDocumentMime] : null;
}

/** Сигнатуры начала файла. */
const SIGNATURES = {
	pdf: [0x25, 0x50, 0x44, 0x46, 0x2d], // %PDF-
	png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
	jpeg: [0xff, 0xd8, 0xff],
	// Локальный заголовок zip, пустой архив и архив, собранный из частей.
	zipLocal: [0x50, 0x4b, 0x03, 0x04],
	zipEmpty: [0x50, 0x4b, 0x05, 0x06],
	zipSpanned: [0x50, 0x4b, 0x07, 0x08],
	// Контейнер OLE2: в нём лежат документы Office до 2007 года.
	ole2: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]
} as const;

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
	if (bytes.length < signature.length) {
		return false;
	}

	return signature.every((byte, index) => bytes[index] === byte);
}

/** Файл внутри пакета, по которому опознаётся формат OOXML. */
const OOXML_MARKERS: readonly [string, AllowedDocumentMime][] = [
	['word/document.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
	['xl/workbook.xml', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
	[
		'ppt/presentation.xml',
		'application/vnd.openxmlformats-officedocument.presentationml.presentation'
	]
];

/**
 * Что за zip перед нами. Пакеты Office — это zip с предсказуемым составом,
 * поэтому различаются они не по сигнатуре, а по внутренним файлам.
 */
function sniffZip(bytes: Uint8Array): AllowedDocumentMime | null {
	let entries: string[];

	try {
		entries = Object.keys(new PizZip(bytes).files);
	} catch {
		// Архив не читается — значит, это не zip и не пакет Office. Разбираться,
		// чем именно он испорчен, здесь незачем: результат один — тип неизвестен.
		return null;
	}

	if (!entries.includes('[Content_Types].xml')) {
		return 'application/zip';
	}

	for (const [marker, mime] of OOXML_MARKERS) {
		if (entries.includes(marker)) {
			return mime;
		}
	}

	// Пакет OOXML неизвестного вида — для нас это просто архив.
	return 'application/zip';
}

/** Имена основных потоков внутри OLE2, закодированные так же, как в каталоге контейнера. */
const OLE2_STREAMS: readonly [Buffer, AllowedDocumentMime][] = [
	[Buffer.from('WordDocument', 'utf16le'), 'application/msword'],
	[Buffer.from('Workbook', 'utf16le'), 'application/vnd.ms-excel']
];

function sniffOle2(bytes: Uint8Array): AllowedDocumentMime | null {
	const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);

	for (const [needle, mime] of OLE2_STREAMS) {
		if (buffer.includes(needle)) {
			return mime;
		}
	}

	return null;
}

/** Разметка, которую браузер исполнит, если отдать её как текст. */
const MARKUP_START = /^(?:<!doctype|<html|<\?xml|<svg|<script|<!--)/i;

/**
 * Похоже ли содержимое на обычный текст. Сигнатуры у `text/plain` нет, поэтому
 * проверяем от обратного: корректный UTF-8, без управляющих байтов и без
 * признаков разметки — переименованный HTML текстом не считается.
 */
function looksLikeText(bytes: Uint8Array): boolean {
	let text: string;

	try {
		text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
	} catch {
		// Не UTF-8 — значит, не наш текстовый файл. Гадать о кодировке не будем.
		return false;
	}

	// eslint-disable-next-line no-control-regex -- ищем именно управляющие байты
	if (/[\u0000-\u0008\u000b\u000e-\u001f]/.test(text)) {
		return false;
	}

	return !MARKUP_START.test(text.replace(/^\ufeff/, '').trimStart());
}

/**
 * Тип файла по его содержимому или `null`, если содержимое не опознано.
 * Возвращается канонический тип: `.jpg` и `.jpeg` — это один `image/jpeg`.
 */
export function sniffDocumentMime(bytes: Uint8Array): AllowedDocumentMime | null {
	if (startsWith(bytes, SIGNATURES.pdf)) {
		return 'application/pdf';
	}

	if (startsWith(bytes, SIGNATURES.png)) {
		return 'image/png';
	}

	if (startsWith(bytes, SIGNATURES.jpeg)) {
		return 'image/jpeg';
	}

	if (
		startsWith(bytes, SIGNATURES.zipLocal) ||
		startsWith(bytes, SIGNATURES.zipEmpty) ||
		startsWith(bytes, SIGNATURES.zipSpanned)
	) {
		return sniffZip(bytes);
	}

	if (startsWith(bytes, SIGNATURES.ole2)) {
		return sniffOle2(bytes);
	}

	return looksLikeText(bytes) ? 'text/plain' : null;
}

/**
 * Размер файла в границах. Проверяется до всего остального: разбирать
 * содержимое файла, который всё равно не примем, незачем.
 */
export function assertSizeAllowed(sizeBytes: number): void {
	if (sizeBytes <= 0) {
		throw new ValidationError('Файл пустой', ['В файле нет ни одного байта']);
	}

	if (sizeBytes > MAX_DOCUMENT_SIZE_BYTES) {
		throw new ValidationError('Файл больше 25 МиБ', [
			`Размер файла — ${sizeBytes} байт, потолок — ${MAX_DOCUMENT_SIZE_BYTES}`
		]);
	}
}

/**
 * Содержимое соответствует заявленному типу. Несовпадение — отказ: файл,
 * который назвался PDF, а внутри HTML, опасен ровно тем, что его где-нибудь
 * откроют по заявленному типу.
 */
export function assertContentMatchesMime(declared: AllowedDocumentMime, bytes: Uint8Array): void {
	const detected = sniffDocumentMime(bytes);

	if (detected === null) {
		throw new ValidationError('Не удалось распознать содержимое файла', [
			`Файл объявлен как «${declared}», но его содержимое не похоже ни на один из допустимых форматов`
		]);
	}

	if (detected !== declared) {
		throw new ValidationError('Содержимое файла не совпадает с его типом', [
			`Файл объявлен как «${declared}», а внутри — «${detected}»`
		]);
	}
}
