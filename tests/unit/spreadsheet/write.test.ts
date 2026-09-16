/**
 * Сборка книги и текстовой выгрузки.
 *
 * Собранный файл тут же читается обратно: проверять надо то, что окажется в
 * файле, а не то, что передали в библиотеку. Три вещи ломаются молча и потому
 * вынесены в отдельные проверки: формула в ячейке, дата, записанная по
 * часовому поясу сервера, и символ, которого нет в кодовой странице выгрузки.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { readSpreadsheet } from '$lib/server/spreadsheet/read';
import { writeCsv, writeXls, type SpreadsheetWriteSheet } from '$lib/server/spreadsheet/write';

/** Название, которое таблица прочитает как формулу, если его не обезвредить. */
const DANGEROUS_NAME = '=HYPERLINK("http://attacker.example","Отчёт")';

const SHEET: SpreadsheetWriteSheet = {
	name: 'Визиты',
	columns: [{ width: 40 }, { width: 14 }, { width: 12 }],
	rows: [
		['Организация', 'Дата визита', 'Участников'],
		['МГТУ им. Баумана', new Date(Date.UTC(2026, 8, 12)), 42],
		[DANGEROUS_NAME, null, 0],
		['Пустая строка ниже', new Date(Date.UTC(2026, 11, 31, 14, 30)), 12.5]
	]
};

const originalTimeZone = process.env.TZ;

afterEach(() => {
	process.env.TZ = originalTimeZone;
});

describe('книга XLS', () => {
	it('читается обратно со всеми значениями', () => {
		const sheet = readSpreadsheet(writeXls([SHEET]), 'выгрузка.xls').sheets[0];

		expect(sheet.name).toBe('Визиты');
		expect(sheet.rows[0]).toEqual(['Организация', 'Дата визита', 'Участников']);
		expect(sheet.rows[1]).toEqual(['МГТУ им. Баумана', new Date(Date.UTC(2026, 8, 12)), 42]);
		expect(sheet.rows[2]).toEqual([`'${DANGEROUS_NAME}`, null, 0]);
		expect(sheet.rows[3][2]).toBe(12.5);
	});

	it('это настоящий XLS, а не переименованный XLSX', () => {
		expect(readSpreadsheet(writeXls([SHEET]), 'выгрузка.xls').info.format).toBe('xls');
	});

	it('обезвреживает формулу в ячейке', () => {
		const sheet = readSpreadsheet(writeXls([SHEET]), 'выгрузка.xls').sheets[0];

		expect(sheet.rows[2][0]).toBe(`'${DANGEROUS_NAME}`);
		expect(String(sheet.rows[2][0]).startsWith('=')).toBe(false);
	});

	it('пишет дату одинаково в любом часовом поясе сервера', () => {
		const written = ['UTC', 'Europe/Moscow', 'America/New_York', 'Asia/Vladivostok'].map((zone) => {
			process.env.TZ = zone;

			const sheet = readSpreadsheet(writeXls([SHEET]), 'выгрузка.xls').sheets[0];

			return [sheet.rows[1][1], sheet.rows[3][1]];
		});

		for (const [day, moment] of written) {
			expect(day).toEqual(new Date(Date.UTC(2026, 8, 12)));
			expect(moment).toEqual(new Date(Date.UTC(2026, 11, 31, 14, 30)));
		}
	});

	it('пустая ячейка остаётся пустой, а ноль — нулём', () => {
		const sheet = readSpreadsheet(writeXls([SHEET]), 'выгрузка.xls').sheets[0];

		expect(sheet.rows[2][1]).toBeNull();
		expect(sheet.rows[2][2]).toBe(0);
	});

	it('пишет несколько листов подряд', () => {
		const content = readSpreadsheet(
			writeXls([SHEET, { name: 'Итоги', rows: [['Всего', 54]] }]),
			'выгрузка.xls'
		);

		expect(content.info.sheetNames).toEqual(['Визиты', 'Итоги']);
		expect(content.sheets[1].rows).toEqual([['Всего', 54]]);
	});

	it('отказывается от имени листа, которого формат не унесёт', () => {
		expect(() => writeXls([{ ...SHEET, name: 'Визиты 2026/2027' }])).toThrowError(
			expect.objectContaining({ problem: 'unsupported_value' })
		);
		expect(() => writeXls([{ ...SHEET, name: 'В'.repeat(32) }])).toThrowError(
			expect.objectContaining({ problem: 'unsupported_value' })
		);
		expect(() => writeXls([SHEET, { ...SHEET, rows: [] }])).toThrowError(
			expect.objectContaining({ problem: 'unsupported_value' })
		);
	});

	it('отказывается от даты, которую таблицы показывают со сдвигом', () => {
		expect(() =>
			writeXls([{ name: 'Архив', rows: [[new Date(Date.UTC(1899, 5, 1))]] }])
		).toThrowError(expect.objectContaining({ problem: 'unsupported_value' }));
	});
});

