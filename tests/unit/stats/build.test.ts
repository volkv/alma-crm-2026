/**
 * Сборка строк снимка: что попадает в показатели, а что остаётся с претензией.
 *
 * Справочник здесь собран руками — правило разбора не зависит от базы, и
 * проверять его на настоящем PostgreSQL значило бы проверять PostgreSQL.
 */
import { describe, expect, it } from 'vitest';
import type { StatMapping } from '$lib/contracts/stats';
import { buildRows, missingRequiredFields } from '$lib/server/stats/build';
import type { DirectoryIndex } from '$lib/server/stats/lookup';
import type { StatTable } from '$lib/server/stats/parse';

const ORGANIZATION = '00000000-0000-4000-8000-0000000000b1';
const OTHER_ORGANIZATION = '00000000-0000-4000-8000-0000000000b2';
const PROGRAM = '00000000-0000-4000-8000-0000000000c1';
const SITE = '00000000-0000-4000-8000-0000000000d1';

const index: DirectoryIndex = {
	organizationByInn: new Map([['7802450127', [ORGANIZATION]]]),
	organizationByName: new Map([
		['сзпу', [ORGANIZATION]],
		['пупи', [OTHER_ORGANIZATION]],
		['политех', [ORGANIZATION, OTHER_ORGANIZATION]]
	]),
	programByCode: new Map([['vo bak 01', [PROGRAM]]]),
	programByName: new Map([['прикладная информатика', [PROGRAM]]]),
	siteByName: new Map([[`${ORGANIZATION} главный корпус`, [SITE]]])
};

const MAPPING: StatMapping = {
	Вуз: 'organization',
	Программа: 'program',
	Заявки: 'applications',
	Зачислено: 'enrolled'
};

const PERIOD = { start: '2026-09-01', end: '2027-08-31' };

/** Таблица так, как её отдаёт разбор: со строкой файла у каждой строки. */
function table(rows: string[][], headers = ['Вуз', 'Программа', 'Заявки', 'Зачислено']): StatTable {
	return {
		file: {
			fileName: 'выгрузка.csv',
			format: 'csv',
			encoding: 'utf-8',
			delimiter: ';',
			sheetName: 'Sheet1',
			sheetNames: ['Sheet1']
		},
		headers,
		// Шапка — первая строка файла, поэтому данные начинаются со второй.
		rows: rows.map((cells, index) => ({ origin: index + 2, cells })),
		totalRows: rows.length,
		warnings: []
	};
}

function build(rows: string[][], mapping: StatMapping = MAPPING, headers?: string[]) {
	return buildRows({ table: table(rows, headers), mapping, index, period: PERIOD });
}

describe('обязательные поля', () => {
	it('называет то, без чего строку не к чему отнести', () => {
		expect(missingRequiredFields({ Заявки: 'applications' })).toStrictEqual([
			'organization',
			'program'
		]);
		expect(missingRequiredFields(MAPPING)).toStrictEqual([]);
	});
});

