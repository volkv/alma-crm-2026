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

	it('пропускает служебные поля запроса и признак демонстрационного входа', () => {
		expect(
			validateAuditDetails({ route: '/api/v1/organizations', method: 'GET', status: 200 })
		).toEqual([]);
		expect(validateAuditDetails({ demo: true })).toEqual([]);
	});

	it('отвергает любой ключ, который не является ни ссылкой, ни служебным полем', () => {
		expect(validateAuditDetails({ comment: 'позвонили в вуз' })).toEqual([
			'comment: в подробностях допустимы ссылки вида <что-то>Id, personIds и поля route, method, status, demo'
		]);
	});

	it('пропускает список идентификаторов людей — след просмотра пишется одной записью', () => {
		expect(
			validateAuditDetails({
				personIds: ['11111111-2222-4333-8444-555555555555', '66666666-7777-4888-8999-aaaaaaaaaaaa']
			})
		).toEqual([]);
	});

	it('требует в списке людей именно идентификаторы записей', () => {
		expect(validateAuditDetails({ personIds: ['Иванов Иван'] })).toEqual([
			'personIds: ожидается список идентификаторов записей'
		]);
		expect(validateAuditDetails({ personIds: '11111111-2222-4333-8444-555555555555' })).toEqual([
			'personIds: ожидается список идентификаторов записей'
		]);
	});

	it('требует у служебных полей их тип', () => {
		expect(validateAuditDetails({ status: '200' })).toEqual([
			'status: ожидается значение типа number'
		]);
		expect(validateAuditDetails({ route: 42 })).toEqual(['route: ожидается значение типа string']);
		expect(validateAuditDetails({ demo: 'да' })).toEqual(['demo: ожидается значение типа boolean']);
	});

	it('оставляет списки запрещёнными везде, кроме `personIds`', () => {
		// Произвольный массив рано или поздно окажется перечнем фамилий, а журнал
		// неизменяем: исключение сделано ровно одно и проверяется по содержимому.
		expect(
			validateAuditDetails({ organizationIds: ['11111111-2222-4333-8444-555555555555'] })
		).toEqual([
			'organizationIds: в подробностях допустимы ссылки вида <что-то>Id, personIds и поля route, method, status, demo'
		]);
		expect(
			validateAuditDetails({ organizationId: ['11111111-2222-4333-8444-555555555555'] })
		).toEqual(['organizationId: идентификатор должен быть строкой']);
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
