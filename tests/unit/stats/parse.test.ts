/**
 * Разбор файла: CSV, числа и даты в том виде, в каком их пишут в выгрузках.
 *
 * Главное здесь — что ноль, пропуск и мусор остаются тремя разными ответами.
 * Стоит им слиться в один, и «ноль заявок» станет неотличим от «колонку не
 * прислали», а отчёт — неверным.
 */
import { describe, expect, it } from 'vitest';
import { parseCalendarDate, parseCount, parseCsv } from '$lib/server/stats/parse';

function bytes(text: string): Uint8Array {
	return new TextEncoder().encode(text);
}

describe('CSV', () => {
	it('читает файл с точкой с запятой, как его сохраняет Excel', () => {
		const table = parseCsv(bytes('Вуз;Заявки\r\nСЗПУ;120\r\nПУПИ;0\r\n'), 100);

		expect(table.headers).toStrictEqual(['Вуз', 'Заявки']);
		expect(table.rows).toStrictEqual([
			['СЗПУ', '120'],
			['ПУПИ', '0']
		]);
		expect(table.totalRows).toBe(2);
	});

	it('читает файл с запятой', () => {
		const table = parseCsv(bytes('org,applications\nСЗПУ,120\n'), 100);

		expect(table.rows).toStrictEqual([['СЗПУ', '120']]);
	});

	it('не путает запятую внутри кавычек с разделителем', () => {
		const table = parseCsv(bytes('Вуз,Заявки\n"Университет, головной кампус",120\n'), 100);

		expect(table.rows).toStrictEqual([['Университет, головной кампус', '120']]);
	});

	it('понимает удвоенную кавычку внутри значения', () => {
		const table = parseCsv(bytes('Вуз\n"АНО ""Сибирский институт"""\n'), 100);

		expect(table.rows).toStrictEqual([['АНО "Сибирский институт"']]);
	});

	it('снимает BOM с имени первой колонки', () => {
		const table = parseCsv(bytes('﻿Вуз;Заявки\nСЗПУ;1\n'), 100);

		expect(table.headers[0]).toBe('Вуз');
	});

	it('пропускает пустые строки между блоками', () => {
		const table = parseCsv(bytes('Вуз;Заявки\n\nСЗПУ;1\n\n'), 100);

		expect(table.rows).toStrictEqual([['СЗПУ', '1']]);
	});

	it('даёт имя безымянной колонке и разводит одноимённые', () => {
		const table = parseCsv(bytes('Вуз;;Вуз\nа;б;в\n'), 100);

		expect(table.headers).toStrictEqual(['Вуз', 'Колонка 2', 'Вуз (2)']);
	});

	it('считает все строки файла, даже когда читает не все', () => {
		const table = parseCsv(bytes('Вуз\nа\nб\nв\n'), 2);

		expect(table.rows).toHaveLength(2);
		expect(table.totalRows).toBe(3);
	});

	it('отказывает пустому файлу словами', () => {
		expect(() => parseCsv(bytes(''), 100)).toThrowError('В файле нет ни одной строки');
	});

	it('не гадает о кодировке', () => {
		// Кириллица в CP1251: как UTF-8 это не читается.
		expect(() => parseCsv(Uint8Array.from([0xc2, 0xf3, 0xe7]), 100)).toThrowError(
			'Файл читается не как UTF-8'
		);
	});
});

describe('числа', () => {
	it('различает ноль, пропуск и мусор', () => {
		expect(parseCount('0')).toBe(0);
		expect(parseCount('')).toBeNull();
		expect(parseCount('—')).toBeNull();
		expect(parseCount('много')).toBe('invalid');
	});

	it('читает разряды, разделённые пробелом, и целое с нулевой дробной частью', () => {
		expect(parseCount('1 234')).toBe(1234);
		// Неразрывный пробел: именно его ставит Excel в разрядах.
		expect(parseCount('12\u00a0345')).toBe(12345);
		expect(parseCount('120,0')).toBe(120);
	});

	it('не делает из дробного числа целое', () => {
		expect(parseCount('12,5')).toBe('invalid');
	});

	it('читает отрицательное число как число: смысл ему придаёт поле', () => {
		expect(parseCount('-4')).toBe(-4);
	});
});

describe('даты', () => {
	it('читает оба вида записи', () => {
		expect(parseCalendarDate('2026-09-01')).toBe('2026-09-01');
		expect(parseCalendarDate('01.09.2026')).toBe('2026-09-01');
		expect(parseCalendarDate('1/9/2026')).toBe('2026-09-01');
	});

	it('пустая ячейка — это отсутствие даты, а не ошибка', () => {
		expect(parseCalendarDate('   ')).toBeNull();
	});

	it('не превращает несуществующий день в соседний', () => {
		expect(parseCalendarDate('31.02.2026')).toBe('invalid');
		expect(parseCalendarDate('вчера')).toBe('invalid');
	});
});