describe('текстовая выгрузка', () => {
	const ROWS = [
		['Организация', 'Дата визита', 'Доля %'],
		['Университет; филиал', new Date(Date.UTC(2026, 8, 12)), 12.5],
		[DANGEROUS_NAME, new Date(Date.UTC(2026, 11, 31, 14, 30)), null]
	];

	it('метка порядка байтов ставится только для UTF-8 и только по просьбе', () => {
		const withBom = writeCsv(ROWS, { encoding: 'utf-8', bom: true });
		const withoutBom = writeCsv(ROWS, { encoding: 'utf-8', bom: false });
		const ansi = writeCsv(ROWS, { encoding: 'windows-1251' });

		expect(withBom.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
		expect(withoutBom.subarray(0, 3)).not.toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
		expect(withBom.subarray(3)).toEqual(withoutBom);
		expect(ansi.subarray(0, 3)).not.toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
	});

	it('кириллица в windows-1251 читается обратно', () => {
		const content = readSpreadsheet(writeCsv(ROWS, { encoding: 'windows-1251' }), 'выгрузка.csv');

		expect(content.info).toMatchObject({
			format: 'csv',
			encoding: 'windows-1251',
			delimiter: ';'
		});
		expect(content.sheets[0].rows[1][0]).toBe('Университет; филиал');
	});

	it('кавычки ставятся только там, где без них строка развалится', () => {
		const text = writeCsv(ROWS, { encoding: 'utf-8', bom: false }).toString('utf8');

		expect(text.split('\r\n')[0]).toBe('Организация;Дата визита;Доля %');
		expect(text).toContain('"Университет; филиал"');
		expect(text).toContain('12.09.2026;12.5');
		// Время показывается, только если оно в значении есть.
		expect(text).toContain('31.12.2026 14:30');
	});

	it('обезвреживает формулу и в тексте', () => {
		const text = writeCsv(ROWS, { encoding: 'utf-8', bom: false }).toString('utf8');

		// Значение взято в кавычки, потому что в нём есть кавычки, — но апостроф
		// стоит внутри них, до знака равенства.
		expect(text).toContain(`"'=HYPERLINK(`);
		// Ни одно значение в файле не начинается со знака равенства.
		expect(/(^|[;\r\n])=/.test(text)).toBe(false);
	});

	it('не заменяет молча символ, которого нет в windows-1251', () => {
		expect(() => writeCsv([['Переход → на 2027 год']], { encoding: 'windows-1251' })).toThrowError(
			expect.objectContaining({ problem: 'encoding' })
		);
		expect(() =>
			writeCsv([['Переход → на 2027 год']], { encoding: 'utf-8', bom: true })
		).not.toThrow();
	});

	it('пишет дату одинаково в любом часовом поясе сервера', () => {
		const written = ['UTC', 'Europe/Moscow', 'America/New_York', 'Asia/Vladivostok'].map((zone) => {
			process.env.TZ = zone;

			return writeCsv(ROWS, { encoding: 'utf-8', bom: false }).toString('utf8');
		});

		expect(new Set(written).size).toBe(1);
		expect(written[0]).toContain('12.09.2026');
	});
});
