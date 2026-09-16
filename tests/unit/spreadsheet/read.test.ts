/**
 * Чтение таблиц: одна и та же таблица в шести файлах.
 *
 * Фикстуры (`tests/fixtures/spreadsheet/README.md`) — это один и тот же список
 * визитов, записанный книгой LibreOffice и четырьмя CSV в разных кодировках и
 * с разными разделителями. Проверяется именно совпадение: разбор, который
 * теряет типы или ломает кириллицу, ломает её не во всех файлах сразу, и
 * поймать это можно только сравнением.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { detectDelimiter, decodeText } from '$lib/server/spreadsheet/encoding';
import { SpreadsheetError } from '$lib/server/spreadsheet/errors';
import { readSpreadsheet, type SpreadsheetCell } from '$lib/server/spreadsheet/read';

function fixture(name: string): Buffer {
	return readFileSync(new URL(`../../fixtures/spreadsheet/${name}`, import.meta.url));
}

/** Таблица, которая лежит в каждой фикстуре. */
const EXPECTED: SpreadsheetCell[][] = [
	['Организация', 'Дата визита', 'Участников', 'Доля %', 'Комментарий'],
	['МГТУ им. Баумана', new Date(Date.UTC(2026, 8, 12)), 42, 12.5, 'Первая встреча'],
	['СПбГУ', new Date(Date.UTC(2026, 9, 1)), 7, 3, null],
	['Университет (филиал)', null, 0, 0, 'Ноль — значение'],
	['Казанский федеральный', new Date(Date.UTC(2027, 0, 15)), 128, 41.25, 'Проверка "кавычек"'],
	[null, new Date(Date.UTC(2026, 11, 31)), 1, 0.5, 'Строка без названия']
];

const FIXTURES = [
	{ name: 'visits.xls', format: 'xls', encoding: null, delimiter: null, sheet: 'visits' },
	{ name: 'visits.xlsx', format: 'xlsx', encoding: null, delimiter: null, sheet: 'visits' },
	{ name: 'visits.csv', format: 'csv', encoding: 'utf-8', delimiter: ',', sheet: 'Sheet1' },
	{ name: 'visits-bom.csv', format: 'csv', encoding: 'utf-8', delimiter: ',', sheet: 'Sheet1' },
	{
		name: 'visits-1251.csv',
		format: 'csv',
		encoding: 'windows-1251',
		delimiter: ';',
		sheet: 'Sheet1'
	},
	{
		name: 'visits-1251-comma.csv',
		format: 'csv',
		encoding: 'windows-1251',
		delimiter: ',',
		sheet: 'Sheet1'
	}
] as const;

describe('чтение таблицы', () => {
	it.each(FIXTURES)('$name: те же данные, что и во всех остальных файлах', (fixtureCase) => {
		const { info, sheets } = readSpreadsheet(fixture(fixtureCase.name), fixtureCase.name);

		expect(info).toEqual({
			format: fixtureCase.format,
			encoding: fixtureCase.encoding,
			delimiter: fixtureCase.delimiter,
			sheetNames: [fixtureCase.sheet]
		});
		expect(sheets).toHaveLength(1);
		expect(sheets[0].name).toBe(fixtureCase.sheet);
		expect(sheets[0].rows).toEqual(EXPECTED);
	});

	it('оставляет числа числами, а даты датами', () => {
		const rows = readSpreadsheet(fixture('visits.xls'), 'visits.xls').sheets[0].rows;

		expect(typeof rows[1][2]).toBe('number');
		expect(typeof rows[1][3]).toBe('number');
		expect(rows[1][1]).toBeInstanceOf(Date);
		// День недели даты не зависит от часового пояса машины: если бы дата
		// разбиралась в местном времени, к западу от Гринвича это был бы 11-е.
		expect((rows[1][1] as Date).toISOString()).toBe('2026-09-12T00:00:00.000Z');
	});

	it('выравнивает строки по ширине таблицы', () => {
		const rows = readSpreadsheet(fixture('visits.xlsx'), 'visits.xlsx').sheets[0].rows;

		expect(rows.every((row) => row.length === 5)).toBe(true);
	});
});

