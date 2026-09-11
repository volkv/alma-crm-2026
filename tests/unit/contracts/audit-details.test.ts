import { describe, expect, it } from 'vitest';
import { validateAuditDetails } from '$lib/contracts/audit';

describe('validateAuditDetails', () => {
	it('пропускает ссылки на записи и список изменённых полей', () => {
		expect(validateAuditDetails({})).toEqual([]);
		expect(
			validateAuditDetails({
				organizationId: '11111111-2222-4333-8444-555555555555',
				changedFields: ['shortName', 'inn']
			})
		).toEqual([]);
	});

	it('отвергает ключи, за которыми стоят персональные данные', () => {
		for (const key of ['email', 'phone', 'password', 'lastName', 'firstName', 'middleName']) {
			expect(validateAuditDetails({ [key]: 'что-то' })).toEqual([
				`${key}: персональные данные в журнал не записываются`
			]);
		}
	});

	it('отвергает любой ключ, который не является ссылкой', () => {
		expect(validateAuditDetails({ comment: 'позвонили в вуз' })).toEqual([
			'comment: в подробностях допустимы только ссылки вида <что-то>Id'
		]);
	});

	it('требует строку в ссылке и список строк в изменённых полях', () => {
		expect(validateAuditDetails({ organizationId: 42 })).toEqual([
			'organizationId: идентификатор должен быть строкой'
		]);
		expect(validateAuditDetails({ changedFields: 'shortName' })).toEqual([
			'changedFields: ожидается список имён полей'
		]);
	});

	it('перечисляет все претензии сразу, а не только первую', () => {
		expect(validateAuditDetails({ email: 'a@b.c', note: 'x' })).toHaveLength(2);
	});
});
