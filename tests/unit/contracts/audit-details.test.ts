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
			'comment: в подробностях допустимы ссылки вида <что-то>Id, имена <что-то>Key, числа <что-то>Count, personIds, provenance и поля route, method, status, demo, mode, periodStart, periodEnd'
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

	it('оставляет списки запрещёнными везде, кроме `personIds` и `provenance`', () => {
		// Произвольный массив рано или поздно окажется перечнем фамилий, а журнал
		// неизменяем: исключений два, и оба проверяются по содержимому.
		expect(
			validateAuditDetails({ organizationIds: ['11111111-2222-4333-8444-555555555555'] })
		).toEqual([
			'organizationIds: в подробностях допустимы ссылки вида <что-то>Id, имена <что-то>Key, числа <что-то>Count, personIds, provenance и поля route, method, status, demo, mode, periodStart, periodEnd'
		]);
		expect(
			validateAuditDetails({ organizationId: ['11111111-2222-4333-8444-555555555555'] })
		).toEqual(['organizationId: идентификатор должен быть строкой']);
	});

	it('пускает в происхождение паспорта только коды и отметку времени', () => {
		const entry = {
			field: 'inn',
			source: 'dadata',
			fetchedAt: '2026-09-24T09:00:00.000Z',
			via: 'live'
		};

		expect(validateAuditDetails({ provenance: [entry] })).toEqual([]);
		expect(
			validateAuditDetails({ provenance: [{ ...entry, source: 'Иванов Иван, ректор' }] })
		).toHaveLength(1);
		expect(validateAuditDetails({ provenance: [{ ...entry, note: 'x' }] })).toHaveLength(1);
	});

	it('требует строку в ссылке и список строк в изменённых полях', () => {
		expect(validateAuditDetails({ organizationId: 42 })).toEqual([
			'organizationId: идентификатор должен быть строкой'
		]);
		expect(validateAuditDetails({ changedFields: 'shortName' })).toEqual([
			'changedFields: ожидается список имён полей'
		]);
	});

	it('пропускает счётчики: публикация и выгрузка несут диф в числах', () => {
		expect(validateAuditDetails({ migratedCount: 12, rowCount: 0 })).toEqual([]);
	});

	it('требует у счётчика целое число не меньше нуля', () => {
		const expected = (key: string) => [`${key}: ожидается целое число не меньше нуля`];

		expect(validateAuditDetails({ rowCount: '12' })).toEqual(expected('rowCount'));
		expect(validateAuditDetails({ rowCount: 1.5 })).toEqual(expected('rowCount'));
		expect(validateAuditDetails({ rowCount: -1 })).toEqual(expected('rowCount'));
	});

	it('пропускает устойчивые имена: по ключу сопоставляют стадии разных редакций', () => {
		expect(validateAuditDetails({ fromStageKey: 'contact_search', workspaceKey: 'b2b' })).toEqual(
			[]
		);
	});

	it('не пускает под видом имени свободный текст', () => {
		// Форма `<что-то>Key` — это ключ стадии или группы, а не строка, которую
		// писал человек: иначе в неизменяемый журнал попадут персональные данные.
		const expected = (key: string) => [
			`${key}: ожидается устойчивое имя вида ^[a-z][a-z0-9_-]{0,63}$`
		];

		expect(validateAuditDetails({ stageKey: 'позвонили в вуз' })).toEqual(expected('stageKey'));
		expect(validateAuditDetails({ stageKey: 'Contact Search' })).toEqual(expected('stageKey'));
		expect(validateAuditDetails({ stageKey: 42 })).toEqual(expected('stageKey'));
	});

	it('запрещает секреты, хотя по форме они — имена', () => {
		// `apiKey` подходит под `<что-то>Key` и без явного запрета лёг бы в журнал
		// целиком.
		for (const key of ['apiKey', 'secretKey', 'signingKey', 'privateKey']) {
			expect(validateAuditDetails({ [key]: 'abcdef0123456789' })).toEqual([
				`${key}: персональные данные в журнал не записываются`
			]);
		}
	});

	it('пропускает режим и период выгрузки', () => {
		expect(
			validateAuditDetails({ mode: 'snapshot', periodStart: '2026-10-01', periodEnd: '2026-12-31' })
		).toEqual([]);
	});

	it('требует у режима и периода их образец', () => {
		expect(validateAuditDetails({ mode: 'срез на конец периода' })).toEqual([
			'mode: значение не отвечает образцу ^[a-z][a-z0-9_-]{0,31}$'
		]);
		expect(validateAuditDetails({ periodStart: '01.10.2026' })).toEqual([
			'periodStart: значение не отвечает образцу ^\\d{4}-\\d{2}-\\d{2}$'
		]);
	});

	it('перечисляет все претензии сразу, а не только первую', () => {
		expect(validateAuditDetails({ email: 'a@b.c', note: 'x' })).toHaveLength(2);
	});
});