describe('кодировка и разделитель', () => {
	it('узнаёт UTF-8 с меткой порядка байтов и без неё', () => {
		const plain = decodeText(fixture('visits.csv'), 'visits.csv');
		const marked = decodeText(fixture('visits-bom.csv'), 'visits-bom.csv');

		expect(plain).toMatchObject({ encoding: 'utf-8', bom: false });
		expect(marked).toMatchObject({ encoding: 'utf-8', bom: true });
		// Метка не должна попасть в название первой колонки.
		expect(marked.text).toBe(plain.text);
		expect(marked.text.startsWith('Организация')).toBe(true);
	});

	it('узнаёт windows-1251 по тому, что байты не складываются в UTF-8', () => {
		const decoded = decodeText(fixture('visits-1251.csv'), 'visits-1251.csv');

		expect(decoded.encoding).toBe('windows-1251');
		expect(decoded.text).toContain('МГТУ им. Баумана');
		expect(decoded.text).toContain('Ноль — значение');
	});

	it('узнаёт UTF-16 по метке порядка байтов', () => {
		const utf16le = Buffer.concat([
			Buffer.from([0xff, 0xfe]),
			Buffer.from('Организация;Дата', 'utf16le')
		]);

		expect(decodeText(utf16le, 'таблица.csv')).toEqual({
			text: 'Организация;Дата',
			encoding: 'utf-16le',
			bom: true
		});
	});

	it('считает разделители только вне кавычек', () => {
		expect(detectDelimiter('Организация;Дата;Участников')).toBe(';');
		expect(detectDelimiter('Организация,Дата,Участников')).toBe(',');
		expect(detectDelimiter('Организация\tДата\tУчастников')).toBe('\t');
		// Запятых в строке больше, но все они внутри значений.
		expect(detectDelimiter('"Вуз, филиал";"Дата, когда";"Участников, всего"')).toBe(';');
	});

	it('берёт строку заголовка, а не первую строку файла', () => {
		expect(detectDelimiter('\n\nОрганизация;Дата\nВуз, филиал;2026-09-12')).toBe(';');
	});
});

describe('отказы разбора', () => {
	it('пустой файл', () => {
		expect(() => readSpreadsheet(new Uint8Array(0), 'пусто.xls')).toThrowError(
			expect.objectContaining({ problem: 'empty', message: 'Файл «пусто.xls» пуст' })
		);
	});

	it('двоичный файл, который не таблица', () => {
		const png = Buffer.from([
			0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d
		]);

		expect(() => readSpreadsheet(png, 'скан.png')).toThrowError(
			expect.objectContaining({ problem: 'unknown_format' })
		);
	});

	it('повреждённая книга: подпись на месте, содержимого нет', () => {
		const broken = Buffer.concat([
			Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
			Buffer.alloc(512, 0x41)
		]);

		try {
			readSpreadsheet(broken, 'книга.xls');
			expect.unreachable('повреждённая книга должна быть отказом');
		} catch (error) {
			expect(error).toBeInstanceOf(SpreadsheetError);
			expect((error as SpreadsheetError).problem).toBe('unreadable');
			expect((error as SpreadsheetError).message).toBe(
				'Файл «книга.xls» не читается как книга XLS'
			);
			// Причину от библиотеки не теряем: без неё разбираться не с чем.
			expect((error as SpreadsheetError).issues.length).toBeGreaterThan(1);
		}
	});

	it('отказ — это ошибка проверки данных, а не сбой сервера', () => {
		try {
			readSpreadsheet(new Uint8Array(0), 'пусто.csv');
			expect.unreachable('пустой файл должен быть отказом');
		} catch (error) {
			expect(error).toBeInstanceOf(SpreadsheetError);
			expect((error as SpreadsheetError).code).toBe('validation');
		}
	});
});
