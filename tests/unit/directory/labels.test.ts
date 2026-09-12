/**
 * Словари названий справочника.
 *
 * Коды перечислений человек не читает, поэтому у каждого значения обязан быть
 * русский перевод. Забытое значение — это `undefined` в ячейке таблицы, и
 * заметят его на демонстрации, а не в коде.
 */
import { describe, expect, it } from 'vitest';
import {
	AFFILIATION_ROLE_OPTIONS,
	EDUCATION_LEVEL_OPTIONS,
	LIFECYCLE_STATUS_OPTIONS,
	NO_OPTION,
	ORGANIZATION_KIND_LABELS,
	ORGANIZATION_KIND_OPTIONS,
	PROGRAM_LEVEL_OPTIONS,
	SITE_KIND_OPTIONS,
	toLookupOptions,
	withEmptyOption
} from '$lib/components/directory/labels';
import {
	AFFILIATION_ROLE_KINDS,
	EDUCATION_LEVELS,
	LIFECYCLE_STATUSES,
	ORGANIZATION_KINDS,
	PROGRAM_LEVELS,
	SITE_KINDS
} from '$lib/contracts/directory';

const cases = [
	['вид организации', ORGANIZATION_KINDS, ORGANIZATION_KIND_OPTIONS],
	['уровень образования', EDUCATION_LEVELS, EDUCATION_LEVEL_OPTIONS],
	['вид площадки', SITE_KINDS, SITE_KIND_OPTIONS],
	['роль в организации', AFFILIATION_ROLE_KINDS, AFFILIATION_ROLE_OPTIONS],
	['уровень программы', PROGRAM_LEVELS, PROGRAM_LEVEL_OPTIONS],
	['состояние записи', LIFECYCLE_STATUSES, LIFECYCLE_STATUS_OPTIONS]
] as const;

describe.each(cases)('%s', (_name, values, options) => {
	it('переведён целиком и в том же порядке', () => {
		expect(options.map((option) => option.value)).toEqual([...values]);
	});

	it('не оставляет пустых подписей', () => {
		for (const option of options) {
			expect(option.label.trim().length).toBeGreaterThan(0);
			expect(option.label).not.toBe(option.value);
		}
	});
});

describe('варианты выбора', () => {
	it('ставят «ничего не выбрано» первым и отдельным значением', () => {
		const options = withEmptyOption(ORGANIZATION_KIND_OPTIONS, 'Не указан');

		expect(options[0]).toEqual({ value: NO_OPTION, label: 'Не указан' });
		expect(options.map((option) => option.value)).not.toContain('');
		expect(ORGANIZATION_KINDS).not.toContain(NO_OPTION);
	});

	it('переводят строки справочника в варианты как есть', () => {
		const rows = [{ id: 'a1', label: 'МГТУ' }];

		expect(toLookupOptions(rows)).toEqual([{ value: 'a1', label: 'МГТУ' }]);
		expect(toLookupOptions(rows, 'Без площадки')).toEqual([
			{ value: NO_OPTION, label: 'Без площадки' },
			{ value: 'a1', label: 'МГТУ' }
		]);
	});

	it('называет вид организации словами', () => {
		expect(ORGANIZATION_KIND_LABELS.educational_institution).toBe('Учебное заведение');
	});
});
