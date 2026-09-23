import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readEducationPage, readStructPage, readSvedenPage } from '$lib/server/enrichment/sveden';

/**
 * Разбор трёх подразделов `/sveden` на урезанных страницах настоящей вёрстки:
 * таблицы с `rowspan`, отписки «нет», строки-дубли и скрипт с разметкой внутри
 * строки. ФИО и адреса почты в страницах заменены вымышленными.
 */
function fixture(name: string): string {
	return readFileSync(new URL(`../../fixtures/sveden/${name}`, import.meta.url), 'utf8');
}

describe('«Основные сведения»', () => {
	it('читает наименования, дату, адрес, почту и учредителя', () => {
		const report = readSvedenPage(
			'https://university.example.org/sveden/common',
			fixture('common.html')
		);

		expect(report.found).toBe(true);
		expect(report.fields.fullName).toMatch(/^федеральное государственное автономное/);
		expect(report.fields.shortName).toContain('МИЭТ');
		expect(report.fields.regDate).toBe('09 декабря 1965 г.');
		expect(report.fields.address).toContain('площадь Шокина');
		expect(report.fields.email).toBe('office@university.example.org.');
		expect(report.fields.founder).toContain('Министерство науки');
	});
});

describe('«Структура и органы управления»', () => {
	it('руководитель остаётся при своём подразделении, дубли и отписки отброшены', () => {
		const contacts = readStructPage(fixture('struct.html'));

		expect(contacts).toHaveLength(3);
		expect(contacts[1]).toEqual({
			unit: 'Кафедра информационной безопасности (ИБ)',
			name: 'Кузнецова Анна Павловна',
			post: 'заведующий кафедрой',
			email: 'kaf-sec@university.example.org',
			address: '124498, ЦФО, г. Москва, г. Зеленоград, пл. Шокина, д.1, МИЭТ, ауд. 3334'
		});
	});
});

describe('перечень образовательных программ', () => {
	it('код, уровень и направленность — из одной строки таблицы', () => {
		const programs = readEducationPage(fixture('eduop.html'));
		const psychology = programs.filter((program) => program.code === '37.03.01');

		expect(programs.every((program) => /^\d{2}\.\d{2}\.\d{2}$/.test(program.code))).toBe(true);
		expect(psychology).toHaveLength(2);
		expect(psychology[0]).toMatchObject({
			name: 'Психология',
			level: 'Высшее образование - бакалавриат',
			profile: 'Организационная психология',
			forms: ['Очная']
		});
		expect(programs.find((program) => program.code === '09.02.07')?.level).toMatch(
			/^Среднее профессиональное/
		);
	});
});
