/**
 * Книга отчёта по данным об обучении.
 *
 * Две вещи, которые ломаются молча и потому проверяются здесь:
 *
 * - **формула в ячейке.** Название организации приезжает из чужой выгрузки, и
 *   значение, начинающееся с `=`, таблица выполнит у того, кто открыл файл;
 * - **число строкой.** Строка «1 234» не суммируется и не сортируется, но
 *   выглядит в ячейке ровно как число.
 *
 * Книга собирается и тут же читается обратно: проверять надо то, что окажется
 * в файле, а не то, что передали в библиотеку.
 */
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import type { StatDashboardView } from '$lib/contracts/stats';
import { buildStatsReport, statsReportFileName } from '$lib/server/stats/export';

/** Название, которое таблица прочитает как формулу, если его не обезвредить. */
const DANGEROUS_NAME = '=HYPERLINK("http://attacker.example","Отчёт")';

const DAY = '2026-09-12';

const VIEW: StatDashboardView = {
	period: { kind: 'academic', start: '2026-09-01', end: '2027-08-31' },
	totals: {
		programCount: 2,
		organizationCount: 2,
		siteCount: 1,
		applications: 240,
		// Ноль записан в выгрузке: в отчёте он обязан остаться нулём.
		enrolled: 0,
		parallelStreams: 3,
		// Данных нет: в отчёте это пустая ячейка, а не ноль.
		completed: null,
		coveragePlan: 400,
		coverageFact: 300
	},
	groups: [
		{
			group: 'university',
			programCount: 1,
			applications: 200,
			enrolled: 0,
			parallelStreams: 2,
			completed: null,
			coveragePlan: 300,
			coverageFact: 240
		},
		{
			group: 'school',
			programCount: 1,
			applications: 40,
			enrolled: 0,
			parallelStreams: 1,
			completed: null,
			coveragePlan: 100,
			coverageFact: 60
		}
	],
	organizations: [
		{
			organizationId: '00000000-0000-4000-8000-000000000001',
			organizationName: DANGEROUS_NAME,
			programCount: 1,
			applications: 200,
			enrolled: 0,
			parallelStreams: 2,
			completed: null,
			coveragePlan: 300,
			coverageFact: 240
		},
		{
			organizationId: '00000000-0000-4000-8000-000000000002',
			organizationName: 'Академия связи',
			programCount: 1,
			applications: 40,
			enrolled: 0,
			parallelStreams: 1,
			completed: null,
			coveragePlan: 100,
			coverageFact: 60
		}
	],
	ranking: [
		{
			programId: '00000000-0000-4000-8000-000000000101',
			programCode: 'VO-BAK-01',
			programName: 'Прикладная информатика',
			score: 210,
			explanation: [
				{ component: 'applications', value: 200, weight: 1, contribution: 200 },
				{ component: 'enrolled', value: 0, weight: 2, contribution: 0 },
				{ component: 'parallelStreams', value: 2, weight: 5, contribution: 10 }
			],
			organizationCount: 1
		}
	],
	sources: [
		{
			snapshotId: '00000000-0000-4000-8000-000000000201',
			source: 'file',
			mode: 'full',
			fileName: '+79990000000 выгрузка.csv',
			authorName: 'Тестовый Менеджер',
			confirmedAt: '2026-09-10T08:40:00.000Z',
			rowCount: 2
		}
	],
	updatedAt: '2026-09-10T08:40:00.000Z'
};

async function readReport(view: StatDashboardView = VIEW): Promise<ExcelJS.Workbook> {
	const report = await buildStatsReport(view, DAY);
	const workbook = new ExcelJS.Workbook();

	// Так же, как читает книгу импорт: у exceljs собственный `Buffer extends
	// ArrayBuffer`, и содержимое передаётся отдельным буфером.
	await workbook.xlsx.load(report.body.slice().buffer as ArrayBuffer);

	return workbook;
}

function sheet(workbook: ExcelJS.Workbook, name: string): ExcelJS.Worksheet {
	const found = workbook.getWorksheet(name);

	if (found === undefined) {
		throw new Error(`В книге нет листа «${name}»`);
	}

	return found;
}

