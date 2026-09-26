/**
 * Разбор и сборка адреса списка взаимодействий: фильтры вуз, направление,
 * программа, продукт живут в адресе рядом со статусом и стадией.
 *
 * Проверяется ровно граница, которая ломается молча: испорченное значение
 * (не идентификатор) должно быть отброшено, а не 400-й ошибкой и не тихо
 * принятым мусором, который потом упадёт на слое базы данных.
 */
import { describe, expect, it } from 'vitest';
import {
	clearedFiltersHref,
	readFilters,
	toggledFilterHref
} from '../../../src/routes/(app)/w/[workspace]/interactions/filters';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '22222222-2222-4222-8222-222222222222';

function url(query: string): URL {
	return new URL(`http://localhost/w/b2b/interactions${query}`);
}

describe('разбор фильтров из адреса', () => {
	it('понимает направление через запятую и через повтор параметра одинаково', () => {
		expect(readFilters(url(`?dir=${ORG},${OTHER_ORG}`)).dir).toStrictEqual([ORG, OTHER_ORG]);
		expect(readFilters(url(`?dir=${ORG}&dir=${OTHER_ORG}`)).dir).toStrictEqual([ORG, OTHER_ORG]);
	});

	it('молча отбрасывает значение, которое не похоже на идентификатор', () => {
		expect(readFilters(url(`?org=${ORG},не-уид,`)).org).toStrictEqual([ORG]);
	});

	it('по умолчанию — пустые списки, как у остальных фильтров', () => {
		const filters = readFilters(url(''));

		expect(filters.org).toStrictEqual([]);
		expect(filters.dir).toStrictEqual([]);
		expect(filters.prog).toStrictEqual([]);
		expect(filters.prod).toStrictEqual([]);
	});
});

describe('сборка ссылки', () => {
	it('добавляет и снимает значение многозначного фильтра, не трогая остальные', () => {
		const withOrg = toggledFilterHref(url('?status=active'), 'b2b', 'org', ORG);

		expect(withOrg).toContain('org=' + ORG);
		expect(withOrg).toContain('status=active');

		const withBoth = toggledFilterHref(url(`?org=${ORG}`), 'b2b', 'org', OTHER_ORG);

		expect(withBoth).toContain(`org=${ORG}%2C${OTHER_ORG}`);

		const withoutOrg = toggledFilterHref(url(`?org=${ORG}`), 'b2b', 'org', ORG);

		expect(withoutOrg).not.toContain('org=');
	});

	it('сброс фильтров снимает и вуз, и направление, и программу, и продукт', () => {
		const cleared = clearedFiltersHref(
			url(`?status=active&org=${ORG}&dir=${ORG}&prog=${ORG}&prod=${ORG}`),
			'b2b'
		);

		expect(cleared).not.toContain('org=');
		expect(cleared).not.toContain('dir=');
		expect(cleared).not.toContain('prog=');
		expect(cleared).not.toContain('prod=');
		expect(cleared).not.toContain('status=');
	});
});

describe('фильтр по ответственным', () => {
	it('читает ответственных из адреса и снимает их общим сбросом', () => {
		expect(readFilters(url(`?owner=${ORG},${OTHER_ORG}`)).owner).toStrictEqual([ORG, OTHER_ORG]);
		expect(clearedFiltersHref(url(`?owner=${ORG}`), 'b2b')).not.toContain('owner=');
	});

	it('добавляет и снимает ответственного, сбрасывая номер страницы', () => {
		const added = toggledFilterHref(url('?page=3'), 'b2b', 'owner', ORG);

		expect(added).toContain(`owner=${ORG}`);
		expect(added).not.toContain('page=');
		expect(toggledFilterHref(url(`?owner=${ORG}`), 'b2b', 'owner', ORG)).not.toContain('owner=');
	});
});
