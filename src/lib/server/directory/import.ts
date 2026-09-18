/**
 * Импорт каталога «вуз × продукт × договор × лицензия × статус передачи».
 *
 * Путь у человека тот же, что у загрузки данных об обучении: файл →
 * сопоставление колонок → предпросмотр с построчными ошибками → подтверждение.
 * Результат — другой. Импорт статистики кладёт **снимок чисел**, который живёт
 * своей жизнью; импорт каталога меняет **справочник**: заводит организации,
 * продукты, направления, договоры и их позиции, а уже заведённые обновляет.
 *
 * Отсюда три правила, на которых держится модуль.
 *
 * 1. **Предпросмотр считает то же, что и применение.** Обе стороны зовут один
 *    и тот же `applyCatalogRows`; отличаются они только исполнителем записи:
 *    предпросмотру достаётся `dryWriter`, который ничего не пишет, а раздаёт
 *    временные идентификаторы. Поэтому «создать / обновить / без изменений» на
 *    экране — это не прогноз по другим правилам, а тот же расчёт.
 * 2. **Строка с претензией ничего не записывает.** Сначала строка целиком
 *    разбирается и сверяется со справочником, и только строка без единой
 *    претензии выполняет свои записи. Наполовину применённой строки не бывает.
 * 3. **Пустая ячейка ничего не стирает.** Выгрузка из рабочей таблицы почти
 *    всегда неполна. Поэтому повторная загрузка того же файла честно отвечает
 *    «без изменений» по каждой строке, а не переписывает справочник сама собой.
 *
 * Чего импорт **не** делает: он не переписывает уже заведённые организации и
 * продукты. Название вуза в рабочей таблице — это то, как его записал человек,
 * а не источник истины для справочника; переименовать вуз загрузкой файла
 * означало бы менять карточку, на которую ссылаются взаимодействия и документы,
 * не открывая её. Импорт заводит недостающее и ведёт то, ради чего он и нужен:
 * договоры, лицензии и статусы передачи.
 *
 * Три колонки таблицы ложатся не на справочник, а на записи вокруг него:
 * «ФИО менеджера» — на назначение ответственного за вуз, «Контакты вуза» — на
 * людей с их ролью и основанием обработки, «Комментарий» — на примечание
 * карточки вуза. Все три идут теми же тремя правилами: считает их тот же проход,
 * строка с претензией не делает ни одной из этих записей, а повтор отвечает
 * «без изменений». Примечание при этом **дописывается**: затереть чужую
 * заметку загрузкой файла — это то же переписывание карточки, от которого
 * импорт отказывается везде.
 */
import { and, count, desc, eq, exists, isNotNull, isNull, ne, sql, type SQL } from 'drizzle-orm';
import { id as idSchema, type PageResult } from '$lib/contracts/common';
import {
	CATALOG_FIELDS,
	CATALOG_PREVIEW_PARSE_LIMIT,
	CATALOG_REQUIRED_FIELDS,
	CATALOG_FIELD_LABELS,
	catalogImportCounts,
	catalogMappingSchema,
	createCatalogImportSchema,
	rejectCatalogImportSchema,
	catalogRowAction,
	type CatalogCreation,
	type CatalogField,
	type CatalogImportListItem,
	type CatalogImportRowView,
	type CatalogImportView,
	type CatalogMapping,
	type CatalogRowAction,
	type CatalogRowChange,
	type CatalogRowIssue,
	type CatalogRowValues
} from '$lib/contracts/directory-import';
import {
	affiliationPositionSchema,
	createPersonSchema,
	organizationNotesSchema
} from '$lib/contracts/directory';
import { formatIsoDay } from '$lib/format';
import { isValidInn } from '$lib/validation/inn';
import type { ActorContext } from '../actor';
import { invalidateDirectoryOptions } from '../cache/directory';
import { recordAuditEvent } from '../audit';
import {
	affiliations,
	consents,
	contractItems,
	contracts,
	directions,
	directoryImportRows,
	directoryImports,
	documents,
	organizationResponsibles,
	organizations,
	people,
	productDirections,
	products,
	users
} from '../db/schema';
import { getDb } from '../db';
import { withTransaction, type Tx } from '../db/transaction';
import { discardStaged, promoteBlob, readStoredFile, stageBlob } from '../documents/storage';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../errors';
import { withPiiTrace } from '../people/pii-trace';
import { actorScopeFilter, can, requirePermission, scopeFilter } from '../rbac';
import { suggestFieldMapping, type FieldSynonyms } from '../spreadsheet/mapping';
// Чтение файла общее с импортом данных об обучении: формат по содержимому,
// кодировка, разделитель, листы книги, две формы JSON и происхождение каждой
// строки — это работа одного разборщика, и второго в продукте быть не должно.
import type { StatFileSummary } from '$lib/contracts/stats';
import { statFileMime } from '../stats/format';
import { normalizeName } from '../stats/lookup';
import {
	describeRowOrigin,
	parseCalendarDate,
	readStatTable,
	type StatTable
} from '../stats/parse';
import {
	insertContract,
	insertContractItem,
	mergeContract,
	mergeContractItem,
	updateContract,
	updateContractItem,
	type ContractItemState,
	type ContractState
} from './contracts';
import {
	contactFullName,
	normalizeContactEmail,
	normalizeContactPhone,
	parseContacts,
	type ContactIdentity,
	type ParsedContact
} from './contacts';
import { assignResponsible } from './responsibles';
import {
	createAffiliation,
	createDirection,
	createOrganization,
	createPerson,
	createProduct
} from './write';

/** Идентификатор импорта приходит из адреса, то есть от кого угодно. */
const importIdSchema = idSchema('Некорректный идентификатор импорта');

/** Вид, под которым исходный файл лежит в разделе документов. */
const CATALOG_FILE_DOCUMENT_KIND = 'report';

/** Название документа не длиннее того, что принимает контракт документов. */
const MAX_DOCUMENT_TITLE = 300;

/** Сколько строк уходит в базу одним запросом: у оператора PostgreSQL потолок на параметры. */
const INSERT_CHUNK = 500;

/**
 * Синонимы названий колонок. Список начинается с того, как колонки названы в
 * рабочей таблице заказчика («Название ВУЗа», «Вендор», «ПО», «Статус по
 * передаче»), и продолжается тем, как те же величины называют в выгрузках из
 * других систем. Однобуквенных и слишком общих слов здесь нет намеренно:
 * подстрока «с» нашлась бы в каждом заголовке.
 */
const SYNONYMS: FieldSynonyms<CatalogField> = {
	organization: [
		'название вуза',
		'наименование вуза',
		'вуз',
		'учебное заведение',
		'образовательная организация',
		'организация',
		'наименование организации',
		'университет',
		'university',
		'institution'
	],
	organizationInn: ['инн', 'инн вуза', 'инн организации', 'inn', 'tax id'],
	vendor: ['вендор', 'производитель', 'правообладатель', 'поставщик', 'vendor'],
	product: ['по', 'продукт', 'программное обеспечение', 'наименование по', 'product', 'software'],
	productCode: ['код по', 'код продукта', 'артикул', 'product code', 'sku'],
	direction: ['ит направление', 'направление', 'направление продукта', 'direction'],
	contractNumber: ['номер договора', 'договор', 'номер соглашения', 'contract number'],
	contractSignedOn: ['дата договора', 'дата подписания договора', 'договор от', 'contract date'],
	contractValidUntil: [
		'договор действует до',
		'срок действия договора',
		'договор до',
		'contract valid until'
	],
	licenseSignedAt: [
		'подписание лицензии',
		'дата подписания лицензии',
		'лицензия подписана',
		'license signed'
	],
	licenseUntil: [
		'срок действия лицензии',
		'срок действия лицензии год',
		'лицензия действует до',
		'срок лицензии',
		'license until'
	],
	transferStatus: [
		'статус по передаче',
		'статус передачи',
		'передача',
		'статус',
		'transfer status'
	],
	manager: [
		'фио менеджера',
		'фио ответственного',
		'менеджер',
		'ответственный',
		'ответственный менеджер',
		'кам',
		'manager',
		'account manager'
	],
	contacts: [
		'ответственные от вуза',
		'контакты вуза',
		'контактное лицо',
		'контактные лица',
		'контакты',
		'контакт',
		'contacts'
	],
	comment: ['комментарий', 'примечание', 'заметка', 'comment', 'note']
};

/** Предложенное сопоставление колонок: правило общее, словарь — свой. */
export function suggestCatalogMapping(headers: readonly string[]): CatalogMapping {
	return suggestFieldMapping(headers, CATALOG_FIELDS, SYNONYMS);
}

/** Поля, без которых строку не к чему отнести. */
function missingRequiredFields(mapping: CatalogMapping): CatalogField[] {
	const assigned = new Set(Object.values(mapping));

	return CATALOG_REQUIRED_FIELDS.filter((field) => !assigned.has(field));
}

/* ------------------------------------------------------------------ разбор */

/** Транслитерация для кода новой записи: код обязан быть машинным именем. */
const TRANSLIT: Record<string, string> = {
	а: 'A',
	б: 'B',
	в: 'V',
	г: 'G',
	д: 'D',
	е: 'E',
	ж: 'ZH',
	з: 'Z',
	и: 'I',
	й: 'Y',
	к: 'K',
	л: 'L',
	м: 'M',
	н: 'N',
	о: 'O',
	п: 'P',
	р: 'R',
	с: 'S',
	т: 'T',
	у: 'U',
	ф: 'F',
	х: 'H',
	ц: 'TS',
	ч: 'CH',
	ш: 'SH',
	щ: 'SCH',
	ъ: '',
	ы: 'Y',
	ь: '',
	э: 'E',
	ю: 'YU',
	я: 'YA'
};

/** Сколько символов кода оставляем: контракт справочника принимает пятьдесят. */
const MAX_GENERATED_CODE = 40;

/**
 * Код для записи, которой его в файле не дали.
 *
 * Рабочая таблица заказчика знает продукт по названию, а `products.code`
 * обязателен и уникален. Код собирается из названия, а не из счётчика: `VERSTAK`
 * в справочнике узнаётся глазами, а `PRD-000117` — нет. Уникальность
 * обеспечивает вызывающий: у него есть список уже занятых кодов.
 */
