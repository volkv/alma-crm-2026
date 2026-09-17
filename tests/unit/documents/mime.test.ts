import { readFileSync } from 'node:fs';
import PizZip from 'pizzip';
import { describe, expect, it } from 'vitest';
import { MAX_DOCUMENT_SIZE_BYTES } from '$lib/contracts/documents';
import {
	assertContentMatchesMime,
	assertSizeAllowed,
	extensionForMime,
	sniffDocumentMime
} from '$lib/server/documents/mime';
import { ValidationError } from '$lib/server/errors';

/** Пакет OOXML: zip, в котором есть `[Content_Types].xml` и главная часть формата. */
function ooxml(mainPart: string): Uint8Array {
	const zip = new PizZip();
	zip.file('[Content_Types].xml', '<Types/>');
	zip.file(mainPart, '<xml/>');

	return zip.generate({ type: 'uint8array', compression: 'DEFLATE' });
}

function bytes(...values: number[]): Uint8Array {
	return new Uint8Array(values);
}

/** Выгрузка русского Excel: те же строки, но в windows-1251. */
function cp1251Fixture(): Uint8Array {
	return readFileSync(new URL('../../fixtures/stats/enrollment-1251.csv', import.meta.url));
}

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

describe('тип файла по содержимому', () => {
	it('узнаёт форматы, которые система принимает', () => {
		expect(sniffDocumentMime(Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3', 'latin1'))).toBe(
			'application/pdf'
		);
		expect(sniffDocumentMime(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00))).toBe(
			'image/png'
		);
		expect(sniffDocumentMime(bytes(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10))).toBe('image/jpeg');
		expect(sniffDocumentMime(ooxml('word/document.xml'))).toBe(DOCX);
		expect(sniffDocumentMime(ooxml('xl/workbook.xml'))).toBe(XLSX);
		expect(sniffDocumentMime(Buffer.from('Протокол встречи 12.09.2026', 'utf8'))).toBe(
			'text/plain'
		);
	});

	it('не узнаёт исполняемый файл и разметку', () => {
		// Заголовок PE: именно то, что не должно попасть в хранилище документов.
		expect(sniffDocumentMime(Buffer.from('MZ\x90\x00\x03\x00\x00\x00', 'latin1'))).toBeNull();
		expect(sniffDocumentMime(Buffer.from('<!DOCTYPE html><html><body>x', 'utf8'))).toBeNull();
		expect(sniffDocumentMime(Buffer.from('<script>alert(1)</script>', 'utf8'))).toBeNull();
		// Разметка остаётся разметкой и в другой кодировке: проверка идёт по
		// прочитанному тексту, а не по байтам.
		expect(
			sniffDocumentMime(Buffer.from('\ufeff<html><body>Договор</body></html>', 'utf16le'))
		).toBeNull();
		// Двоичный мусор: в тексте нашлись управляющие байты.
		expect(sniffDocumentMime(bytes(0x0c, 0xc3, 0x28, 0xa0, 0xa1, 0x01, 0x02))).toBeNull();
	});

	it('признаёт текстом выгрузку в windows-1251', () => {
		// Русский Excel сохраняет CSV именно так, и требовать UTF-8 значит не
		// принимать самый частый файл заказчика.
		expect(sniffDocumentMime(cp1251Fixture())).toBe('text/plain');
		expect(sniffDocumentMime(bytes(0xc2, 0xf3, 0xe7, 0x3b, 0xc8, 0xcd, 0xcd))).toBe('text/plain');
		// UTF-16 с меткой порядка байтов — тоже текст.
		expect(sniffDocumentMime(Buffer.from('\ufeffОрганизация;ИНН', 'utf16le'))).toBe('text/plain');
	});

	it('отличает обычный zip от пакета Office', () => {
		const zip = new PizZip();
		zip.file('readme.txt', 'просто архив');

		expect(sniffDocumentMime(zip.generate({ type: 'uint8array' }))).toBe('application/zip');
	});

	it('узнаёт gzip и rar обеих версий по одной сигнатуре', () => {
		// Содержимое архива не разбирается: за сигнатурой идёт что угодно, и
		// распаковывать произвольный файл на сервере мы не беремся.
		expect(sniffDocumentMime(bytes(0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00))).toBe(
			'application/gzip'
		);
		expect(
			sniffDocumentMime(bytes(0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00, 0xcf, 0x90, 0x73))
		).toBe('application/vnd.rar');
		expect(
			sniffDocumentMime(bytes(0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00, 0x00, 0x00))
		).toBe('application/vnd.rar');
	});

	it('не принимает за rar файл, который только начинается на «Rar!»', () => {
		// Текст «Rar! это не архив» — обычный текст: сигнатура длиннее четырёх байт
		// намеренно, иначе под неё попадала бы любая заметка с этим словом.
		expect(sniffDocumentMime(Buffer.from('Rar! это не архив', 'utf8'))).toBe('text/plain');
	});
});

describe('проверка загружаемого файла', () => {
	it('пропускает файл, содержимое которого совпадает с заявленным типом', () => {
		expect(() => assertContentMatchesMime(DOCX, ooxml('word/document.xml'))).not.toThrow();
		expect(() =>
			assertContentMatchesMime('application/pdf', Buffer.from('%PDF-1.4\n', 'latin1'))
		).not.toThrow();
		expect(() =>
			assertContentMatchesMime(
				'image/png',
				bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00)
			)
		).not.toThrow();
	});

	it('отвергает переименованный HTML и исполняемый файл', () => {
		const html = Buffer.from('<html><body>Договор</body></html>', 'utf8');

		// Тот же файл, названный и текстом, и документом Word, и PDF.
		expect(() => assertContentMatchesMime('text/plain', html)).toThrow(ValidationError);
		expect(() => assertContentMatchesMime(DOCX, html)).toThrow(ValidationError);
		expect(() => assertContentMatchesMime('application/pdf', html)).toThrow(ValidationError);

		expect(() =>
			assertContentMatchesMime('application/pdf', Buffer.from('MZ\x90\x00', 'latin1'))
		).toThrow(ValidationError);
	});

	it('отвергает подмену одного разрешённого типа другим', () => {
		// Книга Excel, названная документом Word: оба типа разрешены, но врать нельзя.
		expect(() => assertContentMatchesMime(DOCX, ooxml('xl/workbook.xml'))).toThrow(
			/не совпадает с его типом/
		);
	});

	it('пропускает выгрузку в windows-1251, названную текстом', () => {
		expect(() => assertContentMatchesMime('text/plain', cp1251Fixture())).not.toThrow();
	});

	it('держит границы размера', () => {
		expect(() => assertSizeAllowed(0)).toThrow(ValidationError);
		expect(() => assertSizeAllowed(MAX_DOCUMENT_SIZE_BYTES)).not.toThrow();
		expect(() => assertSizeAllowed(MAX_DOCUMENT_SIZE_BYTES + 1)).toThrow(/больше 25 МиБ/);
	});
});

describe('расширение по типу', () => {
	it('знает расширения принимаемых форматов и молчит о чужих', () => {
		expect(extensionForMime(DOCX)).toBe('docx');
		expect(extensionForMime('application/pdf')).toBe('pdf');
		expect(extensionForMime('image/jpeg')).toBe('jpg');
		expect(extensionForMime('application/gzip')).toBe('gz');
		expect(extensionForMime('application/vnd.rar')).toBe('rar');
		expect(extensionForMime('application/x-msdownload')).toBeNull();
	});
});