/** Значения строки листа, считая колонки с нуля. */
function rowValues(worksheet: ExcelJS.Worksheet, rowNumber: number): unknown[] {
	return (worksheet.getRow(rowNumber).values as unknown[]).slice(1);
}

function findRow(worksheet: ExcelJS.Worksheet, text: string): unknown[] {
	for (let index = 1; index <= worksheet.rowCount; index += 1) {
		const values = rowValues(worksheet, index);

		if (values.some((value) => typeof value === 'string' && value.includes(text))) {
			return values;
		}
	}

	throw new Error(`На листе «${worksheet.name}» нет строки со словом «${text}»`);
}

describe('обезвреживание формул', () => {
	// Само правило проверяется в `tests/unit/spreadsheet.test.ts`; здесь — то,
	// что книга через него действительно проходит.
	it('уносит в книгу название организации текстом, а не формулой', async () => {
		const workbook = await readReport();
		const organizations = sheet(workbook, 'Вузы и площадки');
		const row = findRow(organizations, 'HYPERLINK');

		expect(row[0]).toBe(`'${DANGEROUS_NAME}`);
		expect(organizations.getCell(2, 1).formula).toBeUndefined();
	});

	it('обезвреживает и имя файла в происхождении', async () => {
		const row = findRow(sheet(await readReport(), 'Источники'), '79990000000');

		expect(row[2]).toBe("'+79990000000 выгрузка.csv");
	});
});

describe('числа отчёта', () => {
	it('пишет показатели числами, а не строками', async () => {
		const row = findRow(sheet(await readReport(), 'Вузы и площадки'), 'Академия связи');

		expect(row[1]).toBe(1);
		expect(row[2]).toBe(40);
		expect(row[3]).toBe(0);
	});

	it('различает записанный ноль и отсутствие данных', async () => {
		const row = findRow(sheet(await readReport(), 'Вузы и площадки'), 'Академия связи');

		// «Зачислено» — ноль из выгрузки, «завершили обучение» — пустая ячейка.
		expect(row[3]).toBe(0);
		expect(row[5]).toBeUndefined();
	});

	it('раскладывает балл программы на слагаемые и их вклад', async () => {
		const row = findRow(sheet(await readReport(), 'Программы'), 'Прикладная информатика');

		expect(row[3]).toBe(210);
		expect(row.slice(5)).toStrictEqual([200, 200, 0, 0, 2, 10]);
	});

	it('называет период и актуальность на листе «Сводка»', async () => {
		const summary = sheet(await readReport(), 'Сводка');

		expect(findRow(summary, 'Отчётный период')[1]).toContain('01.09.2026');
		expect(findRow(summary, 'Данные актуальны на')[1]).toContain('10.09.2026');
		expect(findRow(summary, 'Школьные программы')[1]).toBe(1);
	});

	it('пишет рядом с пустой ячейкой, что данных нет, а не ноль', async () => {
		const summary = sheet(await readReport(), 'Сводка');
		const missing = findRow(summary, 'завершили обучение');
		const zero = findRow(summary, 'Обучающиеся');

		expect(missing[1]).toBeUndefined();
		expect(missing[2]).toBe('нет данных');
		expect(zero[1]).toBe(0);
		expect(zero[2]).not.toBe('нет данных');
	});
});

describe('имя файла', () => {
	it('называет период и день выгрузки', () => {
		const name = statsReportFileName({ start: '2026-09-01', end: '2027-08-31' }, DAY);

		expect(name).toContain('2026-09-01');
		expect(name).toContain('2027-08-31');
		expect(name.endsWith(`на ${DAY}.xlsx`)).toBe(true);
	});

	it('стоит на книге целиком вместе с типом файла', async () => {
		const report = await buildStatsReport(VIEW, DAY);

		expect(report.fileName).toBe(statsReportFileName(VIEW.period, DAY));
		expect(report.contentType).toBe(
			'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
		);
	});

	it('собирает четыре листа отчёта', async () => {
		const workbook = await readReport();

		expect(workbook.worksheets.map((worksheet) => worksheet.name)).toStrictEqual([
			'Сводка',
			'Программы',
			'Вузы и площадки',
			'Источники'
		]);
	});
});
