import { describe, expect, it } from 'vitest';
import { contentDisposition, documentFileName } from '$lib/server/documents/filename';

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

describe('имя файла документа', () => {
	it('складывается из названия и расширения по типу', () => {
		expect(documentFileName('Соглашение с МГТУ', DOCX)).toBe('Соглашение с МГТУ.docx');
		expect(documentFileName('Скан договора', 'application/pdf')).toBe('Скан договора.pdf');
	});

	it('не удваивает расширение и вычищает опасные символы', () => {
		expect(documentFileName('Отчёт.pdf', 'application/pdf')).toBe('Отчёт.pdf');
		expect(documentFileName('Акт 12/09\\2026: приёмка', 'application/pdf')).toBe(
			'Акт 12 09 2026 приёмка.pdf'
		);
	});

	it('не оставляет имя пустым и не приписывает расширение неизвестному типу', () => {
		expect(documentFileName('   ', 'application/pdf')).toBe('Документ.pdf');
		expect(documentFileName('Выгрузка', 'application/x-msdownload')).toBe('Выгрузка');
	});
});

describe('заголовок Content-Disposition', () => {
	it('несёт кириллическое имя в UTF-8 и ASCII-запасное', () => {
		const header = contentDisposition('Соглашение с МГТУ.docx');

		// Кириллица в запасном имени заменяется на подчёркивания, ASCII-пробелы целы.
		expect(header).toBe(
			'attachment; filename="__________ _ ____.docx"; ' +
				"filename*=UTF-8''%D0%A1%D0%BE%D0%B3%D0%BB%D0%B0%D1%88%D0%B5%D0%BD%D0%B8%D0%B5" +
				'%20%D1%81%20%D0%9C%D0%93%D0%A2%D0%A3.docx'
		);

		// Декодированное значение — ровно исходное имя, без потерь.
		expect(decodeURIComponent(header.split("filename*=UTF-8''")[1])).toBe('Соглашение с МГТУ.docx');
	});

	it('не даёт кавычкам разорвать заголовок', () => {
		const header = contentDisposition('Акт "приёмки".pdf');

		expect(header).toContain('filename="___ _________.pdf"');
		// Единственные кавычки в заголовке — те, что его и открывают.
		expect(header.match(/"/g)).toHaveLength(2);
	});
});
