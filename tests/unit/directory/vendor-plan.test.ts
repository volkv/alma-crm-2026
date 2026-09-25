/**
 * Что импорт вендоров сделает с каждой строкой.
 *
 * Решения считаются одним проходом на предпросмотре и на применении, поэтому
 * проверяются на исполнителе, который ничего не пишет: как делится ячейка
 * продуктов и способа связи, что строка заведёт, что поменяет и за что откажет.
 */
import { describe, expect, it, vi } from 'vitest';

/** Люди сравниваются ключами `people/pii.ts`; в прогоне без `.env` ключ подменён. */
vi.mock('$env/dynamic/private', () => ({
	env: { PII_ENCRYPTION_KEY: 'KfAA/EWod3wd+ai6b1LHC62LWho5pPp1ajJnQNdbqUs=' }
}));
import type { VendorMapping } from '$lib/contracts/directory-import';
import { contactKeys } from '$lib/server/directory/import';
import {
	applyVendorRows,
	buildVendorRows,
	dryVendorWriter,
	emptyVendorState,
	normalizeChannels,
	registerCompany,
	registerCompanyContact,
	registerVendorProduct,
	splitProductCell,
	suggestVendorMapping,
	type VendorState
} from '$lib/server/directory/vendor-import';
import type { StatTable } from '$lib/server/stats/parse';

const HEADERS = ['Компания', 'Продукт', 'ФИО', 'Телефон', 'Почта', 'Способ связи'];

const MAPPING: VendorMapping = {
	Компания: 'company',
	Продукт: 'products',
	ФИО: 'contactName',
	Телефон: 'contactPhone',
	Почта: 'contactEmail',
	'Способ связи': 'contactChannel'
};

function table(...rows: string[][]): StatTable {
	return {
		file: {
			fileName: 'вендоры.csv',
			format: 'csv',
			encoding: 'utf-8',
			delimiter: ';',
			sheetName: 'Sheet1',
			sheetNames: ['Sheet1']
		},
		headers: HEADERS,
		rows: rows.map((cells, index) => ({ origin: index + 2, cells })),
		totalRows: rows.length,
		warnings: []
	};
}

/** Справочник: оператор, вендор с одним продуктом и ничей продукт. */
function state(): VendorState {
	const snapshot = emptyVendorState();

	registerCompany(
		snapshot,
		{ id: 'op', name: 'АО «Оператор Обучения»', inn: null, kind: 'operator' },
		['АО «Оператор Обучения»']
	);
	registerCompany(
		snapshot,
		{ id: 'ladoga', name: 'Ладога Датасистемс', inn: null, kind: 'vendor' },
		['Ладога Датасистемс']
	);
	registerVendorProduct(
		snapshot,
		{ id: 'p-flow', name: 'Ладога.Поток', vendorId: 'ladoga' },
		'FLOW'
	);
	registerVendorProduct(snapshot, { id: 'p-free', name: 'Учебный стенд', vendorId: null }, 'STAND');

	return snapshot;
}

describe('ячейки файла вендоров', () => {
	it('делит продукты по ёлочкам, а без них — по запятой и точке с запятой', () => {
		expect(splitProductCell('«RT.DataLake», «RT.Warehouse»')).toEqual([
			'RT.DataLake',
			'RT.Warehouse'
		]);
		expect(splitProductCell('«А» «Б»')).toEqual(['А', 'Б']);
		expect(splitProductCell(' Альфа ;Бета,  Гамма ')).toEqual(['Альфа', 'Бета', 'Гамма']);
		// Кавычки внутри названия его не рвут, а повтор схлопывается.
		expect(splitProductCell('Облачная среда «Верстак», облачная среда Верстак')).toEqual([
			'Облачная среда «Верстак»'
		]);
	});

	it('собирает способ связи списком без повторов и лишних пробелов', () => {
		expect(normalizeChannels('Почта,  Чат  в ТГ')).toBe('Почта, Чат в ТГ');
		expect(normalizeChannels('Почта, почта; Телефон')).toBe('Почта, Телефон');
		expect(normalizeChannels(' , ')).toBeNull();
		expect(normalizeChannels(null)).toBeNull();
	});

	it('узнаёт колонки файла заказчика по шапке', () => {
		expect(suggestVendorMapping(HEADERS)).toEqual(MAPPING);
	});
});