export function generateCode(name: string, taken: ReadonlySet<string>): string {
	const latin = [...name.toLocaleLowerCase('ru').replaceAll('ё', 'е')]
		.map((letter) => TRANSLIT[letter] ?? letter)
		.join('')
		.toUpperCase()
		.replaceAll(/[^A-Z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, MAX_GENERATED_CODE);

	const base = latin === '' ? 'CODE' : latin;

	if (!taken.has(base)) {
		return base;
	}

	for (let suffix = 2; ; suffix += 1) {
		const candidate = `${base}-${suffix}`;

		if (!taken.has(candidate)) {
			return candidate;
		}
	}
}

/** Год в колонке срока: «2027» — это «действует по 31 декабря 2027 года». */
const YEAR_ONLY = /^(\d{4})(\s*(г|год)\.?)?$/i;

/**
 * Календарная дата из ячейки. `null` — ячейка пуста, `'invalid'` — значение
 * есть, но датой не является.
 *
 * У колонок срока («Срок действия лицензии (год)») значением бывает один год —
 * так эта колонка и названа в рабочей таблице заказчика. Год читается концом
 * года: срок, у которого не назван день, истекает последним днём названного
 * года, а не первым. У даты подписания такого послабления нет: «подписано в
 * 2027 году» — это не дата подписания.
 */
export function parseCatalogDate(
	raw: string,
	options: { yearIsEnd: boolean }
): string | null | 'invalid' {
	const value = raw.trim();

	if (value === '') {
		return null;
	}

	const year = YEAR_ONLY.exec(value);

	if (year !== null) {
		return options.yearIsEnd ? `${year[1]}-12-31` : 'invalid';
	}

	return parseCalendarDate(value);
}

/** Поля, у которых год означает конец года. */
const YEAR_IS_END: readonly CatalogField[] = ['contractValidUntil', 'licenseUntil'];

const EMPTY_VALUES: CatalogRowValues = {
	organizationName: null,
	organizationInn: null,
	vendorName: null,
	productName: null,
	productCode: null,
	directionName: null,
	contractNumber: null,
	contractSignedOn: null,
	contractValidUntil: null,
	licenseSignedAt: null,
	licenseUntil: null,
	transferStatus: null
};

/**
 * Значения колонок, у которых нет своей колонки в `directory_import_rows`.
 *
 * Их не с чем сверять в справочнике и не по чему искать — это ввод для
 * действий вокруг строки, — поэтому второй копии в базе они не заводят:
 * подтверждение читает их из сохранённой строки файла (`raw`) по сохранённому
 * сопоставлению. Файл при этом заново не читается, и правило «человек
 * согласился с тем, что увидел» не нарушается: `raw` — это и есть та строка,
 * которую он увидел.
 */
export type CatalogRowExtra = {
	managerName: string | null;
	contactsText: string | null;
	comment: string | null;
};

/** Строка файла, разобранная и с претензиями разбора. */
export type CatalogSourceRow = {
	rowNo: number;
	origin: number;
	raw: Record<string, string>;
	values: CatalogRowValues;
	extra: CatalogRowExtra;
	issues: CatalogRowIssue[];
};

function columnOf(mapping: CatalogMapping, field: CatalogField): string | null {
	return Object.entries(mapping).find(([, mapped]) => mapped === field)?.[0] ?? null;
}

/** Значение поля как текст; `null` — колонки нет или ячейка пуста. */
function textOf(
	raw: Record<string, string>,
	mapping: CatalogMapping,
	field: CatalogField
): string | null {
	const column = columnOf(mapping, field);

	if (column === null) {
		return null;
	}

	const value = (raw[column] ?? '').trim();

	return value === '' ? null : value;
}

function dateOf(
	issues: CatalogRowIssue[],
	raw: Record<string, string>,
	mapping: CatalogMapping,
	field: CatalogField
): string | null {
	const value = textOf(raw, mapping, field);

	if (value === null) {
		return null;
	}

	const parsed = parseCatalogDate(value, { yearIsEnd: YEAR_IS_END.includes(field) });

	if (parsed === 'invalid') {
		issues.push({
			field,
			message: `${CATALOG_FIELD_LABELS[field]}: «${value}» не похоже на дату (ждём 2026-09-01, 01.09.2026${
				YEAR_IS_END.includes(field) ? ' или 2026' : ''
			})`
		});

		return null;
	}

	return parsed;
}

/** Колонки без своей колонки строки: и разбор, и подтверждение читают их так. */
export function extraFromRaw(
	raw: Record<string, string>,
	mapping: CatalogMapping
): CatalogRowExtra {
	return {
		managerName: textOf(raw, mapping, 'manager'),
		contactsText: textOf(raw, mapping, 'contacts'),
		comment: textOf(raw, mapping, 'comment')
	};
}

/** Разбирает таблицу файла в строки каталога. Чистая функция. */
export function buildCatalogRows(table: StatTable, mapping: CatalogMapping): CatalogSourceRow[] {
	return table.rows.map((row, position) => {
		const issues: CatalogRowIssue[] = [];
		const raw: Record<string, string> = {};

		table.headers.forEach((header, column) => {
			raw[header] = row.cells[column] ?? '';
		});

		// Лишние ячейки — это сдвиг колонок, а не мусор в конце строки: без
		// претензии значения поедут не в те поля, и заметить это будет нечем.
		const extra = row.cells.slice(table.headers.length).filter((cell) => cell !== '');

		if (extra.length > 0) {
			issues.push({
				field: null,
				message: `${describeRowOrigin(table.file, row.origin)} файла: ${extra.length} значений сверх колонок шапки — проверьте разделители`
			});
		}

		const values: CatalogRowValues = {
			...EMPTY_VALUES,
			organizationName: textOf(raw, mapping, 'organization'),
			organizationInn: textOf(raw, mapping, 'organizationInn'),
			vendorName: textOf(raw, mapping, 'vendor'),
			productName: textOf(raw, mapping, 'product'),
			productCode: textOf(raw, mapping, 'productCode'),
			directionName: textOf(raw, mapping, 'direction'),
			contractNumber: textOf(raw, mapping, 'contractNumber'),
			contractSignedOn: dateOf(issues, raw, mapping, 'contractSignedOn'),
			contractValidUntil: dateOf(issues, raw, mapping, 'contractValidUntil'),
			licenseSignedAt: dateOf(issues, raw, mapping, 'licenseSignedAt'),
			licenseUntil: dateOf(issues, raw, mapping, 'licenseUntil'),
			transferStatus: textOf(raw, mapping, 'transferStatus')
		};

		return {
			rowNo: position + 1,
			origin: row.origin,
			raw,
			values,
			extra: extraFromRaw(raw, mapping),
			issues
		};
	});
}

/* ----------------------------------------------------- состояние каталога */

export type OrganizationEntry = {
	id: string;
	inn: string | null;
	name: string;
	inScope: boolean;
	/** Примечание карточки: комментарий строки дописывается к нему. */
	notes: string | null;
};
export type ProductEntry = { id: string; name: string };
export type DirectionEntry = { id: string; name: string };
/** Сотрудник оператора: кандидат в ответственные по колонке менеджера. */
export type UserEntry = {
	id: string;
	fullName: string;
	/** Может ли вызывающий назначить именно его: себя и своих подчинённых. */
	assignable: boolean;
};
/** Действующие назначения вуза на момент снимка. */
export type ResponsibleEntry = {
	/** Кто отвечает за вуз целиком; `null` — общего назначения нет. */
	generalUserId: string | null;
	/** Есть ли назначения по направлениям: с ними общее не сосуществует. */
	hasDirectional: boolean;
};

/**
 * Кто загружает файл. Часть снимка, а не отдельный аргумент: решение «этот
 * менеджер уже назначен» и «этого сотрудника мне назначать нельзя» считается
 * тем же проходом, что и всё остальное, и на предпросмотре обязано выйти тем
 * же, чем на применении.
 */
export type CatalogActor = {
	/** Учётная запись вызывающего; `null` — фоновая задача или сид. */
	userId: string | null;
	/** Есть ли право `responsibles.manage`: без него колонка менеджера — претензия. */
	canAssignResponsible: boolean;
};

/**
 * Каталог целиком в память.
 *
 * Организаций, продуктов и направлений у оператора десятки, договоров — сотни,
 * а файл на тысячу строк иначе дал бы тысячу наборов запросов. Тот же приём,
 * что у импорта данных об обучении (`stats/lookup.ts`), и та же цена: состояние
 * снимается один раз, поэтому применение идёт в одной транзакции — иначе между
 * снимком и записью справочник мог бы измениться.
 */
export type CatalogState = {
	organizationByInn: Map<string, OrganizationEntry>;
	organizationByName: Map<string, OrganizationEntry[]>;
	productByCode: Map<string, ProductEntry>;
	productByName: Map<string, ProductEntry[]>;
	directionByKey: Map<string, DirectionEntry[]>;
	/** Связи «продукт → направление»: `${productId} ${directionId}`. */
	productDirections: Set<string>;
	/** Занятые коды: из них выбирается свободный для новой записи. */
	productCodes: Set<string>;
	directionCodes: Set<string>;
	/** Договоры по паре «организация + номер». */
	contracts: Map<string, ContractState>;
	/** Позиции по паре «договор + продукт». */
	contractItems: Map<string, ContractItemState>;
	/** Активные сотрудники по ключам ФИО: полному и «фамилия и инициалы». */
	userByName: Map<string, UserEntry[]>;
	/** Действующие назначения по организациям. */
	responsibles: Map<string, ResponsibleEntry>;
	/** Контакты организаций: `${organizationId} ${ключ}` — почта, телефон или ФИО. */
	organizationContacts: Set<string>;
	actor: CatalogActor;
};

function pushKeyed<TEntry>(index: Map<string, TEntry[]>, key: string, entry: TEntry): void {
	if (key === '') {
		return;
	}

	const found = index.get(key);

	if (found === undefined) {
		index.set(key, [entry]);
	} else if (!found.includes(entry)) {
		found.push(entry);
	}
}

const contractKey = (organizationId: string, number: string): string =>
	`${organizationId} ${number.trim().toLocaleLowerCase('ru')}`;

const contractItemKey = (contractId: string, productId: string): string =>
	`${contractId} ${productId}`;

const productDirectionKey = (productId: string, directionId: string): string =>
	`${productId} ${directionId}`;

const contactKey = (organizationId: string, key: string): string => `${organizationId} ${key}`;

/**
 * Ключи, под которыми сотрудник узнаётся по колонке менеджера: полное ФИО и
 * «фамилия и инициалы». Второй ключ нужен потому, что в рабочей таблице пишут
 * и «Вересова Анна Сергеевна», и «Вересова А.С.», и это один человек — а вот
 * две Вересовых А. под этим ключом сойдутся, и тогда строка обязана отказать.
 */
export function userNameKeys(fullName: string): string[] {
	const normalized = normalizeName(fullName);
	const parts = normalized.split(' ').filter((part) => part !== '');

	if (parts.length < 2) {
		return normalized === '' ? [] : [normalized];
	}

	const initials = [parts[0], ...parts.slice(1).map((part) => part.slice(0, 1))].join(' ');

	return initials === normalized ? [normalized] : [normalized, initials];
}

/** Пустой снимок. Вызывающий без прав и без учётной записи — безопасное умолчание. */
export function emptyCatalogState(
	actor: CatalogActor = { userId: null, canAssignResponsible: false }
): CatalogState {
	return {
		organizationByInn: new Map(),
		organizationByName: new Map(),
		productByCode: new Map(),
		productByName: new Map(),
		directionByKey: new Map(),
		productDirections: new Set(),
		productCodes: new Set(),
		directionCodes: new Set(),
		contracts: new Map(),
		contractItems: new Map(),
		userByName: new Map(),
		responsibles: new Map(),
		organizationContacts: new Set(),
		actor
	};
}

/** Кладёт организацию в снимок: по ИНН и по каждому из её названий. */
export function registerOrganization(
	state: CatalogState,
	entry: OrganizationEntry,
	names: readonly string[]
): void {
	if (entry.inn !== null) {
		state.organizationByInn.set(entry.inn, entry);
	}

	for (const name of names) {
		pushKeyed(state.organizationByName, normalizeName(name), entry);
	}
}

/** Кладёт продукт в снимок: по коду и по названию. */
export function registerProduct(state: CatalogState, entry: ProductEntry, code: string): void {
	state.productCodes.add(code);
	state.productByCode.set(normalizeName(code), entry);
	pushKeyed(state.productByName, normalizeName(entry.name), entry);
}

/** Кладёт направление в снимок: и код, и название ведут к одной записи. */
export function registerDirection(state: CatalogState, entry: DirectionEntry, code: string): void {
	state.directionCodes.add(code);
	pushKeyed(state.directionByKey, normalizeName(code), entry);
	pushKeyed(state.directionByKey, normalizeName(entry.name), entry);
}

/** Кладёт договор в снимок по паре «организация + номер». */
export function registerContract(
	state: CatalogState,
	organizationId: string,
	contract: ContractState
): void {
	state.contracts.set(contractKey(organizationId, contract.number), contract);
}

/** Кладёт сотрудника в снимок под оба его ключа ФИО. */
export function registerUser(state: CatalogState, entry: UserEntry): void {
	for (const key of userNameKeys(entry.fullName)) {
		pushKeyed(state.userByName, key, entry);
	}
}

/** Кладёт в снимок действующее назначение вуза. */
export function registerResponsible(
	state: CatalogState,
	organizationId: string,
	entry: ResponsibleEntry
): void {
	state.responsibles.set(organizationId, entry);
}

/**
 * Ключи, по которым контакт считается уже заведённым у этой организации:
 * почта, цифры телефона и ФИО. Любого совпавшего достаточно — один и тот же
 * человек в двух строках файла записан то с почтой, то с телефоном.
 */
export function contactKeys(contact: ContactIdentity): string[] {
	const keys = [`фио ${normalizeName(contactFullName(contact))}`];

	if (contact.email !== null) {
		keys.push(`почта ${normalizeContactEmail(contact.email)}`);
	}

	if (contact.phone !== null) {
		keys.push(`телефон ${normalizeContactPhone(contact.phone)}`);
	}

	return keys;
}

/** Кладёт контакт организации в снимок: по почте, телефону и ФИО сразу. */
export function registerContact(
	state: CatalogState,
	organizationId: string,
	contact: ContactIdentity
): void {
	for (const key of contactKeys(contact)) {
		state.organizationContacts.add(contactKey(organizationId, key));
	}
}

/** Кладёт позицию в снимок по паре «договор + продукт». */
export function registerContractItem(
	state: CatalogState,
	contractId: string,
	productId: string,
	item: ContractItemState
): void {
	state.contractItems.set(contractItemKey(contractId, productId), item);
}

/**
 * Снимает состояние каталога.
 *
 * Организации читаются **по всей базе**, а не по области доступа: уникальность
 * ИНН области не знает, и импорт, не увидевший чужой вуз, завёл бы его вторым.
 * Область при этом не забыта — она отмечена признаком `inScope`, и строка про
 * вуз вне области отвечает отказом с объяснением, а не молча заводит двойника.
 */
export async function loadCatalogState(
	ctx: ActorContext,
	executor: Tx | ReturnType<typeof getDb> = getDb()
): Promise<CatalogState> {
	const state = emptyCatalogState({
		userId: ctx.user?.id ?? null,
		canAssignResponsible: can(ctx, 'responsibles.manage')
	});

	const [
		organizationRows,
		scopedRows,
		productRows,
		directionRows,
		linkRows,
		contractRows,
		itemRows,
		userRows,
		responsibleRows,
		contactRows
	] = await Promise.all([
		executor
			.select({
				id: organizations.id,
				inn: organizations.inn,
				shortName: organizations.shortName,
				legalName: organizations.legalName,
				notes: organizations.notes
			})
			.from(organizations),
		executor
			.select({ id: organizations.id })
			.from(organizations)
			.where(scopeFilter(ctx, organizations.id)),
		executor.select({ id: products.id, code: products.code, name: products.name }).from(products),
		executor
			.select({ id: directions.id, code: directions.code, name: directions.name })
			.from(directions),
		executor
			.select({
				productId: productDirections.productId,
				directionId: productDirections.directionId
			})
			.from(productDirections),
		executor
			.select({
				id: contracts.id,
				organizationId: contracts.organizationId,
				number: contracts.number,
				signedOn: contracts.signedOn,
				validUntil: contracts.validUntil
			})
			.from(contracts),
		executor
			.select({
				id: contractItems.id,
				contractId: contractItems.contractId,
				productId: contractItems.productId,
				licenseSignedAt: contractItems.licenseSignedAt,
				licenseUntil: contractItems.licenseUntil,
				transferStatus: contractItems.transferStatus
			})
			.from(contractItems),
		// Сотрудники читаются по всему штату, а не по области: двух однофамильцев
		// с одним инициалом надо увидеть обоих, даже если один из них чужой, —
		// иначе строка молча выберет «своего» там, где выбирать нельзя.
		executor
			.select({ id: users.id, fullName: users.fullName })
			.from(users)
			.where(and(eq(users.isActive, true), ne(users.roleId, 'service'))),
		executor
			.select({
				organizationId: organizationResponsibles.organizationId,
				userId: organizationResponsibles.userId,
				directionId: organizationResponsibles.directionId
			})
			.from(organizationResponsibles)
			.where(isNull(organizationResponsibles.validTo)),
		executor
			.select({
				organizationId: affiliations.organizationId,
				lastName: people.lastName,
				firstName: people.firstName,
				middleName: people.middleName,
				email: people.email,
				phone: people.phone
			})
			.from(affiliations)
			.innerJoin(people, eq(people.id, affiliations.personId))
	]);

	const scoped = new Set(scopedRows.map((row) => row.id));

	for (const row of organizationRows) {
		registerOrganization(
			state,
			{
				id: row.id,
				inn: row.inn,
				name: row.shortName,
				inScope: scoped.has(row.id),
				notes: row.notes
			},
			[row.shortName, row.legalName]
		);
	}

	for (const row of userRows) {
		registerUser(state, {
			id: row.id,
			fullName: row.fullName,
			assignable: ctx.scope.kind === 'all' || ctx.scope.userIds.has(row.id)
		});
	}

	for (const row of responsibleRows) {
		const entry = state.responsibles.get(row.organizationId) ?? {
			generalUserId: null,
			hasDirectional: false
		};

		if (row.directionId === null) {
			entry.generalUserId = row.userId;
		} else {
			entry.hasDirectional = true;
		}

		registerResponsible(state, row.organizationId, entry);
	}

	for (const row of contactRows) {
		registerContact(state, row.organizationId, row);
	}

	for (const row of productRows) {
		registerProduct(state, { id: row.id, name: row.name }, row.code);
	}

	for (const row of directionRows) {
		registerDirection(state, { id: row.id, name: row.name }, row.code);
	}

	for (const row of linkRows) {
		state.productDirections.add(productDirectionKey(row.productId, row.directionId));
	}

	for (const row of contractRows) {
		registerContract(state, row.organizationId, {
			id: row.id,
			number: row.number,
			signedOn: row.signedOn,
			validUntil: row.validUntil
		});
	}

	for (const row of itemRows) {
		registerContractItem(state, row.contractId, row.productId, {
			id: row.id,
			licenseSignedAt: row.licenseSignedAt,
			licenseUntil: row.licenseUntil,
			transferStatus: row.transferStatus
		});
	}

	return state;
}

/* --------------------------------------------------------- исполнитель записи */

/**
 * Кто выполняет записи строки.
 *
 * Предпросмотру достаётся исполнитель, который ничего не пишет и раздаёт
 * временные идентификаторы, подтверждению — тот, что пишет по-настоящему.
 * Правила при этом считает один и тот же код: расхождение между тем, что
 * человек подтвердил, и тем, что записалось, невозможно по устройству.
 */
export type CatalogWriter = {
	organization(input: {
		name: string;
		inn: string | null;
		kind: 'educational_institution' | 'customer_company';
	}): Promise<string>;
	product(input: {
		code: string;
		name: string;
		vendorOrganizationId: string | null;
	}): Promise<string>;
	direction(input: { code: string; name: string }): Promise<string>;
	linkProductDirection(productId: string, directionId: string): Promise<void>;
	contract(draft: Parameters<typeof insertContract>[2]): Promise<ContractState>;
	updateContract(id: string, next: ReturnType<typeof mergeContract>['next']): Promise<void>;
	contractItem(draft: Parameters<typeof insertContractItem>[2]): Promise<ContractItemState>;
	updateContractItem(id: string, next: ReturnType<typeof mergeContractItem>['next']): Promise<void>;
	/** Ответственный за вуз целиком по колонке менеджера. */
	assignResponsible(input: { organizationId: string; userId: string }): Promise<void>;
	/** Человек из колонки контактов вместе с его ролью и основанием обработки. */
	contact(input: { organizationId: string; contact: ParsedContact }): Promise<void>;
	/** Примечание карточки вуза целиком: комментарий к нему уже дописан. */
	organizationNotes(input: { organizationId: string; notes: string }): Promise<void>;
};

/** Исполнитель предпросмотра: ничего не пишет, идентификаторы временные. */
export function dryWriter(): CatalogWriter {
	let counter = 0;
	const nextId = (): string => {
		counter += 1;

		return `pending-${counter}`;
	};

	return {
		organization: async () => nextId(),
		product: async () => nextId(),
		direction: async () => nextId(),
		linkProductDirection: async () => {},
		contract: async (draft) => ({
			id: nextId(),
			number: draft.number,
			...mergeContract(null, draft).next
		}),
		updateContract: async () => {},
		contractItem: async (draft) => ({ id: nextId(), ...mergeContractItem(null, draft).next }),
		updateContractItem: async () => {},
		assignResponsible: async () => {},
		contact: async () => {},
		organizationNotes: async () => {}
	};
}

/**
 * Основание обработки контактов из рабочей таблицы школы.
 *
 * Согласия субъекта у такой записи нет и быть не может: человека в файл вписала
 * не система, а сотрудник вуза, и подписи под текстом никто не собирал. Данные
 * представителя контрагента обрабатываются ради договора, который эта же строка
 * и описывает, — поэтому основание «исполнение договора», а версия текста —
 * день загрузки, как и у остальных записей без подписанного текста
 * (`docs/directory.md`, «Допущения S4.1a»).
 */
const IMPORT_CONSENT_BASIS = 'contract';

/** Исполнитель подтверждения: пишет через сервисы владельцев записей. */
function databaseWriter(ctx: ActorContext, tx: Tx): CatalogWriter {
	return {
		organization: async (input) => {
			const created = await createOrganization(
				ctx,
				{
					kind: input.kind,
					// Уровень образования обязателен ровно у учебного заведения — это
					// проверяет схема. Файл каталога о нём не говорит, поэтому новый вуз
					// заводится высшим учебным заведением, а уточняют уровень на карточке.
					educationLevel: input.kind === 'educational_institution' ? 'vo' : null,
					legalName: input.name,
					shortName: input.name,
					inn: input.inn,
					kpp: null,
					ogrn: null,
					region: null,
					website: null,
					notes: null,
					isActive: true,
					externalSource: null,
					externalId: null
				},
				tx
			);

			return created.id;
		},
		product: async (input) => {
			const created = await createProduct(
				ctx,
				{
					code: input.code,
					name: input.name,
					vendorOrganizationId: input.vendorOrganizationId,
					description: null,
					// Продукт, заведённый импортом, — черновик: его завела строка чужой
					// таблицы, а не решение о том, что его предлагают вузам.
					status: 'draft',
					externalSource: null,
					externalId: null
				},
				tx
			);

			return created.id;
		},
		direction: async (input) => (await createDirection(ctx, input, tx)).id,
		linkProductDirection: async (productId, directionId) => {
			await tx.insert(productDirections).values({ productId, directionId });
		},
		contract: async (draft) => insertContract(ctx, tx, draft),
		updateContract: async (id, next) => updateContract(ctx, tx, id, next),
		contractItem: async (draft) => insertContractItem(ctx, tx, draft),
		updateContractItem: async (id, next) => updateContractItem(ctx, tx, id, next),
		// Через сервис назначений, а не своей вставкой: на этих строках держится
		// область доступа, и правило «общее назначение и назначения по
		// направлениям не сосуществуют» обязано быть одно на все пути.
		assignResponsible: async (input) =>
			assignResponsible(ctx, { ...input, directionId: null, transferInteractions: false }, tx),
		contact: async ({ organizationId, contact }) => {
			// Один день на полномочия и на основание обработки: они начинаются
			// одной записью, и разойтись на границе суток им незачем.
			const day = formatIsoDay();
			const person = await createPerson(
				ctx,
				{
					lastName: contact.lastName,
					firstName: contact.firstName,
					middleName: contact.middleName,
					email: contact.email,
					phone: contact.phone,
					notes: null
				},
				tx
			);

			await createAffiliation(
				ctx,
				{
					personId: person.id,
					organizationId,
					siteId: null,
					position: contact.position,
					// Кем человек работает, файл не говорит, а роль — это закрытый
					// список; «другое» здесь честнее, чем выбранная за него должность.
					roleKind: 'other',
					// Основным контактом человека отмечает тот, кто с ним работает:
					// загрузка файла не знает, кому звонят первым.
					isPrimary: false,
					validFrom: day,
					validTo: null,
					channel: null
				},
				tx
			);

			// Своей вставкой, как и у заявки с сайта (`exchange/intake.ts`):
			// `recordConsent` — путь карточки, он сам открывает транзакцию и
			// проверяет видимость человека, которого в общем пуле ещё нет.
			const [record] = await tx
				.insert(consents)
				.values({
					personId: person.id,
					basis: IMPORT_CONSENT_BASIS,
					textVersion: day,
					givenAt: day,
					recordedBy: ctx.user?.id ?? null
				})
				.returning({ id: consents.id });

			await recordAuditEvent(
				ctx,
				{
					type: 'people.consent_recorded',
					outcome: 'success',
					subject: { type: 'consent', id: record.id },
					details: { personId: person.id }
				},
				tx
			);
		},
		organizationNotes: async ({ organizationId, notes }) => {
			requirePermission(ctx, 'organizations.write');

			await tx
				.update(organizations)
				.set({ notes, updatedAt: sql`now()` })
				.where(eq(organizations.id, organizationId));

			await recordAuditEvent(
				ctx,
				{
					type: 'organizations.updated',
					outcome: 'success',
					subject: { type: 'organization', id: organizationId },
					details: { changedFields: ['notes'] }
				},
				tx
			);
		}
	};
}

/* --------------------------------------------------------------- применение */

/** Итог строки: что с ней стало и на какие записи она легла. */
export type CatalogRowResult = {
	rowNo: number;
	action: CatalogRowAction;
	issues: CatalogRowIssue[];
	creations: CatalogCreation[];
	changes: CatalogRowChange[];
	organizationId: string | null;
	productId: string | null;
	contractId: string | null;
	contractItemId: string | null;
};

/** Ключ, по которому строка считается тем же самым, что и другая строка файла. */
function rowKey(values: CatalogRowValues): string {
	return [
		values.organizationInn ?? normalizeName(values.organizationName ?? ''),
		values.productCode === null
			? normalizeName(values.productName ?? '')
			: normalizeName(values.productCode),
		normalizeName(values.contractNumber ?? '')
	].join('|');
}

/** Поля, по которым строки-двойники сверяются между собой. */
const COMPARED_FIELDS: readonly (keyof CatalogRowValues)[] = [
	'contractSignedOn',
	'contractValidUntil',
	'licenseSignedAt',
	'licenseUntil',
	'transferStatus',
	'directionName',
	'vendorName'
];

/**
 * Двойники внутри файла.
 *
 * Две строки про ту же пару «вуз и продукт» в том же договоре — обычное дело:
 * рабочая таблица склеена из нескольких, и одна и та же позиция попадает в неё
 * дважды. Если значения у них совпадают, вторая строка просто ничего не меняет,
 * и отказывать ей не за что. А вот если по одному и тому же полю строки говорят
 * **разное**, выбрать одну из них значит выбрать наугад: претензию получают обе.
 */
function markConflictingDuplicates(rows: readonly CatalogSourceRow[]): void {
	const groups = new Map<string, CatalogSourceRow[]>();

	for (const row of rows) {
		const key = rowKey(row.values);
		groups.set(key, [...(groups.get(key) ?? []), row]);
	}

	for (const group of groups.values()) {
		if (group.length < 2) {
			continue;
		}

		const conflicting = COMPARED_FIELDS.filter((field) => {
			const stated = group
				.map((row) => row.values[field])
				.filter((value): value is string => value !== null);

			return new Set(stated).size > 1;
		});

		if (conflicting.length === 0) {
			continue;
		}

		for (const row of group) {
			const others = group.filter((other) => other !== row).map((other) => other.rowNo);

			row.issues.push({
				field: null,
				message: `Дубль: строки ${others.join(', ')} описывают ту же позицию иначе — расходятся ${conflicting
					.map((field) => CATALOG_FIELD_LABELS[field as CatalogField].toLocaleLowerCase('ru'))
					.join(', ')}`
			});
		}
	}
}

/** Единственная запись по ключу или объяснение, почему её нет. */
function pickOne<TEntry>(
	found: TEntry[] | undefined,
	value: string
): { entry: TEntry | null; message: string | null } {
	if (found === undefined || found.length === 0) {
		return { entry: null, message: null };
	}

	if (found.length > 1) {
		return {
			entry: null,
			message: `Под «${value}» подходит несколько записей справочника — уточните значение`
		};
	}

	return { entry: found[0], message: null };
}

/** Что строка сделает с назначением ответственного; `null` — ничего. */
type ManagerPlan = { user: UserEntry } | null;

/** Новое примечание карточки целиком; `null` — дописывать нечего. */
type NotesPlan = { next: string } | null;

/**
 * Сотрудник из колонки менеджера и назначение, которое строка сделает.
 *
 * Отказов здесь четыре, и все четыре — про то, что выбор сделать нельзя, а не
 * про то, что он неудобен: права нет, сотрудник не найден, сотрудников
 * несколько, назначать этого сотрудника вызывающему нельзя. Пятый — чужое
 * действующее назначение: заменить его загрузкой файла значило бы отобрать вуз
 * у человека, не открывая карточку.
 */
function planManager(
	state: CatalogState,
	organization: OrganizationEntry | null,
	managerName: string | null,
	issues: CatalogRowIssue[]
): ManagerPlan {
	if (managerName === null) {
		return null;
	}

	const issue = (message: string): null => {
		issues.push({ field: 'manager', message });

		return null;
	};

	if (!state.actor.canAssignResponsible) {
		return issue(
			`Колонка «${CATALOG_FIELD_LABELS.manager}» назначает ответственного за вуз, а права на это у вас нет`
		);
	}

	const keys = userNameKeys(managerName);
	const found = keys.map((key) => state.userByName.get(key)).find((entry) => entry !== undefined);

	if (found === undefined) {
		return issue(`Сотрудник «${managerName}» не найден среди действующих учётных записей`);
	}

	if (found.length > 1) {
		return issue(`Под «${managerName}» подходит несколько сотрудников — уточните ФИО`);
	}

	const user = found[0];

	if (!user.assignable) {
		return issue(
			`Назначать можно себя и своих подчинённых: «${user.fullName}» вне вашей области доступа`
		);
	}

	// Вуза ещё нет: его заведёт эта же строка, и ответственным по умолчанию
	// станет тот, кто загрузил файл (`createOrganization`). Менеджер из файла
	// его сменяет — это не чужое назначение, а то самое, ради чего колонка есть.
	const current =
		organization === null
			? { generalUserId: state.actor.userId, hasDirectional: false }
			: (state.responsibles.get(organization.id) ?? { generalUserId: null, hasDirectional: false });

	if (current.hasDirectional) {
		return issue(
			'У вуза есть ответственные по направлениям: ответственного за вуз целиком назначают на его карточке'
		);
	}

	if (current.generalUserId === user.id) {
		return null;
	}

	if (current.generalUserId !== null && organization !== null) {
		return issue(
			`За вуз «${organization.name}» уже отвечает другой сотрудник: загрузка чужое назначение не заменяет — смените его на карточке вуза`
		);
	}

	return { user };
}

/**
 * Люди из колонки контактов, которых у вуза ещё нет.
 *
 * Проверяются они теми же схемами, что и форма контакта: почта, телефон,
 * длина имени и должности. Иначе строка обещала бы на предпросмотре контакт,
 * который потом уронил бы всю загрузку на записи.
 */
function planContacts(
	state: CatalogState,
	organization: OrganizationEntry | null,
	contactsText: string | null,
	issues: CatalogRowIssue[]
): ParsedContact[] {
	if (contactsText === null) {
		return [];
	}

	const parsed = parseContacts(contactsText);

	for (const chunk of parsed.unparsed) {
		issues.push({
			field: 'contacts',
			message: `Контакт «${chunk}» не разобран: нужны хотя бы фамилия и имя`
		});
	}

	const planned: ParsedContact[] = [];
	const taken = new Set<string>();

	for (const contact of parsed.contacts) {
		const person = createPersonSchema.safeParse({
			lastName: contact.lastName,
			firstName: contact.firstName,
			middleName: contact.middleName,
			email: contact.email,
			phone: contact.phone,
			notes: null
		});

		if (!person.success) {
			for (const problem of person.error.issues) {
				issues.push({
					field: 'contacts',
					message: `Контакт «${contactFullName(contact)}»: ${problem.message}`
				});
			}

			continue;
		}

		const position = affiliationPositionSchema.safeParse(contact.position);

		if (!position.success) {
			issues.push({
				field: 'contacts',
				message: `Контакт «${contactFullName(contact)}»: ${position.error.issues[0].message}`
			});

			continue;
		}

		const keys = contactKeys(contact);
		const known = keys.some(
			(key) =>
				taken.has(key) ||
				(organization !== null && state.organizationContacts.has(contactKey(organization.id, key)))
		);

		if (known) {
			continue;
		}

		for (const key of keys) {
			taken.add(key);
		}

		planned.push(contact);
	}

	return planned;
}

/**
 * Примечание карточки вуза после того, как комментарий строки к нему дописан.
 *
 * Дописывается, а не затирает: чужая заметка на карточке — это работа человека,
 * и файл её не отменяет. Тот же комментарий второй раз ничего не меняет — по
 * этому и работает повторная загрузка.
 */
function planNotes(
	organization: OrganizationEntry | null,
	comment: string | null,
	issues: CatalogRowIssue[]
): NotesPlan {
	if (comment === null) {
		return null;
	}

	const current = organization?.notes ?? null;

	// Строки примечания сравниваются без переводов строки: текст из формы
	// приходит с `\r\n`, а дописанный загрузкой — с `\n`, и один и тот же
	// комментарий иначе дописался бы второй раз.
	if (current !== null && current.split(/\r?\n/).some((line) => line.trim() === comment)) {
		return null;
	}

	const next = current === null || current === '' ? comment : `${current}\n${comment}`;
	const checked = organizationNotesSchema.safeParse(next);

	if (!checked.success) {
		issues.push({ field: 'comment', message: checked.error.issues[0].message });

		return null;
	}

	return { next };
}

/**
 * Разбирает и применяет строки каталога.
 *
 * Один проход на предпросмотр и на подтверждение: отличается только
 * исполнитель. Состояние по ходу обновляется, поэтому вторая строка про тот же
 * вуз видит его уже заведённым — и отвечает «без изменений», а не заводит
 * второй раз.
 */
export async function applyCatalogRows(
	state: CatalogState,
	writer: CatalogWriter,
	rows: readonly CatalogSourceRow[]
): Promise<CatalogRowResult[]> {
	markConflictingDuplicates(rows);

	const results: CatalogRowResult[] = [];

	for (const row of rows) {
		results.push(await applyCatalogRow(state, writer, row));
	}

	return results;
}

async function applyCatalogRow(
	state: CatalogState,
	writer: CatalogWriter,
	row: CatalogSourceRow
): Promise<CatalogRowResult> {
	const issues: CatalogRowIssue[] = [...row.issues];
	const creations: CatalogCreation[] = [];
	const changes: CatalogRowChange[] = [];
	const values = row.values;

	/** Ничего нового к претензиям разбора строка пока не добавила. */
	const clean = (): boolean => issues.length === row.issues.length;

	const failed = (): CatalogRowResult => ({
		rowNo: row.rowNo,
		action: 'error',
		issues,
		creations: [],
		changes: [],
		organizationId: null,
		productId: null,
		contractId: null,
		contractItemId: null
	});

	/* --- организация: ИНН сильнее названия, он для того и заведён --- */

	let organization: OrganizationEntry | null = null;
	const organizationName = values.organizationName;

	if (values.organizationInn !== null && !isValidInn(values.organizationInn)) {
		issues.push({
			field: 'organizationInn',
			message: `ИНН «${values.organizationInn}» не проходит проверку контрольной суммы`
		});
	} else if (values.organizationInn !== null) {
		organization = state.organizationByInn.get(values.organizationInn) ?? null;
	}

	if (organization === null && organizationName !== null && clean()) {
		const byName = pickOne(
			state.organizationByName.get(normalizeName(organizationName)),
			organizationName
		);

		if (byName.message !== null) {
			issues.push({ field: 'organization', message: byName.message });
		} else if (byName.entry !== null) {
			// Тот же вуз под другим ИНН — это не «поправить карточку», а два разных
			// юридических лица под одним названием либо опечатка в файле. И то и
			// другое решает человек, а не загрузка.
			if (
				values.organizationInn !== null &&
				byName.entry.inn !== null &&
				byName.entry.inn !== values.organizationInn
			) {
				issues.push({
					field: 'organizationInn',
					message: `Организация «${organizationName}» заведена с ИНН ${byName.entry.inn}, а в файле указан ${values.organizationInn}`
				});
			} else {
				organization = byName.entry;
			}
		}
	}

	if (organization !== null && !organization.inScope) {
		issues.push({
			field: 'organization',
			message: `Организация «${organization.name}» ведётся вне вашей области доступа — строку применит только тот, кому она видна`
		});
	}

	if (organization === null && organizationName === null && clean()) {
		issues.push({
			field: 'organization',
			message:
				values.organizationInn === null
					? `${CATALOG_FIELD_LABELS.organization}: значение не заполнено`
					: `Организация с ИНН «${values.organizationInn}» не найдена, а названия для новой записи в файле нет`
		});
	}

	/* --- продукт: код сильнее названия --- */

	let product: ProductEntry | null = null;
	const productName = values.productName;

	if (values.productCode !== null) {
		product = state.productByCode.get(normalizeName(values.productCode)) ?? null;
	}

	if (product === null && productName !== null) {
		const byName = pickOne(state.productByName.get(normalizeName(productName)), productName);

		if (byName.message !== null) {
			issues.push({ field: 'product', message: byName.message });
		} else {
			product = byName.entry;
		}
	}

	if (product === null && productName === null) {
		issues.push({
			field: 'product',
			message:
				values.productCode === null
					? `${CATALOG_FIELD_LABELS.product}: значение не заполнено`
					: `Продукт с кодом «${values.productCode}» не найден, а названия для новой записи в файле нет`
		});
	}

	/* --- направление: по названию или коду --- */

	let direction: DirectionEntry | null = null;
	const directionName = values.directionName;

	if (directionName !== null) {
		const found = pickOne(state.directionByKey.get(normalizeName(directionName)), directionName);

		if (found.message !== null) {
			issues.push({ field: 'direction', message: found.message });
		} else {
			direction = found.entry;
		}
	}

	/* --- вендор: он нужен только новому продукту --- */

	let vendor: OrganizationEntry | null = null;
	const vendorName = product === null ? values.vendorName : null;

	if (vendorName !== null) {
		const found = pickOne(state.organizationByName.get(normalizeName(vendorName)), vendorName);

		if (found.message !== null) {
			issues.push({ field: 'vendor', message: found.message });
		} else {
			vendor = found.entry;
		}
	}

	/* --- договор и позиция: считаются до записи, чтобы отказ пришёл до неё --- */

	const contractNumber = values.contractNumber;
	const licenseStated =
		values.licenseSignedAt !== null ||
		values.licenseUntil !== null ||
		values.transferStatus !== null;

	if (contractNumber === null && licenseStated) {
		issues.push({
			field: 'contractNumber',
			message: 'Лицензия и статус передачи лежат в позиции договора, а номера договора в строке нет'
		});
	}

	// Сверка идёт и у ещё не заведённых записей: даты строки обязаны быть
	// осмысленными сами по себе, иначе новый вуз завёлся бы вместе с лицензией,
	// которая истекает раньше, чем подписана. Ссылки на договор и продукт для
	// сверки не нужны — их подставит запись, когда дойдёт до неё.
	const contractDraft =
		contractNumber === null
			? null
			: {
					organizationId: organization?.id ?? '',
					number: contractNumber,
					signedOn: values.contractSignedOn,
					validUntil: values.contractValidUntil
				};

	const existingContract =
		contractNumber === null || organization === null
			? null
			: (state.contracts.get(contractKey(organization.id, contractNumber)) ?? null);

	const existingItem =
		existingContract === null || product === null
			? null
			: (state.contractItems.get(contractItemKey(existingContract.id, product.id)) ?? null);

	let contractMerge: ReturnType<typeof mergeContract> | null = null;
	let itemMerge: ReturnType<typeof mergeContractItem> | null = null;

	if (contractDraft !== null) {
		try {
			contractMerge = mergeContract(existingContract, contractDraft);
			itemMerge = mergeContractItem(existingItem, {
				contractId: existingContract?.id ?? '',
				productId: product?.id ?? '',
				licenseSignedAt: values.licenseSignedAt,
				licenseUntil: values.licenseUntil,
				transferStatus: values.transferStatus
			});
		} catch (error) {
			// Предметная претензия к данным строки — это её претензия, а не отказ
			// всего импорта: отвергнуть тысячу строк из-за одной перевёрнутой даты
			// значит заставить человека чинить файл вслепую. Всё остальное летит
			// дальше нетронутым.
			if (!(error instanceof ValidationError)) {
				throw error;
			}

			issues.push({ field: null, message: [error.message, ...error.issues].join(': ') });
		}
	}

	/* --- менеджер, контакты и комментарий: записи вокруг справочника --- */

	const managerPlan = planManager(state, organization, row.extra.managerName, issues);
	const contactsPlan = planContacts(state, organization, row.extra.contactsText, issues);
	const notesPlan = planNotes(organization, row.extra.comment, issues);

	// Дальше идут записи, и до них доходит только строка без единой претензии:
	// наполовину применённой строки не бывает.
	if (issues.length > 0) {
		return failed();
	}

	if (organization === null) {
		// Название здесь заведомо не пусто: иначе выше стояла бы претензия.
		const name = organizationName as string;
		const id = await writer.organization({
			name,
			inn: values.organizationInn,
			kind: 'educational_institution'
		});

		organization = { id, inn: values.organizationInn, name, inScope: true, notes: null };
		registerOrganization(state, organization, [name]);
		// Ответственным за новый вуз сервис справочника ставит автора записи;
		// строка с менеджером сменит его ниже, а без менеджера так и останется.
		registerResponsible(state, id, {
			generalUserId: state.actor.userId,
			hasDirectional: false
		});
		creations.push({ target: 'organization', subject: name });
	}

	if (vendorName !== null && vendor === null) {
		const id = await writer.organization({ name: vendorName, inn: null, kind: 'customer_company' });

		vendor = { id, inn: null, name: vendorName, inScope: true, notes: null };
		registerOrganization(state, vendor, [vendorName]);
		creations.push({ target: 'vendor', subject: vendorName });
	}

	if (directionName !== null && direction === null) {
		const code = generateCode(directionName, state.directionCodes);
		const id = await writer.direction({ code, name: directionName });

		direction = { id, name: directionName };
		registerDirection(state, direction, code);
		creations.push({ target: 'direction', subject: directionName });
	}

	if (product === null) {
		const name = productName as string;
		const code = values.productCode ?? generateCode(name, state.productCodes);
		const id = await writer.product({ code, name, vendorOrganizationId: vendor?.id ?? null });

		product = { id, name };
		registerProduct(state, product, code);
		creations.push({ target: 'product', subject: `${name} (${code})` });
	}

	if (direction !== null) {
		const link = productDirectionKey(product.id, direction.id);

		if (!state.productDirections.has(link)) {
			await writer.linkProductDirection(product.id, direction.id);
			state.productDirections.add(link);
			changes.push({
				target: 'product',
				subject: product.name,
				field: 'ИТ-направление',
				from: null,
				to: direction.name
			});
		}
	}

	let contract: ContractState | null = existingContract;
	let contractItem: ContractItemState | null = null;

	if (contractNumber !== null) {
		const draft = {
			organizationId: organization.id,
			number: contractNumber,
			signedOn: values.contractSignedOn,
			validUntil: values.contractValidUntil
		};

		if (contract === null) {
			contract = await writer.contract(draft);
			creations.push({ target: 'contract', subject: contractNumber });
		} else if (contractMerge !== null && contractMerge.changes.length > 0) {
			await writer.updateContract(contract.id, contractMerge.next);
			contract = { ...contract, ...contractMerge.next };

			for (const change of contractMerge.changes) {
				changes.push({
					target: 'contract',
					subject: contractNumber,
					field: change.label,
					from: change.from,
					to: change.to
				});
			}
		}

		registerContract(state, organization.id, contract);

		const subject = `${contractNumber} · ${product.name}`;
		const itemDraft = {
			contractId: contract.id,
			productId: product.id,
			licenseSignedAt: values.licenseSignedAt,
			licenseUntil: values.licenseUntil,
			transferStatus: values.transferStatus
		};

		if (existingItem === null) {
			contractItem = await writer.contractItem(itemDraft);
			creations.push({ target: 'contractItem', subject });
		} else {
			contractItem = existingItem;

			if (itemMerge !== null && itemMerge.changes.length > 0) {
				await writer.updateContractItem(existingItem.id, itemMerge.next);
				contractItem = { ...existingItem, ...itemMerge.next };

				for (const change of itemMerge.changes) {
					changes.push({
						target: 'contractItem',
						subject,
						field: change.label,
						from: change.from,
						to: change.to
					});
				}
			}
		}

		registerContractItem(state, contract.id, product.id, contractItem);
	}

	if (managerPlan !== null) {
		await writer.assignResponsible({
			organizationId: organization.id,
			userId: managerPlan.user.id
		});
		registerResponsible(state, organization.id, {
			generalUserId: managerPlan.user.id,
			hasDirectional: false
		});
		creations.push({ target: 'responsible', subject: managerPlan.user.fullName });
	}

	for (const contact of contactsPlan) {
		await writer.contact({ organizationId: organization.id, contact });
		registerContact(state, organization.id, contact);
		creations.push({
			target: 'contact',
			subject: `${contactFullName(contact)} · ${organization.name}`
		});
	}

	if (notesPlan !== null) {
		await writer.organizationNotes({ organizationId: organization.id, notes: notesPlan.next });

		changes.push({
			target: 'organization',
			subject: organization.name,
			field: 'Примечание',
			from: organization.notes,
			to: notesPlan.next
		});
		// Снимок идёт дальше с новым примечанием: вторая строка про тот же вуз с
		// тем же комментарием обязана ответить «без изменений».
		organization.notes = notesPlan.next;
	}

	return {
		rowNo: row.rowNo,
		action: catalogRowAction({ issues, creations, changes }),
		issues,
		creations,
		changes,
		organizationId: organization.id,
		productId: product.id,
		contractId: contract?.id ?? null,
		contractItemId: contractItem?.id ?? null
	};
}

/* -------------------------------------------------------------- сервисы */

function invalid(message: string, error: { issues: { message: string }[] }): ValidationError {
	return new ValidationError(
		message,
		error.issues.map((issue) => issue.message)
	);
}

function documentTitle(fileName: string): string {
	const name = fileName.trim();

	return (name === '' ? 'Каталог' : name).slice(0, MAX_DOCUMENT_TITLE);
}

/** Импорт, который ещё можно править: применённый и отклонённый — уже нет. */
function assertEditable(status: string): void {
	if (status === 'confirmed') {
		throw new ConflictError('Импорт уже применён: чтобы поправить каталог, загрузите новый файл');
	}

	if (status === 'rejected') {
		throw new ConflictError('Импорт отклонён: загрузите файл заново');
	}
}

function toCatalogImportView(row: typeof directoryImports.$inferSelect): CatalogImportView {
	return {
		id: row.id,
		status: row.status,
		fileDocumentId: row.fileDocumentId,
		mapping: row.mapping,
		rowCount: row.rowCount,
		createCount: row.createCount,
		updateCount: row.updateCount,
		unchangedCount: row.unchangedCount,
		errorCount: row.errorCount,
		note: row.note,
		createdBy: row.createdBy,
		createdAt: row.createdAt,
		confirmedAt: row.confirmedAt,
		confirmedBy: row.confirmedBy
	};
}

/**
 * Условие «эта загрузка видна вызывающему». Коррелирует со столбцами
 * `directory_imports`, поэтому годится только для выборок оттуда.
 *
 * Видимость — «или» из двух слагаемых, как у взаимодействия
 * (`interactions/access.ts`):
 *
 * 1. **автор загрузки** в области. Свою загрузку человек ведёт от файла до
 *    применения, и руководитель видит загрузки своих — иначе разбирать вопрос
 *    «что эта таблица сделала со справочником» было бы не с кем;
 * 2. **хотя бы одна затронутая организация** в области. Ссылки на записи
 *    справочника проставляет подтверждение, поэтому у неприменённой загрузки
 *    затронутых организаций нет вовсе: пока файл не применён, его видит только
 *    автор (и полный доступ).
 *
 * Загрузка вне области отвечает «не найдено», а не отказом: иначе перебором
 * идентификаторов видно, что существует за её пределами.
 */
function importScopeFilter(ctx: ActorContext): SQL {
	if (ctx.scope.kind === 'all') {
		return sql`true`;
	}

	return sql`(${actorScopeFilter(ctx, directoryImports.createdBy)} or ${exists(
		getDb()
			.select({ one: sql`1` })
			.from(directoryImportRows)
			.where(
				and(
					eq(directoryImportRows.importId, directoryImports.id),
					isNotNull(directoryImportRows.organizationId),
					scopeFilter(ctx, directoryImportRows.organizationId)
				)
			)
	)})`;
}

/**
 * Видны ли вызывающему строки файла как есть.
 *
 * Разобранные значения строки — это справочник: вуз, продукт, договор, сроки.
 * `raw` — это сам файл рабочей таблицы заказчика: там и колонки, которые никуда
 * не сопоставили вовсе, и свободный текст с ФИО, телефонами и перепиской
 * (`docs/directory.md`, «Допущения S4.1a»). Перенесённое из него видно по своим
 * правилам — контакт по правилам людей, назначение по карточке вуза, — а сама
 * ячейка остаётся у того, кто файл принёс, и у полного доступа: руководитель
 * вуза из файла видит, что загрузка сделала со справочником, но не соседнюю
 * колонку с чужой перепиской.
 */
function canReadImportRaw(ctx: ActorContext, row: { createdBy: string | null }): boolean {
	return (
		ctx.scope.kind === 'all' || (row.createdBy !== null && row.createdBy === (ctx.user?.id ?? null))
	);
}

/** Отказ в строках файла: он идёт только тем, кто саму загрузку уже видит. */
function rawDenied(): ForbiddenError {
	return new ForbiddenError(
		'Строки файла видны только тому, кто его загрузил: в них есть колонки, которые импорт в справочник не переносит'
	);
}

async function selectImportRow(
	ctx: ActorContext,
	id: string
): Promise<typeof directoryImports.$inferSelect> {
	const [row] = await getDb()
		.select()
		.from(directoryImports)
		.where(and(eq(directoryImports.id, id), importScopeFilter(ctx)))
		.limit(1);

	if (row === undefined) {
		throw new NotFoundError('Импорт каталога не найден');
	}

	return row;
}

/** Таблица файла импорта из хранилища документов. */
async function readImportTable(
	row: typeof directoryImports.$inferSelect,
	limit?: number
): Promise<StatTable> {
	if (row.fileDocumentId === null) {
		throw new NotFoundError('У импорта нет файла');
	}

	const [file] = await getDb()
		.select({ filePath: documents.filePath, title: documents.title })
		.from(documents)
		.where(eq(documents.id, row.fileDocumentId))
		.limit(1);

	if (file === undefined) {
		throw new NotFoundError('Файл импорта не найден');
	}

	// Формат читается из самого файла, а не из его типа в хранилище: и CSV, и
	// JSON лежат там обычным текстом.
	return readStatTable(file.title, await readStoredFile(file.filePath), limit);
}

export type CreateCatalogImportCommand = {
	note?: string | null;
	file: { name: string; bytes: Uint8Array };
};

export async function createCatalogImport(
	ctx: ActorContext,
	input: CreateCatalogImportCommand
): Promise<CatalogImportView> {
	await requirePermission(ctx, 'directory.import', { type: 'directory.import_created' });

	const parsed = createCatalogImportSchema.safeParse({ note: input.note ?? null });

	if (!parsed.success) {
		throw invalid('Загрузка не прошла проверку', parsed.error);
	}

	// Файл разбирается до записи в хранилище: принять и сохранить то, в чём нет
	// ни одной строки, значит отложить отказ на шаг вперёд.
	const table = readStatTable(input.file.name, input.file.bytes, CATALOG_PREVIEW_PARSE_LIMIT);
	const staged = await stageBlob(input.file.bytes, statFileMime(table.file.format));

	try {
		return await withTransaction(ctx, async (tx) => {
			await promoteBlob(staged);

			const [file] = await tx
				.insert(documents)
				.values({
					interactionId: null,
					kind: CATALOG_FILE_DOCUMENT_KIND,
					title: documentTitle(input.file.name),
					filePath: staged.relativePath,
					mime: staged.mime,
					sizeBytes: staged.sizeBytes,
					sha256: staged.sha256,
					uploadedBy: ctx.user?.id ?? null
				})
				.returning();

			const [row] = await tx
				.insert(directoryImports)
				.values({
					status: 'uploading',
					fileDocumentId: file.id,
					note: parsed.data.note,
					createdBy: ctx.user?.id ?? null
				})
				.returning();

			await recordAuditEvent(
				ctx,
				{
					type: 'directory.import_created',
					outcome: 'success',
					subject: { type: 'directory_import', id: row.id },
					details: { documentId: file.id }
				},
				tx
			);

			return toCatalogImportView(row);
		});
	} catch (error) {
		await discardStaged([staged], error);
		throw error;
	}
}

function toRowValues(
	source: CatalogSourceRow
): Omit<typeof directoryImportRows.$inferInsert, 'importId'> {
	return {
		rowNo: source.rowNo,
		origin: source.origin,
		organizationName: source.values.organizationName,
		organizationInn: source.values.organizationInn,
		vendorName: source.values.vendorName,
		productName: source.values.productName,
		productCode: source.values.productCode,
		directionName: source.values.directionName,
		contractNumber: source.values.contractNumber,
		contractSignedOn: source.values.contractSignedOn,
		contractValidUntil: source.values.contractValidUntil,
		licenseSignedAt: source.values.licenseSignedAt,
		licenseUntil: source.values.licenseUntil,
		transferStatus: source.values.transferStatus,
		raw: source.raw
	};
}

/**
 * Применяет сопоставление колонок и считает предпросмотр.
 *
 * Строки импорта переписываются целиком: сопоставление можно поменять и
 * применить заново, и остаток прежнего разбора рядом с новым был бы вторым
 * ответом на тот же вопрос. Своего события журнала у шага нет: он ничего не
 * решает — предпросмотр пересчитывается сколько угодно раз, а решение это
 * следующий шаг.
 */
export async function applyCatalogMapping(
	ctx: ActorContext,
	importId: string,
	mapping: CatalogMapping
): Promise<CatalogImportView> {
	await requirePermission(ctx, 'directory.import', {
		type: 'directory.import_created',
		subject: { type: 'directory_import', id: importId }
	});

	const row = await selectImportRow(ctx, importId);
	assertEditable(row.status);

	const parsed = catalogMappingSchema.safeParse(mapping);

	if (!parsed.success) {
		throw invalid('Сопоставление колонок не прошло проверку', parsed.error);
	}

	const table = await readImportTable(row);
	const unknown = Object.keys(parsed.data).filter((column) => !table.headers.includes(column));

	if (unknown.length > 0) {
		throw new ValidationError('В файле нет таких колонок', [
			`Сопоставлены колонки, которых нет в шапке: ${unknown.join(', ')}`
		]);
	}

	const missing = missingRequiredFields(parsed.data);

	if (missing.length > 0) {
		throw new ValidationError('Сопоставлены не все обязательные поля', [
			`Без этих полей строку не к чему отнести: ${missing
				.map((field) => CATALOG_FIELD_LABELS[field])
				.join(', ')}`
		]);
	}

	const sourceRows = buildCatalogRows(table, parsed.data);
	const results = await applyCatalogRows(await loadCatalogState(ctx), dryWriter(), sourceRows);
	const counts = catalogImportCounts(results);

	return withTransaction(ctx, async (tx) => {
		await tx.delete(directoryImportRows).where(eq(directoryImportRows.importId, row.id));

		const values = sourceRows.map((source, index) => ({
			...toRowValues(source),
			importId: row.id,
			action: results[index].action,
			issues: results[index].issues,
			creations: results[index].creations,
			changes: results[index].changes
		}));

		for (let from = 0; from < values.length; from += INSERT_CHUNK) {
			await tx.insert(directoryImportRows).values(values.slice(from, from + INSERT_CHUNK));
		}

		const [updated] = await tx
			.update(directoryImports)
			.set({ mapping: parsed.data, status: 'mapped', ...counts, updatedAt: new Date() })
			.where(eq(directoryImports.id, row.id))
			.returning();

		return toCatalogImportView(updated);
	});
}

/**
 * Подтверждение загрузки состоялось: подбор из справочника, собранный раньше,
 * больше не показывать.
 *
 * Своя строка, а не только та, что стоит внутри `createOrganization`: записи
 * заводятся в транзакции этого подтверждения, и вложенный вызов обесценивает
 * кэш до её фиксации. Здесь — после.
 */
async function invalidated<TResult>(result: Promise<TResult>): Promise<TResult> {
	const value = await result;

	await invalidateDirectoryOptions();

	return value;
}

/**
 * Применяет импорт к справочнику.
 *
 * Всё идёт одной транзакцией: состояние каталога снимается внутри неё, строки
 * применяются по порядку, и та же транзакция записывает, что с каждой строкой
 * вышло. Поэтому «применено наполовину» не бывает — ни при отказе базы, ни при
 * ошибке на середине файла.
 *
 * Строки, у которых претензия была уже на предпросмотре, не пересчитываются:
 * их претензия — про сам файл (неразобранная дата, сдвиг колонок, противоречие
 * между двойниками), и справочник на неё не влияет. Остальные считаются заново
 * по свежему состоянию: между предпросмотром и подтверждением справочник могли
 * изменить, и записаться должно то, что верно сейчас.
 */
export async function confirmCatalogImport(
	ctx: ActorContext,
	importId: string
): Promise<CatalogImportView> {
	await requirePermission(ctx, 'directory.import', {
		type: 'directory.import_confirmed',
		subject: { type: 'directory_import', id: importId }
	});

	await selectImportRow(ctx, importId);

	return invalidated(
		withTransaction(ctx, async (tx) => {
			// Состояние перечитывается под блокировкой строки: между проверкой и
			// записью импорт мог применить кто-то другой.
			const [row] = await tx
				.select()
				.from(directoryImports)
				.where(eq(directoryImports.id, importId))
				.for('update');

			if (row === undefined) {
				throw new ConflictError('Импорт каталога больше не существует');
			}

			assertEditable(row.status);

			if (row.status !== 'mapped') {
				throw new ConflictError('Импорт ещё не разобран: сначала сопоставьте колонки файла');
			}

			const stored = await tx
				.select()
				.from(directoryImportRows)
				.where(eq(directoryImportRows.importId, row.id))
				.orderBy(directoryImportRows.rowNo);

			if (stored.length === 0) {
				throw new ConflictError('Применять нечего: в файле нет ни одной строки');
			}

			const pending = stored.filter((item) => item.action !== 'error');
			const sourceRows: CatalogSourceRow[] = pending.map((item) => ({
				rowNo: item.rowNo,
				origin: item.origin,
				raw: item.raw,
				// Менеджер, контакты и комментарий читаются из сохранённой строки
				// файла по сохранённому сопоставлению: своих колонок у них нет, а
				// файл между предпросмотром и подтверждением не перечитывается.
				extra: extraFromRaw(item.raw, row.mapping),
				issues: [],
				values: {
					organizationName: item.organizationName,
					organizationInn: item.organizationInn,
					vendorName: item.vendorName,
					productName: item.productName,
					productCode: item.productCode,
					directionName: item.directionName,
					contractNumber: item.contractNumber,
					contractSignedOn: item.contractSignedOn,
					contractValidUntil: item.contractValidUntil,
					licenseSignedAt: item.licenseSignedAt,
					licenseUntil: item.licenseUntil,
					transferStatus: item.transferStatus
				}
			}));

			// Область сбора следа просмотра: заведение контакта возвращает его
			// карточку, и каждый такой возврат — обращение к персональным данным.
			// Одна область на всю загрузку вместо события на каждого человека.
			const state = await loadCatalogState(ctx, tx);
			const results = await withPiiTrace(
				ctx,
				() => applyCatalogRows(state, databaseWriter(ctx, tx), sourceRows),
				tx
			);

			const byRowNo = new Map(results.map((result) => [result.rowNo, result]));

			for (const result of results) {
				await tx
					.update(directoryImportRows)
					.set({
						action: result.action,
						issues: result.issues,
						creations: result.creations,
						changes: result.changes,
						organizationId: result.organizationId,
						productId: result.productId,
						contractId: result.contractId,
						contractItemId: result.contractItemId,
						updatedAt: new Date()
					})
					.where(
						and(
							eq(directoryImportRows.importId, row.id),
							eq(directoryImportRows.rowNo, result.rowNo)
						)
					);
			}

			const counts = catalogImportCounts(
				stored.map((item) => ({ action: byRowNo.get(item.rowNo)?.action ?? item.action }))
			);

			const [updated] = await tx
				.update(directoryImports)
				.set({
					status: 'confirmed',
					confirmedAt: new Date(),
					confirmedBy: ctx.user?.id ?? null,
					...counts,
					updatedAt: new Date()
				})
				.where(eq(directoryImports.id, row.id))
				.returning();

			await recordAuditEvent(
				ctx,
				{
					type: 'directory.import_confirmed',
					outcome: 'success',
					subject: { type: 'directory_import', id: row.id },
					details: counts
				},
				tx
			);

			return toCatalogImportView(updated);
		})
	);
}

export async function rejectCatalogImport(
	ctx: ActorContext,
	importId: string,
	reason: string
): Promise<CatalogImportView> {
	await requirePermission(ctx, 'directory.import', {
		type: 'directory.import_rejected',
		subject: { type: 'directory_import', id: importId }
	});

	const parsed = rejectCatalogImportSchema.safeParse({ reason });

	if (!parsed.success) {
		throw invalid('Импорт не отклонён', parsed.error);
	}

	const explanation = parsed.data.reason;
	const row = await selectImportRow(ctx, importId);

	assertEditable(row.status);

	return withTransaction(ctx, async (tx) => {
		const [updated] = await tx
			.update(directoryImports)
			.set({ status: 'rejected', note: explanation, updatedAt: new Date() })
			.where(eq(directoryImports.id, row.id))
			.returning();

		const [counted] = await tx
			.select({ value: count() })
			.from(directoryImportRows)
			.where(eq(directoryImportRows.importId, row.id));

		await recordAuditEvent(
			ctx,
			{
				type: 'directory.import_rejected',
				outcome: 'success',
				subject: { type: 'directory_import', id: row.id },
				details: { rowCount: counted?.value ?? 0 }
			},
			tx
		);

		return toCatalogImportView(updated);
	});
}

/* ----------------------------------------------------------------- чтение */

/** Что видит шаг сопоставления: шапка файла, первые строки и предложение. */
export type CatalogImportPreview = {
	file: StatFileSummary;
	headers: string[];
	/** Первые строки файла: колонка → значение. */
	sample: Record<string, string>[];
	/** Предложенное сопоставление: колонка → поле. */
	advice: CatalogMapping;
	/** Уже применённое сопоставление; пусто, пока шаг не проходили. */
	mapping: CatalogMapping;
	totalRows: number;
	warnings: string[];
};

function toImportListItem(
	row: typeof directoryImports.$inferSelect,
	authorName: string | null,
	fileName: string | null
): CatalogImportListItem {
	return { ...toCatalogImportView(row), authorName, fileName };
}

const IMPORT_LIST_COLUMNS = {
	row: directoryImports,
	authorName: users.fullName,
	fileName: documents.title
} as const;

/**
 * Последние импорты каталога.
 *
 * Список короткий и без фильтров намеренно: у импорта нет своего раздела, он
 * живёт кнопкой на справочнике организаций. Отвечает этот список на один
 * вопрос — «где та загрузка, которую я не довёл до конца», — и длинного списка
 * для этого не нужно.
 *
 * Область применяется целой загрузкой, а не строками: счётчики описывают файл
 * целиком, и урезать их до своих вузов значило бы показать неверные числа.
 * Поэтому загрузка либо видна, либо нет — `importScopeFilter`.
 */
export async function listCatalogImports(
	ctx: ActorContext,
	limit = 10
): Promise<CatalogImportListItem[]> {
	requirePermission(ctx, 'directory.import');

	const rows = await getDb()
		.select(IMPORT_LIST_COLUMNS)
		.from(directoryImports)
		.leftJoin(users, eq(users.id, directoryImports.createdBy))
		.leftJoin(documents, eq(documents.id, directoryImports.fileDocumentId))
		.where(importScopeFilter(ctx))
		.orderBy(desc(directoryImports.createdAt))
		.limit(limit);

	return rows.map((row) => toImportListItem(row.row, row.authorName, row.fileName));
}

export async function getCatalogImport(
	ctx: ActorContext,
	id: string
): Promise<CatalogImportListItem> {
	requirePermission(ctx, 'directory.import');

	if (!importIdSchema.safeParse(id).success) {
		throw new NotFoundError('Импорт каталога не найден');
	}

	const [row] = await getDb()
		.select(IMPORT_LIST_COLUMNS)
		.from(directoryImports)
		.leftJoin(users, eq(users.id, directoryImports.createdBy))
		.leftJoin(documents, eq(documents.id, directoryImports.fileDocumentId))
		.where(and(eq(directoryImports.id, id), importScopeFilter(ctx)))
		.limit(1);

	if (row === undefined) {
		throw new NotFoundError('Импорт каталога не найден');
	}

	return toImportListItem(row.row, row.authorName, row.fileName);
}

export async function getCatalogImportPreview(
	ctx: ActorContext,
	id: string
): Promise<CatalogImportPreview> {
	requirePermission(ctx, 'directory.import');

	const row = await selectImportRow(ctx, id);

	// Предпросмотр показывает файл как есть — шапку и первые строки, — поэтому
	// он идёт по тому же правилу, что и `raw`, а не по видимости загрузки.
	if (!canReadImportRaw(ctx, row)) {
		throw rawDenied();
	}

	const table = await readImportTable(row, CATALOG_PREVIEW_PARSE_LIMIT);

	return {
		file: table.file,
		headers: table.headers,
		sample: table.rows.map((source) =>
			Object.fromEntries(
				table.headers.map((header, column) => [header, source.cells[column] ?? ''])
			)
		),
		advice: suggestCatalogMapping(table.headers),
		mapping: row.mapping,
		totalRows: table.totalRows,
		warnings: table.warnings
	};
}

function toImportRowView(
	row: typeof directoryImportRows.$inferSelect,
	withRaw: boolean
): CatalogImportRowView {
	return {
		id: row.id,
		rowNo: row.rowNo,
		origin: row.origin,
		action: row.action,
		issues: row.issues,
		creations: row.creations,
		changes: row.changes,
		organizationName: row.organizationName,
		organizationInn: row.organizationInn,
		vendorName: row.vendorName,
		productName: row.productName,
		productCode: row.productCode,
		directionName: row.directionName,
		contractNumber: row.contractNumber,
		contractSignedOn: row.contractSignedOn,
		contractValidUntil: row.contractValidUntil,
		licenseSignedAt: row.licenseSignedAt,
		licenseUntil: row.licenseUntil,
		transferStatus: row.transferStatus,
		organizationId: row.organizationId,
		productId: row.productId,
		contractId: row.contractId,
		contractItemId: row.contractItemId,
		raw: withRaw ? row.raw : null
	};
}

/**
 * Строки импорта: страница предпросмотра и карточки результата.
 *
 * Разобранные значения строки видит каждый, кому видна сама загрузка; строка
 * файла как есть (`raw`) — только тот, кто файл принёс (`canReadImportRaw`).
 */
export async function listCatalogImportRows(
	ctx: ActorContext,
	importId: string,
	options: { action: CatalogRowAction | null; page: number; pageSize: number }
): Promise<PageResult<CatalogImportRowView>> {
	requirePermission(ctx, 'directory.import');

	const record = await selectImportRow(ctx, importId);
	const withRaw = canReadImportRaw(ctx, record);

	const where =
		options.action === null
			? eq(directoryImportRows.importId, importId)
			: and(
					eq(directoryImportRows.importId, importId),
					eq(directoryImportRows.action, options.action)
				);

	const db = getDb();

	const [items, [total]] = await Promise.all([
		db
			.select()
			.from(directoryImportRows)
			.where(where)
			.orderBy(directoryImportRows.rowNo)
			.limit(options.pageSize)
			.offset((options.page - 1) * options.pageSize),
		db.select({ value: count() }).from(directoryImportRows).where(where)
	]);

	return {
		items: items.map((item) => toImportRowView(item, withRaw)),
		total: total?.value ?? 0,
		page: options.page,
		pageSize: options.pageSize
	};
}
