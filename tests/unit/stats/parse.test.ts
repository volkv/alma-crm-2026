/**
 * Разбор файла снимка: таблица, JSON, числа и даты в том виде, в каком их
 * пишут в выгрузках.
 *
 * Главное здесь — что ноль, пропуск и мусор остаются тремя разными ответами.
 * Стоит им слиться в один, и «ноль заявок» станет неотличим от «колонку не
 * прислали», а отчёт — неверным.
 *
 * Второе главное — что формат берётся из содержимого файла. Имя файла выбирает
 * человек, и разбор, который ему верит, читает книгу как текст.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MAX_STAT_FILE_ROWS, MAX_STAT_JSON_DEPTH } from '$lib/contracts/stats';
import { ValidationError } from '$lib/server/errors';
import {
	describeRowOrigin,
	parseCalendarDate,
	parseCount,
	readStatTable
} from '$lib/server/stats/parse';

function bytes(text: string): Uint8Array {
	return new TextEncoder().encode(text);
}

function fixture(name: string): Buffer {
	return readFileSync(new URL(`../../fixtures/stats/${name}`, import.meta.url));
}

/** Строки таблицы без происхождения: так их проще сравнивать между форматами. */
function cells(table: { rows: readonly { cells: string[] }[] }): string[][] {
	return table.rows.map((row) => row.cells);
}

const HEADERS = [
	'Вуз',
	'Код программы',
	'Подано заявок',
	'Зачислено',
	'Параллельные потоки',
	'Завершили обучение'
];

const ROWS = [
	['СЗПУ', 'VO-BAK-01', '120', '90', '3', '80'],
	['ПУПИ', 'VO-MAG-01', '40', '30', '2', '25']
];

describe('одна выгрузка в пяти файлах', () => {
	it.each([
		{ name: 'enrollment.csv', format: 'csv', encoding: 'utf-8', delimiter: ';', sheet: 'Sheet1' },
		{
			name: 'enrollment-1251.csv',
			format: 'csv',
			encoding: 'windows-1251',
			delimiter: ';',
			sheet: 'Sheet1'
		},
		{ name: 'enrollment.xls', format: 'xls', encoding: null, delimiter: null, sheet: 'enrollment' },
		{
			name: 'enrollment-array.json',
			format: 'json',
			encoding: 'utf-8',
			delimiter: null,
			sheet: null
		},
		{
			name: 'enrollment-rows.json',
			format: 'json',
			encoding: 'utf-8',
			delimiter: null,
			sheet: null
		}
	])('$name: та же таблица, что и во всех остальных файлах', (file) => {
		const table = readStatTable(file.name, fixture(file.name));

		expect(table.headers).toStrictEqual(HEADERS);
		expect(cells(table)).toStrictEqual(ROWS);
		expect(table.totalRows).toBe(2);
		expect(table.warnings).toStrictEqual([]);
		expect(table.file).toStrictEqual({
			fileName: file.name,
			format: file.format,
			encoding: file.encoding,
			delimiter: file.delimiter,
			sheetName: file.sheet,
			sheetNames: file.format === 'json' ? [] : [file.sheet]
		});
	});
});

