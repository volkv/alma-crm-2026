/**
 * Название организации в сравнимом виде: правовая форма — сокращением.
 *
 * В файле заказчика пишут «ООО «РТК ИТ»», а в полном названии карточки —
 * «Общество с ограниченной ответственностью «РТК ИТ»». Импорт обязан узнать в
 * них одну организацию и не спутать её с тем же названием другой формы.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({
	env: { PII_ENCRYPTION_KEY: 'KfAA/EWod3wd+ai6b1LHC62LWho5pPp1ajJnQNdbqUs=' }
}));
import { organizationNameKey } from '$lib/server/directory/import';

describe('ключ названия организации', () => {
	it('приводит полную правовую форму к сокращению при любых кавычках', () => {
		const key = organizationNameKey('ООО «РТК ИТ»');

		expect(organizationNameKey('Общество с ограниченной ответственностью «РТК ИТ»')).toBe(key);
		expect(organizationNameKey('общество с ограниченной ответственностью "РТК ИТ"')).toBe(key);
		expect(organizationNameKey('ООО „РТК ИТ“')).toBe(key);
		expect(organizationNameKey('  ООО   “РТК ИТ”  ')).toBe(key);
	});

	it('различает формы и не путает публичное общество с просто акционерным', () => {
		expect(organizationNameKey('Публичное акционерное общество «Ростелеком»')).toBe(
			organizationNameKey('ПАО «Ростелеком»')
		);
		expect(organizationNameKey('Акционерное общество «Ладога»')).toBe(
			organizationNameKey('АО «Ладога»')
		);
		expect(organizationNameKey('Непубличное акционерное общество «Ладога»')).toBe(
			organizationNameKey('НАО «Ладога»')
		);
		expect(organizationNameKey('Закрытое акционерное общество «Ладога»')).toBe(
			organizationNameKey('ЗАО «Ладога»')
		);
		expect(organizationNameKey('Индивидуальный предприниматель Орлов')).toBe(
			organizationNameKey('ИП Орлов')
		);
		expect(organizationNameKey('ПАО «Ладога»')).not.toBe(organizationNameKey('АО «Ладога»'));
		expect(organizationNameKey('ООО «РТК ИТ Плюс»')).not.toBe(organizationNameKey('ООО «РТК ИТ»'));
	});

	it('не принимает за правовую форму неполное совпадение', () => {
		expect(organizationNameKey('Научное общество «Ладога»')).toBe('научное общество ладога');
		expect(organizationNameKey('Непубличное акционерное общество «Ладога»')).toBe('нао ладога');
	});
});
