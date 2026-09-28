import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MANAGEMENT_UNIT, normalizeUnitName } from '$lib/contracts/enrichment';
import {
	mergeContactCandidates,
	readManagersPage,
	readStructPage,
	readStructUnits
} from '$lib/server/enrichment/sveden';

/**
 * Подразделения и «Руководство» с сайта вуза: то, что формы карточки дела
 * предлагают завести площадками и контактами. ФИО и адреса в страницах
 * вымышленные.
 */
function fixture(name: string): string {
	return readFileSync(new URL(`../../fixtures/sveden/${name}`, import.meta.url), 'utf8');
}

describe('подразделения из «Структуры»', () => {
	const units = readStructUnits(fixture('struct.html'));

	it('строка без руководителя остаётся подразделением, повтор названия — нет', () => {
		const names = units.map((unit) => unit.name);

		expect(names).toContain('Конференция работников и обучающихся');
		expect(names.filter((name) => name.startsWith('Кафедра высшей математики'))).toHaveLength(1);
		// Кандидатом в контакты строка без ФИО по-прежнему не становится.
		expect(readStructPage(fixture('struct.html')).map((row) => row.unit)).not.toContain(
			'Конференция работников и обучающихся'
		);
	});

	it('адрес, почта и страница подразделения — из своих ячеек', () => {
		expect(units.find((unit) => unit.name.includes('(ИБ)'))).toEqual({
			name: 'Кафедра информационной безопасности (ИБ)',
			address: '124498, ЦФО, г. Москва, г. Зеленоград, пл. Шокина, д.1, МИЭТ, ауд. 3334',
			email: 'kaf-sec@university.example.org',
			phone: null,
			site: 'https://university.example.org/structure/s/1270'
		});
	});

	it('строка руководства — должность, а не подразделение', () => {
		const rows = `
<table>
<tr itemprop="structOrgUprav"><td itemprop="name">Проректор по АХР</td><td itemprop="fio">Сидоров Иван Ильич</td></tr>
<tr itemprop="structOrgUprav"><td itemprop="name">Кафедра «Прикладная математика»</td><td itemprop="fio">нет</td><td itemprop="site">нет</td></tr>
</table>`;

		expect(readStructUnits(rows)).toEqual([
			{
				name: 'Кафедра «Прикладная математика»',
				address: null,
				email: null,
				phone: null,
				site: null
			}
		]);
	});

	it('сверка названий терпима к регистру, «ё» и кавычкам', () => {
		expect(normalizeUnitName('Кафедра «Прикладная математика»')).toBe(
			normalizeUnitName('кафедра прикладная  математика')
		);
		expect(normalizeUnitName('Учёный совет')).toBe(normalizeUnitName('Ученый совет'));
	});
});

describe('«Руководство»', () => {
	const managers = readManagersPage(fixture('managers.html'));

	it('руководитель, заместители и филиалы; контейнер таблицы и отписка отброшены', () => {
		expect(managers.map(({ unit, name, post }) => ({ unit, name, post }))).toEqual([
			{ unit: MANAGEMENT_UNIT, name: 'Орлов Николай Андреевич', post: 'Ректор' },
			{ unit: MANAGEMENT_UNIT, name: 'Белова Ирина Сергеевна', post: 'первый проректор' },
			{
				unit: MANAGEMENT_UNIT,
				name: 'Кузнецова Анна Павловна',
				post: 'Проректор по учебной работе'
			},
			{ unit: MANAGEMENT_UNIT, name: 'Громов Павел Ильич', post: 'директор (Северный филиал)' }
		]);
		expect(managers[0]).toMatchObject({
			email: 'rector@university.example.org',
			phone: '+7 (000) 000-10-01'
		});
	});

	it('человек из обоих подразделов — один кандидат из «Руководства» с почтой из «Структуры»', () => {
		const contacts = mergeContactCandidates(managers, readStructPage(fixture('struct.html')));
		const kuznetsova = contacts.filter((row) => row.name === 'Кузнецова Анна Павловна');

		expect(kuznetsova).toHaveLength(1);
		expect(kuznetsova[0]).toMatchObject({
			unit: MANAGEMENT_UNIT,
			email: 'kaf-sec@university.example.org'
		});
		// «Руководство» — первым: потолок списка не отрежет ректора ради кафедр.
		expect(contacts[0].name).toBe('Орлов Николай Андреевич');
		expect(contacts.map((row) => row.name)).toContain('Сидоров Сергей Сергеевич');
	});
});
