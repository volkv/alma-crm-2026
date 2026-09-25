/**
 * Книга загрузки пользователей в систему обучения.
 *
 * Шаблон чужой, и загрузчик сверяет шапку строками: переставленная колонка
 * или «исправленная» опечатка в названии ломают загрузку у заказчика, а не
 * здесь. Поэтому книга собирается и тут же читается обратно — проверяется то,
 * что окажется в файле, а не то, что передали библиотеке.
 */
import ExcelJS from 'exceljs';
import PizZip from 'pizzip';
import { describe, expect, it } from 'vitest';
import {
	buildLmsUserWorkbook,
	LMS_USER_TEMPLATE_EDUCATION,
	LMS_USER_TEMPLATE_GENDERS,
	LMS_USER_TEMPLATE_HEADERS,
	type LmsUserRow
} from '$lib/server/integrations/exchange/roster-export';
import { readRosterFile } from '$lib/server/integrations/exchange/roster';

const DANGEROUS_NAME = '=HYPERLINK("http://attacker.example.test","Список")';

const ROWS: LmsUserRow[] = [
	{
		lastName: 'Орлова',
		firstName: 'Вера',
		middleName: 'Сергеевна',
		phone: '8 (916) 123-45-67',
		email: 'vera.orlova@example.test'
	},
	{
		lastName: 'Климов',
		firstName: 'Тимур',
		middleName: null,
		phone: '916 123-45-67',
		email: 'timur.klimov@example.test'
	},
	{
		lastName: DANGEROUS_NAME,
		firstName: 'Глеб',
		middleName: null,
		phone: '+44 20 7946 0000',
		email: 'gleb@example.test'
	}
];

async function load(bytes: Uint8Array): Promise<ExcelJS.Workbook> {
	const workbook = new ExcelJS.Workbook();

	await workbook.xlsx.load(bytes.buffer as ArrayBuffer);

	return workbook;
}

/**
 * Проверки данных первого листа так, как они записаны в файле. ExcelJS при
 * чтении раскладывает диапазоны по ячейкам, и перекрытые правила в нём
 * неотличимы от одного — поэтому читается сам XML листа.
 */
function writtenValidations(bytes: Uint8Array): { sqref: string; formula: string }[] {
	const xml = new PizZip(bytes).file('xl/worksheets/sheet1.xml')?.asText();

	if (xml === undefined) {
		throw new Error('В книге нет первого листа');
	}

	return [
		...xml.matchAll(/<dataValidation\b[^>]*\bsqref="([^"]+)"[^>]*>\s*<formula1>([^<]*)</g)
	].map(([, sqref, formula]) => ({ sqref, formula }));
}

function sheet(workbook: ExcelJS.Workbook, name: string): ExcelJS.Worksheet {
	const found = workbook.getWorksheet(name);

	if (found === undefined) {
		throw new Error(`Нет листа ${name}`);
	}

	return found;
}

