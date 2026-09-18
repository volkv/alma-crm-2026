/**
 * Что импорт каталога сделает с каждой строкой.
 *
 * Правила считаются одним проходом и на предпросмотре, и на применении, поэтому
 * проверять их можно на исполнителе, который ничего не пишет: он раздаёт
 * временные идентификаторы и обновляет тот же снимок каталога. Всё, что здесь
 * проверяется, — это решения, а не запись: «создать», «обновить и что именно»,
 * «без изменений», «отказать и почему».
 */
import { describe, expect, it } from 'vitest';
import type { CatalogMapping } from '$lib/contracts/directory-import';
import {
	applyCatalogRows,
	buildCatalogRows,
	dryWriter,
	emptyCatalogState,
	registerContract,
	registerContractItem,
	registerDirection,
	registerOrganization,
	registerProduct,
	type CatalogState
} from '$lib/server/directory/import';
import type { StatTable } from '$lib/server/stats/parse';

const HEADERS = [
	'Название ВУЗа',
	'ИНН',
	'Вендор',
	'ПО',
	'Код ПО',
	'ИТ-направление',
	'Номер договора',
	'Дата договора',
	'Подписание лицензии',
	'Срок действия лицензии (год)',
	'Статус по передаче'
] as const;

const MAPPING: CatalogMapping = {
	'Название ВУЗа': 'organization',
	ИНН: 'organizationInn',
	Вендор: 'vendor',
	ПО: 'product',
	'Код ПО': 'productCode',
	'ИТ-направление': 'direction',
	'Номер договора': 'contractNumber',
	'Дата договора': 'contractSignedOn',
	'Подписание лицензии': 'licenseSignedAt',
	'Срок действия лицензии (год)': 'licenseUntil',
	'Статус по передаче': 'transferStatus'
};

/** Таблица файла из строк значений: разбор читает её так же, как настоящую. */
function table(...rows: string[][]): StatTable {
	return {
		file: {
			fileName: 'каталог.csv',
			format: 'csv',
			encoding: 'windows-1251',
			delimiter: ';',
			sheetName: 'Sheet1',
			sheetNames: ['Sheet1']
		},
		headers: [...HEADERS],
		rows: rows.map((cells, index) => ({ origin: index + 2, cells })),
		totalRows: rows.length,
		warnings: []
	};
}

/** Справочник, в котором уже есть вуз, продукт, договор и его позиция. */
function filledState(): CatalogState {
	const state = emptyCatalogState();

	registerOrganization(state, { id: 'org-szpu', inn: '7802450127', name: 'СЗПУ', inScope: true }, [
		'СЗПУ',
		'Северо-Западный политехнический университет'
	]);
	registerProduct(state, { id: 'prd-lms', name: 'Платформа «Ориентир»' }, 'PRD-LMS-01');
	registerDirection(state, { id: 'dir-dev', name: 'Разработка' }, 'DEV');
	registerContract(state, 'org-szpu', {
		id: 'ctr-1',
		number: 'РТК-2026-0142',
		signedOn: '2026-08-20',
		validUntil: '2027-08-31'
	});
	registerContractItem(state, 'ctr-1', 'prd-lms', {
		id: 'item-1',
		licenseSignedAt: '2026-08-20',
		licenseUntil: '2027-08-31',
		transferStatus: 'transferred'
	});

	return state;
}

async function plan(state: CatalogState, ...rows: string[][]) {
	return applyCatalogRows(state, dryWriter(), buildCatalogRows(table(...rows), MAPPING));
}

const KNOWN = ['СЗПУ', '7802450127', '', 'Платформа «Ориентир»', 'PRD-LMS-01', ''] as const;

describe('строка каталога', () => {
	it('заводит вуз, вендора, продукт, направление, договор и позицию', async () => {
		const results = await plan(emptyCatalogState(), [
			'ТГУИ',
			'7714111750',
			'ТехноСфера Софт',
			'Тренажёр «Полигон»',
			'',
			'Разработка',
			'ДГ-2026-001',
			'2026-09-10',
			'2026-09-10',
			'2027',
			'transferred'
		]);

		expect(results[0].action).toBe('create');
		expect(results[0].creations.map((item) => item.target)).toEqual([
			'organization',
			'vendor',
			'direction',
			'product',
			'contract',
			'contractItem'
		]);
		expect(results[0].issues).toEqual([]);
	});

	it('обновляет срок лицензии и называет, что именно меняется', async () => {
		const results = await plan(filledState(), [
			...KNOWN,
			'РТК-2026-0142',
			'2026-08-20',
			'2026-08-20',
			'2028',
			'transferred'
		]);

		expect(results[0].action).toBe('update');
		expect(results[0].creations).toEqual([]);
		expect(results[0].changes).toEqual([
			{
				target: 'contractItem',
				subject: 'РТК-2026-0142 · Платформа «Ориентир»',
				field: 'Срок действия лицензии',
				from: '2027-08-31',
				to: '2028-12-31'
			}
		]);
	});

	it('отвечает «без изменений», когда справочник уже описан этой строкой', async () => {
		const results = await plan(filledState(), [
			...KNOWN,
			'РТК-2026-0142',
			'2026-08-20',
			'2026-08-20',
			'2027-08-31',
			'transferred'
		]);

		expect(results[0].action).toBe('unchanged');
		expect(results[0].changes).toEqual([]);
	});

	it('пустая ячейка ничего не стирает', async () => {
		const results = await plan(filledState(), [...KNOWN, 'РТК-2026-0142', '', '', '', '']);

		expect(results[0].action).toBe('unchanged');
		expect(results[0].changes).toEqual([]);
	});

	it('связывает уже заведённый продукт с направлением, которого у него не было', async () => {
		const results = await plan(filledState(), [
			'СЗПУ',
			'7802450127',
			'',
			'Платформа «Ориентир»',
			'PRD-LMS-01',
			'Разработка',
			'',
			'',
			'',
			'',
			''
		]);

		expect(results[0].action).toBe('update');
		expect(results[0].changes).toEqual([
			{
				target: 'product',
				subject: 'Платформа «Ориентир»',
				field: 'ИТ-направление',
				from: null,
				to: 'Разработка'
			}
		]);
	});
});

