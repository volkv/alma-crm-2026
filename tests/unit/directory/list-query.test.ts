/**
 * Разбор строки запроса списков справочника.
 *
 * Строка запроса — пользовательский ввод: её правят руками, присылают в
 * ссылке и режут при копировании. Непонятное значение обязано означать «без
 * фильтра», а не пятисотую страницу, и уж точно не имя столбца, попавшее в
 * `order by`.
 */
import { describe, expect, it } from 'vitest';
import {
	DIRECTION_SORT_KEYS,
	directionDirectoryQuerySchema,
	ORGANIZATION_SORT_KEYS,
	organizationDirectoryQuerySchema,
	peopleListQuerySchema,
	productDirectoryQuerySchema,
	programDirectoryQuerySchema
} from '$lib/contracts/directory';

describe('список организаций', () => {
	it('без параметров даёт первую страницу без фильтров', () => {
		expect(organizationDirectoryQuerySchema.parse({})).toEqual({
			kind: null,
			educationLevel: null,
			q: null,
			sortBy: 'shortName',
			sortDirection: 'asc',
			page: 1,
			pageSize: 20
		});
	});

	it('принимает фильтры и сортировку из адреса', () => {
		expect(
			organizationDirectoryQuerySchema.parse({
				kind: 'operator',
				educationLevel: 'spo',
				q: '  Политех  ',
				sortBy: 'region',
				sortDirection: 'desc',
				page: 3,
				pageSize: 50
			})
		).toEqual({
			kind: 'operator',
			educationLevel: 'spo',
			q: 'Политех',
			sortBy: 'region',
			sortDirection: 'desc',
			page: 3,
			pageSize: 50
		});
	});

	it('превращает непонятный фильтр в отсутствие фильтра, а не в ошибку', () => {
		const parsed = organizationDirectoryQuerySchema.parse({
			kind: 'чушь',
			educationLevel: 42,
			sortDirection: 'вниз'
		});

		expect(parsed.kind).toBeNull();
		expect(parsed.educationLevel).toBeNull();
		expect(parsed.sortDirection).toBe('asc');
	});

	it('не пропускает в сортировку колонку вне словаря', () => {
		const parsed = organizationDirectoryQuerySchema.parse({ sortBy: 'inn; drop table' });

		expect(parsed.sortBy).toBe('shortName');
		expect(ORGANIZATION_SORT_KEYS).toContain(parsed.sortBy);
	});

	it('превращает пустой поиск в отсутствие поиска', () => {
		expect(organizationDirectoryQuerySchema.parse({ q: '   ' }).q).toBeNull();
	});
});

describe('остальные списки', () => {
	it('дают свои значения по умолчанию', () => {
		expect(peopleListQuerySchema.parse({})).toMatchObject({
			organizationId: null,
			sortBy: 'lastName',
			sortDirection: 'asc'
		});
		// Программы по умолчанию идут ручным приоритетом: справочник для того и
		// существует, чтобы оператор сам решал, что предлагать вузу первым.
		expect(programDirectoryQuerySchema.parse({})).toMatchObject({
			level: null,
			status: null,
			sortBy: 'priority',
			sortDirection: 'asc'
		});
		expect(productDirectoryQuerySchema.parse({})).toMatchObject({ status: null, sortBy: 'code' });
		expect(directionDirectoryQuerySchema.parse({})).toMatchObject({
			state: null,
			q: null,
			sortBy: 'position',
			sortDirection: 'asc'
		});
	});

	it('отвергают идентификатор организации, который не идентификатор', () => {
		expect(peopleListQuerySchema.safeParse({ organizationId: 'не-uuid' }).success).toBe(false);
	});

	it('не пропускают в сортировку программ и продуктов чужую колонку', () => {
		expect(programDirectoryQuerySchema.parse({ sortBy: 'secret' }).sortBy).toBe('priority');
		expect(productDirectoryQuerySchema.parse({ sortBy: 'secret' }).sortBy).toBe('code');
	});

	it('не пропускают в сортировку направлений чужую колонку и чужое состояние', () => {
		const parsed = directionDirectoryQuerySchema.parse({
			sortBy: 'position; drop table',
			state: 'чушь'
		});

		expect(parsed.sortBy).toBe('position');
		expect(DIRECTION_SORT_KEYS).toContain(parsed.sortBy);
		// Непонятное состояние — это «без фильтра», а не отказ страницы.
		expect(parsed.state).toBeNull();
	});
});