describe('решения по строке вендоров', () => {
	it('заводит вендора, продукты и контакт, а оператор остаётся найденным', async () => {
		const snapshot = state();
		const results = await applyVendorRows(
			snapshot,
			dryVendorWriter(),
			buildVendorRows(
				table(
					[
						'ООО «Полярный Софт»',
						'«Полярный Редактор», «Полярный Архив»',
						'Орлова Вера Павловна',
						'+7 (900) 111-22-33',
						'v.orlova@example.test',
						'Почта, Чат в ТГ'
					],
					['АО «Оператор Обучения»', '«Учебный стенд»', '', '', '', '']
				),
				MAPPING
			)
		);

		expect(results[0].action).toBe('create');
		expect(results[0].creations.map((creation) => creation.target)).toEqual([
			'vendor',
			'product',
			'product',
			'vendorContact'
		]);
		expect(results[0].changes.map((change) => change.field)).toEqual([
			'Контакт вендора',
			'Контакт вендора'
		]);

		// Ничей продукт получает вендора — изменение, а не создание; оператор не
		// заводится заново.
		expect(results[1]).toMatchObject({ action: 'update', organizationId: 'op', creations: [] });
		expect(results[1].changes).toEqual([
			{
				target: 'product',
				subject: 'Учебный стенд',
				field: 'Вендор',
				from: null,
				to: 'АО «Оператор Обучения»'
			}
		]);
	});

	it('отказывает на чужом продукте, телефоне без ФИО и ФИО из одного слова', async () => {
		const results = await applyVendorRows(
			state(),
			dryVendorWriter(),
			buildVendorRows(
				table(
					['АО «Оператор Обучения»', '«Ладога.Поток»', '', '', '', ''],
					['Ладога Датасистемс', '«Ладога.Поток»', '', '+7 900 000-00-00', '', ''],
					['Ладога Датасистемс', '', 'Орлова', '', '', '']
				),
				MAPPING
			)
		);

		expect(results.map((result) => result.action)).toEqual(['error', 'error', 'error']);
		expect(results[0].issues[0].message).toBe(
			'Продукт «Ладога.Поток» уже принадлежит вендору «Ладога Датасистемс»'
		);
		expect(results[1].issues[0].field).toBe('contactName');
		expect(results[2].issues[0].message).toContain('не похоже на ФИО');
	});

	it('узнаёт заведённого человека и меняет только способ связи', async () => {
		const snapshot = state();
		const identity = {
			lastName: 'Сизов',
			firstName: 'Глеб',
			middleName: 'Андреевич',
			email: 'g.sizov@example.test',
			phone: null
		};

		registerCompanyContact(snapshot, 'ladoga', contactKeys(identity), {
			personId: 'person-sizov',
			affiliationId: 'aff-sizov',
			fullName: 'Сизов Глеб Андреевич',
			channel: 'Почта'
		});

		const [result] = await applyVendorRows(
			snapshot,
			dryVendorWriter(),
			buildVendorRows(
				table([
					'Ладога Датасистемс',
					'«Ладога.Поток»',
					'Сизов Глеб Андреевич',
					'79001112244',
					'',
					'Телефон'
				]),
				MAPPING
			)
		);

		expect(result.action).toBe('update');
		expect(result.creations).toEqual([]);
		expect(result.changes).toEqual([
			{
				target: 'vendorContact',
				subject: 'Сизов Глеб Андреевич',
				field: 'Способ связи',
				from: 'Почта',
				to: 'Телефон'
			},
			{
				target: 'product',
				subject: 'Ладога.Поток',
				field: 'Контакт вендора',
				from: null,
				to: 'Сизов Глеб Андреевич'
			}
		]);
	});

	it('второй раз та же строка ничего не меняет', async () => {
		const snapshot = state();
		const rows = () =>
			buildVendorRows(
				table([
					'Ладога Датасистемс',
					'«Ладога.Поток», «Ладога.Витрина»',
					'Орлова Вера Павловна',
					'',
					'v.orlova@example.test',
					'Почта'
				]),
				MAPPING
			);

		const [first] = await applyVendorRows(snapshot, dryVendorWriter(), rows());
		const [second] = await applyVendorRows(snapshot, dryVendorWriter(), rows());

		expect(first.action).toBe('create');
		expect(second).toMatchObject({ action: 'unchanged', creations: [], changes: [] });
	});

	it('разный способ связи у того же человека в двух строках — претензия обеим', async () => {
		const results = await applyVendorRows(
			state(),
			dryVendorWriter(),
			buildVendorRows(
				table(
					['Ладога Датасистемс', '«Ладога.Поток»', 'Орлова Вера', '', '', 'Почта'],
					['Ладога Датасистемс', '', 'Орлова Вера', '', '', 'Телефон']
				),
				MAPPING
			)
		);

		expect(results.map((result) => result.issues[0]?.field)).toEqual([
			'contactChannel',
			'contactChannel'
		]);
	});
});