describe('двойники внутри файла', () => {
	it('слово в слово — вторая строка просто ничего не меняет', async () => {
		const row = [...KNOWN, 'РТК-2026-0142', '2026-08-20', '2026-08-20', '2028', 'transferred'];
		const results = await plan(filledState(), row, [...row]);

		expect(results.map((result) => result.action)).toEqual(['update', 'unchanged']);
	});

	it('с разными значениями — претензию получают обе', async () => {
		const results = await plan(
			filledState(),
			[...KNOWN, 'РТК-2026-0142', '2026-08-20', '2026-08-20', '2028', 'transferred'],
			[...KNOWN, 'РТК-2026-0142', '2026-08-20', '2026-08-20', '2029', 'transferred']
		);

		expect(results.map((result) => result.action)).toEqual(['error', 'error']);

		for (const result of results) {
			expect(result.issues[0].message).toContain('описывают ту же позицию иначе');
			// Отказ приходит до записи: строка с претензией не заводит ничего.
			expect(result.creations).toEqual([]);
		}
	});
});

describe('строка с претензией', () => {
	it('не проходит с ИНН, который не сходится с контрольной суммой', async () => {
		const results = await plan(filledState(), [
			'СЗПУ',
			'7802450128',
			'',
			'Платформа «Ориентир»',
			'PRD-LMS-01',
			'',
			'',
			'',
			'',
			'',
			''
		]);

		expect(results[0].action).toBe('error');
		expect(results[0].issues[0].message).toContain('контрольной суммы');
	});

	it('не трогает вуз вне области доступа и говорит об этом словами', async () => {
		const state = filledState();
		const hidden = state.organizationByInn.get('7802450127');

		if (hidden === undefined) {
			throw new Error('Вуз не попал в снимок каталога');
		}

		hidden.inScope = false;

		const results = await plan(state, [
			...KNOWN,
			'РТК-2026-0142',
			'2026-08-20',
			'2026-08-20',
			'2028',
			'transferred'
		]);

		expect(results[0].action).toBe('error');
		expect(results[0].issues[0].message).toContain('вне вашей области доступа');
	});

	it('не записывает лицензию, которая истекает раньше, чем подписана', async () => {
		const results = await plan(filledState(), [
			...KNOWN,
			'РТК-2026-0142',
			'2026-08-20',
			'2027-05-01',
			'2026',
			'transferred'
		]);

		expect(results[0].action).toBe('error');
		expect(results[0].issues[0].message).toContain('Лицензия действует до');
		expect(results[0].creations).toEqual([]);
		expect(results[0].changes).toEqual([]);
	});

	it('не заводит новый вуз, если его лицензия истекает раньше подписания', async () => {
		// Сверка дат идёт и у ещё не заведённых записей: иначе вуз, продукт и
		// договор появились бы в справочнике вместе с заведомо неверной лицензией.
		const results = await plan(emptyCatalogState(), [
			'ЮТИМ',
			'2310055660',
			'Полярный код',
			'Помощник куратора «Маяк»',
			'PRD-BOT-07',
			'',
			'ДГ-2026-004',
			'2026-09-13',
			'2027-05-01',
			'2026',
			'pending'
		]);

		expect(results[0].action).toBe('error');
		expect(results[0].creations).toEqual([]);
	});

	it('не теряет лицензию, которую некуда положить без номера договора', async () => {
		const results = await plan(filledState(), [
			...KNOWN,
			'',
			'',
			'2026-08-20',
			'2028',
			'transferred'
		]);

		expect(results[0].action).toBe('error');
		expect(results[0].issues[0].message).toContain('номера договора в строке нет');
	});

	it('не заводит вуз, у которого в файле нет названия', async () => {
		const results = await plan(filledState(), [
			'',
			'',
			'',
			'Платформа «Ориентир»',
			'PRD-LMS-01',
			'',
			'',
			'',
			'',
			'',
			''
		]);

		expect(results[0].action).toBe('error');
		expect(results[0].issues[0].message).toContain('значение не заполнено');
	});
});
