/**
 * Что импорт каталога сделает с каждой строкой.
 *
 * Правила считаются одним проходом и на предпросмотре, и на применении, поэтому
 * проверять их можно на исполнителе, который ничего не пишет: он раздаёт
 * временные идентификаторы и обновляет тот же снимок каталога. Всё, что здесь
 * проверяется, — это решения, а не запись: «создать», «обновить и что именно»,
 * «без изменений», «отказать и почему».
 */
import { describe, expect, it, vi } from 'vitest';

/**
 * Контакты в снимке каталога сравниваются по ключу, который считает
 * `people/pii.ts` ключом установки: в базе они лежат шифртекстом. Окружение
 * подменено, потому что в прогоне CI никакого `.env` нет.
 */
vi.mock('$env/dynamic/private', () => ({
	env: { PII_ENCRYPTION_KEY: 'KfAA/EWod3wd+ai6b1LHC62LWho5pPp1ajJnQNdbqUs=' }
}));
import type { CatalogMapping } from '$lib/contracts/directory-import';
import {
	applyCatalogRows,
	buildCatalogRows,
	dryWriter,
	emptyCatalogState,
	registerContact,
	registerContract,
	registerContractItem,
	registerDirection,
	registerOrganization,
	registerProduct,
	registerResponsible,
	registerUser,
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
	'Статус по передаче',
	'ФИО Менеджера',
	'Ответственные от ВУЗа',
	'Комментарий'
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
	'Статус по передаче': 'transferStatus',
	'ФИО Менеджера': 'manager',
	'Ответственные от ВУЗа': 'contacts',
	Комментарий: 'comment'
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

/** Кто загружает файл: руководитель с правом назначать ответственных. */
const ACTOR = { userId: 'usr-lead', canAssignResponsible: true };

/** Справочник, в котором уже есть вуз, продукт, договор и его позиция. */
function filledState(): CatalogState {
	const state = emptyCatalogState(ACTOR);

	registerOrganization(
		state,
		{ id: 'org-szpu', inn: '7802450127', name: 'СЗПУ', inScope: true, notes: null },
		['СЗПУ', 'Северо-Западный политехнический университет']
	);
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

/** Сотрудники оператора: кандидаты в ответственные по колонке менеджера. */
function withStaff(
	state: CatalogState,
	...extra: { id: string; fullName: string }[]
): CatalogState {
	registerUser(state, { id: 'usr-lead', fullName: 'Руководитель Демо', assignable: true });
	registerUser(state, {
		id: 'usr-veresova',
		fullName: 'Вересова Анна Сергеевна',
		assignable: true
	});
	registerUser(state, { id: 'usr-zotov', fullName: 'Зотов Павел Игоревич', assignable: true });

	for (const entry of extra) {
		registerUser(state, { ...entry, assignable: true });
	}

	return state;
}

/** Строка про уже заведённый вуз, у которой заполнены только три новых колонки. */
const around = (manager: string, contacts: string, comment: string): string[] => [
	...KNOWN,
	'',
	'',
	'',
	'',
	'',
	manager,
	contacts,
	comment
];

describe('менеджер строки', () => {
	it('назначает ответственного за вуз, у которого его не было', async () => {
		const results = await plan(withStaff(filledState()), around('Вересова Анна Сергеевна', '', ''));

		expect(results[0].issues).toEqual([]);
		expect(results[0].action).toBe('create');
		expect(results[0].creations).toEqual([
			{ target: 'responsible', subject: 'Вересова Анна Сергеевна' }
		]);
	});

	it('узнаёт сотрудника по фамилии с инициалами', async () => {
		const results = await plan(withStaff(filledState()), around('Вересова А.С.', '', ''));

		expect(results[0].creations).toEqual([
			{ target: 'responsible', subject: 'Вересова Анна Сергеевна' }
		]);
	});

	it('отказывает, когда такого сотрудника нет', async () => {
		const results = await plan(withStaff(filledState()), around('Неизвестный И. И.', '', ''));

		expect(results[0].action).toBe('error');
		expect(results[0].issues[0].field).toBe('manager');
		expect(results[0].issues[0].message).toContain('не найден среди действующих');
		expect(results[0].creations).toEqual([]);
	});

	it('отказывает, когда под ФИО подходит несколько сотрудников', async () => {
		// Две Вересовых А. под одним ключом «фамилия и инициалы»: выбрать одну
		// значит выбрать наугад, а назначение — это ещё и право видеть вуз.
		const state = withStaff(filledState(), {
			id: 'usr-veresova-2',
			fullName: 'Вересова Алина Семёновна'
		});

		const results = await plan(state, around('Вересова А. С.', '', ''));

		expect(results[0].action).toBe('error');
		expect(results[0].issues[0].message).toContain('подходит несколько сотрудников');
		expect(results[0].creations).toEqual([]);
	});

	it('не заменяет чужое действующее назначение', async () => {
		const state = withStaff(filledState());
		registerResponsible(state, 'org-szpu', { generalUserId: 'usr-zotov', hasDirectional: false });

		const results = await plan(state, around('Вересова Анна Сергеевна', '', ''));

		expect(results[0].action).toBe('error');
		expect(results[0].issues[0].message).toContain('уже отвечает другой сотрудник');
	});

	it('отвечает «без изменений», когда тот же человек уже отвечает за вуз', async () => {
		const state = withStaff(filledState());
		registerResponsible(state, 'org-szpu', {
			generalUserId: 'usr-veresova',
			hasDirectional: false
		});

		const results = await plan(state, around('Вересова Анна Сергеевна', '', ''));

		expect(results[0].action).toBe('unchanged');
		expect(results[0].creations).toEqual([]);
	});

	it('у нового вуза сменяет автора загрузки на менеджера из файла', async () => {
		// Автором нового вуза сервис справочника ставит того, кто нажал кнопку;
		// колонка менеджера для того и есть, чтобы вуз достался названному в файле.
		const results = await plan(withStaff(emptyCatalogState(ACTOR)), [
			'ТГУИ',
			'7714111750',
			'',
			'Тренажёр «Полигон»',
			'',
			'',
			'',
			'',
			'',
			'',
			'',
			'Зотов Павел Игоревич',
			'',
			''
		]);

		expect(results[0].issues).toEqual([]);
		expect(results[0].creations).toContainEqual({
			target: 'responsible',
			subject: 'Зотов Павел Игоревич'
		});
	});

	it('без права назначать ответственных колонка менеджера — претензия', async () => {
		const state = withStaff(emptyCatalogState({ userId: 'usr-lead', canAssignResponsible: false }));
		registerOrganization(
			state,
			{ id: 'org-szpu', inn: '7802450127', name: 'СЗПУ', inScope: true, notes: null },
			['СЗПУ']
		);
		registerProduct(state, { id: 'prd-lms', name: 'Платформа «Ориентир»' }, 'PRD-LMS-01');

		const results = await plan(state, around('Вересова Анна Сергеевна', '', ''));

		expect(results[0].action).toBe('error');
		expect(results[0].issues[0].message).toContain('права на это у вас нет');
	});
});

describe('контакты вуза', () => {
	it('заводит человека из ячейки и называет его в предпросмотре', async () => {
		const results = await plan(
			filledState(),
			around('', 'Иванова Мария Петровна, +7 (999) 123-45-67, m.ivanova@vuz.ru', '')
		);

		expect(results[0].issues).toEqual([]);
		expect(results[0].creations).toEqual([
			{ target: 'contact', subject: 'Иванова Мария Петровна · СЗПУ' }
		]);
	});

	it('повтор той же почты у того же вуза ничего не заводит', async () => {
		const state = filledState();
		registerContact(state, 'org-szpu', {
			lastName: 'Иванова',
			firstName: 'Мария',
			middleName: 'Петровна',
			email: 'M.Ivanova@vuz.ru',
			phone: null
		});

		const results = await plan(state, around('', 'Иванова М. П., m.ivanova@vuz.ru', ''));

		expect(results[0].action).toBe('unchanged');
		expect(results[0].creations).toEqual([]);
	});

	it('второй раз в том же файле человек не заводится дважды', async () => {
		const cell = 'Иванова Мария Петровна, m.ivanova@vuz.ru';
		const results = await plan(filledState(), around('', cell, ''), around('', cell, ''));

		expect(results[0].creations).toHaveLength(1);
		expect(results[1].creations).toEqual([]);
	});

	it('не разобранный кусок ячейки — претензия с его текстом', async () => {
		const results = await plan(filledState(), around('', 'приёмная +7 999 000-00-00', ''));

		expect(results[0].action).toBe('error');
		expect(results[0].issues[0].field).toBe('contacts');
		expect(results[0].issues[0].message).toContain('приёмная');
		expect(results[0].creations).toEqual([]);
	});
});

describe('комментарий строки', () => {
	it('дописывается в примечание вуза, не затирая прежнее', async () => {
		const state = filledState();
		const organization = state.organizationByInn.get('7802450127');

		if (organization === undefined) {
			throw new Error('Вуз не попал в снимок каталога');
		}

		organization.notes = 'Договор продлевали в августе';

		const results = await plan(state, around('', '', 'Ждут смету на 2027 год'));

		expect(results[0].action).toBe('update');
		expect(results[0].changes).toEqual([
			{
				target: 'organization',
				subject: 'СЗПУ',
				field: 'Примечание',
				from: 'Договор продлевали в августе',
				to: 'Договор продлевали в августе\nЖдут смету на 2027 год'
			}
		]);
	});

	it('тот же комментарий второй раз ничего не меняет', async () => {
		const comment = 'Ждут смету на 2027 год';
		const results = await plan(filledState(), around('', '', comment), around('', '', comment));

		expect(results[0].action).toBe('update');
		expect(results[1].action).toBe('unchanged');
		expect(results[1].changes).toEqual([]);
	});
});