describe('разбор строки', () => {
	it('находит организацию по названию и программу по коду', () => {
		const [row] = build([['СЗПУ', 'VO-BAK-01', '120', '90']]);

		expect(row.organizationId).toBe(ORGANIZATION);
		expect(row.programId).toBe(PROGRAM);
		expect(row.applications).toBe(120);
		expect(row.enrolled).toBe(90);
		expect(row.issues).toStrictEqual([]);
		expect(row.isValid).toBe(true);
	});

	it('находит организацию по ИНН', () => {
		const [row] = build([['7802450127', 'VO-BAK-01', '10', '5']]);

		expect(row.organizationId).toBe(ORGANIZATION);
		expect(row.isValid).toBe(true);
	});

	it('различает ноль и пропуск', () => {
		const [zero, missing] = build([
			['СЗПУ', 'VO-BAK-01', '0', '0'],
			['ПУПИ', 'Прикладная информатика', '', '']
		]);

		expect(zero.applications).toBe(0);
		expect(zero.enrolled).toBe(0);
		expect(zero.isValid).toBe(true);
		expect(missing.applications).toBeNull();
		expect(missing.enrolled).toBeNull();
		expect(missing.isValid).toBe(true);
	});

	it('объясняет неизвестную организацию и не берёт строку в показатели', () => {
		const [row] = build([['Институт цифровых технологий', 'VO-BAK-01', '10', '5']]);

		expect(row.organizationId).toBeNull();
		expect(row.isValid).toBe(false);
		expect(row.issues[0]).toMatchObject({ field: 'organization' });
		expect(row.issues[0].message).toContain('не найдена в справочнике');
	});

	it('отказывается выбирать между одноимёнными организациями', () => {
		const [row] = build([['Политех', 'VO-BAK-01', '10', '5']]);

		expect(row.organizationId).toBeNull();
		expect(row.issues[0].message).toContain('несколько записей справочника');
	});

	it('объясняет нечисловое значение и оставляет поле пустым', () => {
		const [row] = build([['СЗПУ', 'VO-BAK-01', 'много', '5']]);

		expect(row.applications).toBeNull();
		expect(row.isValid).toBe(false);
		expect(row.issues[0]).toMatchObject({ field: 'applications' });
		expect(row.issues[0].message).toContain('не похоже на целое число');
	});

	it('не принимает отрицательное число обучающихся', () => {
		const [row] = build([['СЗПУ', 'VO-BAK-01', '10', '-4']]);

		expect(row.enrolled).toBeNull();
		expect(row.isValid).toBe(false);
		expect(row.issues[0].message).toContain('отрицательное значение');
	});

	it('помечает дубль в обеих строках и называет номер соседней', () => {
		const rows = build([
			['СЗПУ', 'VO-BAK-01', '10', '5'],
			['СЗПУ', 'Прикладная информатика', '12', '6']
		]);

		expect(rows.every((row) => row.isValid)).toBe(false);

		for (const row of rows) {
			expect(row.issues.some((issue) => issue.message.startsWith('Дубль'))).toBe(true);
		}

		expect(rows[0].issues.at(-1)?.message).toContain('строке 2');
		expect(rows[1].issues.at(-1)?.message).toContain('строке 1');
	});

	it('берёт период снимка, когда колонок периода в файле нет', () => {
		const [row] = build([['СЗПУ', 'VO-BAK-01', '10', '5']]);

		expect(row.periodStart).toBe(PERIOD.start);
		expect(row.periodEnd).toBe(PERIOD.end);
	});

	it('читает период из файла и объясняет непонятную дату', () => {
		const mapping: StatMapping = { ...MAPPING, Начало: 'periodStart', Конец: 'periodEnd' };
		const headers = ['Вуз', 'Программа', 'Заявки', 'Зачислено', 'Начало', 'Конец'];

		const [good, bad] = buildRows({
			table: table(
				[
					['СЗПУ', 'VO-BAK-01', '10', '5', '01.09.2026', '31.12.2026'],
					['ПУПИ', 'Прикладная информатика', '10', '5', 'осень', '31.12.2026']
				],
				headers
			),
			mapping,
			index,
			period: PERIOD
		});

		expect(good.periodStart).toBe('2026-09-01');
		expect(good.periodEnd).toBe('2026-12-31');
		expect(bad.periodStart).toBe(PERIOD.start);
		expect(bad.issues[0]).toMatchObject({ field: 'periodStart' });
	});

	it('не записывает перевёрнутый период, но и не молчит о нём', () => {
		const mapping: StatMapping = { ...MAPPING, Начало: 'periodStart', Конец: 'periodEnd' };
		const headers = ['Вуз', 'Программа', 'Заявки', 'Зачислено', 'Начало', 'Конец'];

		const [row] = buildRows({
			table: table([['СЗПУ', 'VO-BAK-01', '10', '5', '01.09.2026', '01.08.2026']], headers),
			mapping,
			index,
			period: PERIOD
		});

		expect(row.periodStart).toBe(PERIOD.start);
		expect(row.periodEnd).toBe(PERIOD.end);
		expect(row.issues[0].message).toContain('раньше его начала');
		expect(row.isValid).toBe(false);
	});

	it('замечает значения сверх колонок шапки и называет строку файла', () => {
		const [row] = build([['СЗПУ', 'VO-BAK-01', '10', '5', 'лишнее']]);

		expect(row.issues[0].message).toContain('сверх колонок шапки');
		// Номер строки снимка ищут в файле руками: пустые строки и шапка в него
		// не считаются, поэтому претензия называет место в файле.
		expect(row.issues[0].message).toContain('строка 2 файла');
		expect(row.isValid).toBe(false);
	});

	it('сохраняет строку файла как есть', () => {
		const [row] = build([['СЗПУ', 'VO-BAK-01', '10', '']]);

		expect(row.raw).toStrictEqual({
			Вуз: 'СЗПУ',
			Программа: 'VO-BAK-01',
			Заявки: '10',
			Зачислено: ''
		});
	});

	it('находит площадку внутри организации', () => {
		const mapping: StatMapping = { ...MAPPING, Площадка: 'site' };
		const headers = ['Вуз', 'Программа', 'Заявки', 'Зачислено', 'Площадка'];

		const [own, alien] = buildRows({
			table: table(
				[
					['СЗПУ', 'VO-BAK-01', '10', '5', 'Главный корпус'],
					['ПУПИ', 'Прикладная информатика', '10', '5', 'Главный корпус']
				],
				headers
			),
			mapping,
			index,
			period: PERIOD
		});

		expect(own.siteId).toBe(SITE);
		expect(alien.siteId).toBeNull();
		expect(alien.issues[0].message).toContain('не найдена у этой организации');
	});
});