describe('buildLmsUserWorkbook', () => {
	it('повторяет шаблон LMS и заполняет только ФИО, телефон и почту', async () => {
		const workbook = await load(await buildLmsUserWorkbook(ROWS));
		const users = sheet(workbook, 'Лист1');
		const lists = sheet(workbook, 'Лист2');

		const header = users.getRow(1);
		expect(LMS_USER_TEMPLATE_HEADERS).toHaveLength(30);
		expect(
			LMS_USER_TEMPLATE_HEADERS.map((_, index) => header.getCell(index + 1).value)
		).toStrictEqual([...LMS_USER_TEMPLATE_HEADERS]);
		expect(header.getCell(3).value).toBe('Отчествопри наличии)');
		// Как в шаблоне: жирная вся шапка A–AD, по центру — только A–F.
		for (let column = 1; column <= LMS_USER_TEMPLATE_HEADERS.length; column += 1) {
			expect(header.getCell(column).font?.bold, `шапка ${column}`).toBe(true);
			expect(header.getCell(column).alignment?.horizontal, `шапка ${column}`).toBe(
				column <= 6 ? 'center' : undefined
			);
		}

		for (let row = 2; row <= ROWS.length + 1; row += 1) {
			for (let column = 6; column <= 30; column += 1) {
				expect(users.getRow(row).getCell(column).value, `${row}:${column}`).toBeNull();
			}
		}

		const [orlova, klimov, gleb] = [2, 3, 4].map((row) => users.getRow(row));

		expect([1, 2, 3, 4, 5].map((column) => orlova.getCell(column).value)).toStrictEqual([
			'Орлова',
			'Вера',
			'Сергеевна',
			79161234567,
			'vera.orlova@example.test'
		]);
		expect(klimov.getCell(3).value).toBeNull();
		expect(klimov.getCell(4).value).toBe('916 123-45-67');
		expect(gleb.getCell(1).value).toBe(`'${DANGEROUS_NAME}`);
		// Телефон строкой тоже текст из справочника: плюс впереди — начало формулы.
		expect(gleb.getCell(4).value).toBe(`'+44 20 7946 0000`);

		expect(lists.getColumn(1).values.slice(1)).toStrictEqual([...LMS_USER_TEMPLATE_GENDERS]);
		expect(lists.getColumn(2).values.slice(1)).toStrictEqual([...LMS_USER_TEMPLATE_EDUCATION]);
		expect(LMS_USER_TEMPLATE_EDUCATION[4]).toBe('Высшее образование – бакалавриат');

		for (const address of ['L2', 'L1001']) {
			expect(users.getCell(address).dataValidation).toMatchObject({
				type: 'list',
				formulae: ['Лист2!$A$1:$A$2']
			});
		}

		for (const address of ['W2', 'W1001']) {
			expect(users.getCell(address).dataValidation).toMatchObject({
				type: 'list',
				formulae: ['Лист2!$B$1:$B$7']
			});
		}

		expect(users.getCell('L1').dataValidation).toBeUndefined();

		// Ширины колонок — как в шаблоне; у L своей ширины нет и там.
		expect(users.getColumn('I').width).toBe(19.57);
		expect(users.getColumn('W').width).toBe(37.14);
		expect(users.getColumn('L').width).toBeUndefined();
	});

	it('пишет по одному правилу проверки данных на колонку, без перекрытий', async () => {
		expect(writtenValidations(await buildLmsUserWorkbook(ROWS))).toStrictEqual([
			{ sqref: 'L2:L1001', formula: 'Лист2!$A$1:$A$2' },
			{ sqref: 'W2:W1001', formula: 'Лист2!$B$1:$B$7' }
		]);

		// Слушателей больше заготовленных строк — правило растягивается до
		// последнего, а не обрывается на 1001-й.
		const many = Array.from({ length: 1200 }, (_, index) => ({
			...ROWS[0],
			email: `learner${index}@example.test`
		}));

		expect(
			writtenValidations(await buildLmsUserWorkbook(many)).map(({ sqref }) => sqref)
		).toStrictEqual(['L2:L1201', 'W2:W1201']);
	});

	it('читается обратно загрузкой списка в CRM', async () => {
		const parsed = readRosterFile('roster.xlsx', await buildLmsUserWorkbook(ROWS.slice(0, 2)));

		// Второй лист со справочниками — часть шаблона, а не слушатели: о нём
		// загрузка не предупреждает.
		expect(parsed.fileIssues).toStrictEqual([]);
		expect(
			parsed.rows.map((row) => ({ name: row.name, email: row.email, phone: row.phone }))
		).toStrictEqual([
			{
				name: { lastName: 'Орлова', firstName: 'Вера', middleName: 'Сергеевна' },
				email: 'vera.orlova@example.test',
				phone: '79161234567'
			},
			{
				name: { lastName: 'Климов', firstName: 'Тимур', middleName: null },
				email: 'timur.klimov@example.test',
				phone: '916 123-45-67'
			}
		]);
	});

	it('предупреждает о лишних листах, только если на них похоже на данные', async () => {
		const workbook = new ExcelJS.Workbook();

		workbook.addWorksheet('Список').addRows([
			['ФИО', 'Почта'],
			['Орлова Вера Сергеевна', 'vera.orlova@example.test']
		]);
		workbook.addWorksheet('Справочник').addRows([
			['М', LMS_USER_TEMPLATE_EDUCATION[0]],
			['Ж', LMS_USER_TEMPLATE_EDUCATION[1]]
		]);

		const listsOnly = new Uint8Array((await workbook.xlsx.writeBuffer()) as ArrayBuffer);

		expect(readRosterFile('roster.xlsx', listsOnly).fileIssues).toStrictEqual([]);

		workbook.addWorksheet('Второй поток').addRows([
			['ФИО', 'Почта'],
			['Климов Тимур', 'timur.klimov@example.test']
		]);

		const withData = new Uint8Array((await workbook.xlsx.writeBuffer()) as ArrayBuffer);

		expect(readRosterFile('roster.xlsx', withData).fileIssues).toStrictEqual([
			'В файле 3 листа — прочитан первый, «Список». Остальные не загружаются.'
		]);
	});
});
