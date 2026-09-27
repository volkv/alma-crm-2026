/**
 * Сопоставление колонок каталога и разбор его значений.
 *
 * Словарь синонимов проверяется на той шапке, которая приезжает от заказчика:
 * «Название ВУЗа», «Вендор», «ПО», «Срок действия лицензии (год)». Если
 * предложение по ней разъедется, мастер начнёт с неверно разложенных колонок —
 * а это молча не те договоры в справочнике.
 */
import { describe, expect, it } from 'vitest';
import { CATALOG_FIELDS, IMPORT_FIELDS_BY_KIND } from '$lib/contracts/directory-import';
import {
	generateCode,
	parseCatalogDate,
	suggestCatalogMapping
} from '$lib/server/directory/import';
import { importSampleHeaders } from '$lib/server/directory/import-sample';
import { suggestVendorMapping } from '$lib/server/directory/vendor-import';

/** Шапка рабочей таблицы заказчика: все десять колонок технического задания. */
const CUSTOMER_HEADERS = [
	'Название ВУЗа',
	'Вендор',
	'ПО',
	'Номер договора',
	'Подписание лицензии',
	'Срок действия лицензии (год)',
	'Статус по передаче',
	'ФИО Менеджера',
	'Ответственные от ВУЗа',
	'Комментарий'
];

describe('предложенное сопоставление колонок каталога', () => {
	it('раскладывает шапку рабочей таблицы заказчика', () => {
		expect(suggestCatalogMapping(CUSTOMER_HEADERS)).toEqual({
			'Название ВУЗа': 'organization',
			Вендор: 'vendor',
			ПО: 'product',
			'Номер договора': 'contractNumber',
			'Подписание лицензии': 'licenseSignedAt',
			'Срок действия лицензии (год)': 'licenseUntil',
			'Статус по передаче': 'transferStatus',
			'ФИО Менеджера': 'manager',
			'Ответственные от ВУЗа': 'contacts',
			Комментарий: 'comment'
		});
	});

	it('не отдаёт колонку «Ответственные от ВУЗа» ни менеджеру, ни названию вуза', () => {
		const mapping = suggestCatalogMapping(CUSTOMER_HEADERS);

		// «Ответственные от ВУЗа» — это люди вуза, а не сотрудник оператора и не
		// название организации, хотя слово «вуз» стоит и там и там.
		expect(mapping['Ответственные от ВУЗа']).toBe('contacts');
		expect(mapping['ФИО Менеджера']).toBe('manager');
	});

	it('различает название и ИНН, а также продукт и его код', () => {
		const mapping = suggestCatalogMapping([
			'Вуз',
			'ИНН',
			'ПО',
			'Код ПО',
			'Номер договора',
			'Дата договора'
		]);

		expect(mapping).toEqual({
			Вуз: 'organization',
			ИНН: 'organizationInn',
			ПО: 'product',
			'Код ПО': 'productCode',
			'Номер договора': 'contractNumber',
			'Дата договора': 'contractSignedOn'
		});
	});

	it('отдаёт поле одной колонке: «Договор» и «Номер договора» рядом', () => {
		const mapping = suggestCatalogMapping(['Вуз', 'ПО', 'Договор', 'Номер договора']);
		const fields = Object.values(mapping);

		expect(new Set(fields).size).toBe(fields.length);
		expect(mapping['Номер договора']).toBe('contractNumber');
	});

	it('не выдумывает полей вне словаря', () => {
		for (const field of Object.values(suggestCatalogMapping(CUSTOMER_HEADERS))) {
			expect(CATALOG_FIELDS).toContain(field);
		}
	});
});

describe('дата из ячейки каталога', () => {
	it('читает обе привычные записи дня', () => {
		expect(parseCatalogDate('2026-09-01', { yearIsEnd: false })).toBe('2026-09-01');
		expect(parseCatalogDate('01.09.2026', { yearIsEnd: false })).toBe('2026-09-01');
	});

	it('читает год в колонке срока концом года', () => {
		expect(parseCatalogDate('2027', { yearIsEnd: true })).toBe('2027-12-31');
		expect(parseCatalogDate('2027 г.', { yearIsEnd: true })).toBe('2027-12-31');
	});

	it('не принимает год за дату подписания', () => {
		// «Подписано в 2027 году» — это не дата подписания, и придумывать ей день
		// нельзя: у срока конец года следует из смысла слова «срок», у подписания
		// из него не следует ничего.
		expect(parseCatalogDate('2027', { yearIsEnd: false })).toBe('invalid');
	});

	it('различает пустую ячейку и мусор', () => {
		expect(parseCatalogDate('   ', { yearIsEnd: true })).toBeNull();
		expect(parseCatalogDate('до конца года', { yearIsEnd: true })).toBe('invalid');
		expect(parseCatalogDate('31.02.2027', { yearIsEnd: false })).toBe('invalid');
	});
});

describe('код новой записи', () => {
	it('собирается из названия латиницей', () => {
		expect(generateCode('Облачная среда «Верстак»', new Set())).toBe('OBLACHNAYA-SREDA-VERSTAK');
	});

	it('обходит занятый код номером, а не молчаливой заменой', () => {
		const taken = new Set(['VERSTAK', 'VERSTAK-2']);

		expect(generateCode('Верстак', taken)).toBe('VERSTAK-3');
	});

	it('не остаётся пустым у названия без латиницы и цифр', () => {
		expect(generateCode('«»', new Set())).toBe('CODE');
	});
});

describe('образец файла', () => {
	it('каждая колонка образца сама ложится на своё поле', () => {
		const expected = (kind: 'catalog' | 'vendors') =>
			Object.fromEntries(
				IMPORT_FIELDS_BY_KIND[kind].fields.map((field) => [
					IMPORT_FIELDS_BY_KIND[kind].labels[field],
					field
				])
			);

		expect(suggestCatalogMapping(importSampleHeaders('catalog'))).toEqual(expected('catalog'));
		expect(suggestVendorMapping(importSampleHeaders('vendors'))).toEqual(expected('vendors'));
	});
});