describe('таблица', () => {
	it('читает файл с точкой с запятой, как его сохраняет Excel', () => {
		const table = readStatTable('вузы.csv', bytes('Вуз;Заявки\r\nСЗПУ;120\r\nПУПИ;0\r\n'));

		expect(table.headers).toStrictEqual(['Вуз', 'Заявки']);
		expect(cells(table)).toStrictEqual([
			['СЗПУ', '120'],
			['ПУПИ', '0']
		]);
		expect(table.file.delimiter).toBe(';');
	});

	it('читает файл с запятой', () => {
		const table = readStatTable('вузы.csv', bytes('org,applications\nСЗПУ,120\n'));

		expect(cells(table)).toStrictEqual([['СЗПУ', '120']]);
		expect(table.file.delimiter).toBe(',');
	});

	it('не путает запятую внутри кавычек с разделителем', () => {
		const table = readStatTable(
			'вузы.csv',
			bytes('Вуз,Заявки\n"Университет, головной кампус",120\n')
		);

		expect(cells(table)).toStrictEqual([['Университет, головной кампус', '120']]);
	});

	it('понимает удвоенную кавычку внутри значения', () => {
		const table = readStatTable('вузы.csv', bytes('Вуз\n"АНО ""Сибирский институт"""\n'));

		expect(cells(table)).toStrictEqual([['АНО "Сибирский институт"']]);
	});

	it('снимает BOM с имени первой колонки', () => {
		const table = readStatTable('вузы.csv', bytes('﻿Вуз;Заявки\nСЗПУ;1\n'));

		expect(table.headers[0]).toBe('Вуз');
	});

	it('пропускает пустые строки между блоками и помнит, где строка лежала', () => {
		const table = readStatTable('вузы.csv', bytes('Вуз;Заявки\n\nСЗПУ;1\n\nПУПИ;2\n'));

		expect(cells(table)).toStrictEqual([
			['СЗПУ', '1'],
			['ПУПИ', '2']
		]);
		// Третья и пятая строки файла: пустые строки пропущены, но не забыты.
		expect(table.rows.map((row) => row.origin)).toStrictEqual([3, 5]);
	});

	it('даёт имя безымянной колонке и разводит одноимённые', () => {
		const table = readStatTable('вузы.csv', bytes('Вуз;;Вуз\nа;б;в\n'));

		expect(table.headers).toStrictEqual(['Вуз', 'Колонка 2', 'Вуз (2)']);
	});

	it('оставляет значение так, как оно написано: «12,5» — это не 125', () => {
		// SheetJS читает «12,5» числом 125, приняв запятую за разделитель
		// разрядов, а «0278000000» — числом без ведущего нуля. В текстовом файле
		// истина — написанное: иначе в отчёт попадут числа, которых никто не писал.
		const table = readStatTable('вузы.csv', bytes('ИНН;Доля\n0278000000;12,5\n'));

		expect(cells(table)).toStrictEqual([['0278000000', '12,5']]);
		expect(parseCount('12,5')).toBe('invalid');
	});

	it('читает книгу XLS, а числа и даты отдаёт текстом', () => {
		const table = readStatTable('enrollment.xls', fixture('enrollment.xls'));

		expect(table.file.format).toBe('xls');
		expect(cells(table)[0]).toStrictEqual(['СЗПУ', 'VO-BAK-01', '120', '90', '3', '80']);
	});

	it('считает все строки файла, даже когда читает не все', () => {
		const table = readStatTable('вузы.csv', bytes('Вуз\nа\nб\nв\n'), 2);

		expect(table.rows).toHaveLength(2);
		expect(table.totalRows).toBe(3);
	});

	it('отказывает пустому файлу словами', () => {
		expect(() => readStatTable('вузы.csv', bytes(''))).toThrowError('Файл «вузы.csv» пуст');
		expect(() => readStatTable('вузы.csv', bytes('\n\n'))).toThrowError(
			'В файле нет ни одной строки'
		);
	});

	it('не принимает за таблицу двоичный файл', () => {
		expect(() =>
			readStatTable('скан.png', Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
		).toThrowError('не похож на таблицу');
	});
});

describe('JSON', () => {
	it('читает массив объектов: ключи — это колонки', () => {
		const table = readStatTable(
			'выгрузка.json',
			bytes('[{"Вуз":"СЗПУ","Заявки":120},{"Вуз":"ПУПИ","Заявки":0}]')
		);

		expect(table.headers).toStrictEqual(['Вуз', 'Заявки']);
		expect(cells(table)).toStrictEqual([
			['СЗПУ', '120'],
			['ПУПИ', '0']
		]);
		expect(table.totalRows).toBe(2);
		// Элементы массива адресуются с нуля — так их покажет любой инструмент,
		// которым файл откроют.
		expect(table.rows.map((row) => row.origin)).toStrictEqual([0, 1]);
		expect(describeRowOrigin(table.file, 1)).toBe('элемент 1');
	});

	it.each(['rows', 'items', 'data'])('читает объект со списком по ключу «%s»', (key) => {
		const table = readStatTable('выгрузка.json', bytes(`{"${key}":[{"Вуз":"СЗПУ"}]}`));

		expect(cells(table)).toStrictEqual([['СЗПУ']]);
	});

	it('не выбирает между двумя списками сам', () => {
		expect(() =>
			readStatTable('выгрузка.json', bytes('{"rows":[{"Вуз":"СЗПУ"}],"data":[{"Вуз":"ПУПИ"}]}'))
		).toThrowError('несколько списков строк');
	});

	it('объясняет, что список не найден', () => {
		try {
			readStatTable('выгрузка.json', bytes('{"результат":[{"Вуз":"СЗПУ"}]}'));
			expect.unreachable('объект без известного ключа — это отказ');
		} catch (error) {
			expect(error).toBeInstanceOf(ValidationError);
			expect((error as ValidationError).message).toContain('не найден список строк');
			expect((error as ValidationError).issues.join(' ')).toContain('rows, items, data');
		}
	});

	it('разворачивает вложенный объект через точку, а массив — через индекс', () => {
		const table = readStatTable(
			'выгрузка.json',
			bytes('[{"org":{"name":"СЗПУ","inn":"7802450127"},"tags":["вуз","опорный"]}]')
		);

		expect(table.headers).toStrictEqual(['org.name', 'org.inn', 'tags.0', 'tags.1']);
		expect(cells(table)).toStrictEqual([['СЗПУ', '7802450127', 'вуз', 'опорный']]);
	});

	it('пустое значение остаётся пустым, а не словом «null»', () => {
		const table = readStatTable(
			'выгрузка.json',
			bytes('[{"Вуз":"СЗПУ","Завершили":null,"Площадка":{}}]')
		);

		expect(cells(table)).toStrictEqual([['СЗПУ', '', '']]);
	});

	it('разные наборы ключей — предупреждение, а не отказ', () => {
		const table = readStatTable(
			'выгрузка.json',
			bytes('[{"Вуз":"СЗПУ","Заявки":120},{"Вуз":"ПУПИ"},{"Вуз":"УГУИС","Потоки":2}]')
		);

		expect(table.headers).toStrictEqual(['Вуз', 'Заявки', 'Потоки']);
		expect(cells(table)).toStrictEqual([
			['СЗПУ', '120', ''],
			['ПУПИ', '', ''],
			['УГУИС', '', '2']
		]);
		// О каждой колонке говорится один раз — в первой записи, где её нет.
		expect(table.warnings).toStrictEqual([
			'Колонка «Потоки» есть не у всех записей: в элементе 0 её нет. Значение останется пустым.',
			'Колонка «Заявки» есть не у всех записей: в элементе 1 её нет. Значение останется пустым.'
		]);
	});

	it('пустая запись — это пустая строка, а не пустая колонка', () => {
		const table = readStatTable('выгрузка.json', bytes('[{"Вуз":"СЗПУ"},{}]'));

		expect(table.headers).toStrictEqual(['Вуз']);
		expect(cells(table)).toStrictEqual([['СЗПУ'], ['']]);
	});

	it('даёт имя безымянной колонке', () => {
		// `{"": 1}` — законный JSON, а колонка обязана быть адресуемой: по имени
		// хранится сопоставление.
		const table = readStatTable('выгрузка.json', bytes('[{"":"СЗПУ","Заявки":1}]'));

		expect(table.headers).toStrictEqual(['Колонка 1', 'Заявки']);
		expect(cells(table)).toStrictEqual([['СЗПУ', '1']]);
	});

	it('отказывает, когда в списке лежит не запись', () => {
		try {
			readStatTable('выгрузка.json', bytes('[{"Вуз":"СЗПУ"},42]'));
			expect.unreachable('число вместо записи — это отказ');
		} catch (error) {
			expect(error).toBeInstanceOf(ValidationError);
			expect((error as ValidationError).issues[0]).toContain('Элемент 1');
		}
	});

	it('отказывает пустому списку и сломанному JSON', () => {
		expect(() => readStatTable('выгрузка.json', bytes('[]'))).toThrowError(
			'В файле нет ни одной строки'
		);
		expect(() => readStatTable('выгрузка.json', bytes('[{"Вуз":"СЗПУ",}]'))).toThrowError(
			'не разбирается как JSON'
		);
	});

	it('не разворачивает дерево глубже названной границы', () => {
		const deep = `[${JSON.stringify({ a: { b: { c: { d: { e: { f: 1 } } } } } })}]`;

		try {
			readStatTable('выгрузка.json', bytes(deep));
			expect.unreachable('дерево глубже границы — это отказ');
		} catch (error) {
			expect(error).toBeInstanceOf(ValidationError);
			expect((error as ValidationError).message).toBe('JSON вложен слишком глубоко');
			expect((error as ValidationError).issues[0]).toContain(`глубже ${MAX_STAT_JSON_DEPTH}`);
		}
	});

	it('не принимает больше строк, чем разбирает за раз', () => {
		const many = JSON.stringify(
			Array.from({ length: MAX_STAT_FILE_ROWS + 1 }, () => ({ Вуз: 'СЗПУ' }))
		);

		expect(() => readStatTable('выгрузка.json', bytes(many))).toThrowError('слишком много строк');
	});

	it('формат берётся из содержимого, а не из имени файла', () => {
		// Тот же JSON под именем таблицы: разбор обязан прочитать его как JSON,
		// иначе первая строка файла станет шапкой из одной колонки «[{"Вуз":"СЗПУ"...».
		const table = readStatTable('выгрузка.csv', bytes('[{"Вуз":"СЗПУ","Заявки":120}]'));

		expect(table.file.format).toBe('json');
		expect(table.headers).toStrictEqual(['Вуз', 'Заявки']);
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
		expect(parseCount('12 345')).toBe(12345);
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
