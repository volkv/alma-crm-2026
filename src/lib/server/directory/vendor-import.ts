/**
 * Импорт вендоров: компания-правообладатель, её продукты и контакт по ним.
 *
 * Файл заказчика устроен так: строка — «компания, продукт, ФИО, телефон, почта,
 * способ связи»; у одной компании несколько строк (разные продукты — разные
 * люди), в ячейке продукта бывает несколько продуктов (`«А», «Б»`), а способ
 * связи — список через запятую. Импорт раскладывает строку по справочнику:
 * компания — организация вида `vendor` (или уже заведённая, со своим видом),
 * продукты — записи каталога с этим вендором, человек — `people` с ролью в
 * компании, а «кто отвечает за продукт» — связь `product_contacts`.
 *
 * Мастер, исходный файл, предпросмотр, построчные ошибки, подтверждение и отказ
 * — общие с импортом каталога (`import.ts`), и правила у них те же: предпросмотр
 * и применение считает один проход с разными исполнителями записи, строка с
 * претензией ничего не пишет, пустая ячейка ничего не стирает, повтор того же
 * файла отвечает «без изменений».
 */
import { eq, inArray } from 'drizzle-orm';
import { createPersonSchema } from '$lib/contracts/directory';
import type { OrganizationKind } from '$lib/contracts/directory';
import {
	VENDOR_FIELDS,
	VENDOR_FIELD_LABELS,
	catalogRowAction,
	type CatalogCreation,
	type CatalogRowChange,
	type CatalogRowIssue,
	type ImportMapping,
	type VendorField,
	type VendorMapping
} from '$lib/contracts/directory-import';
import { isValidInn } from '$lib/validation/inn';
import type { ActorContext } from '../actor';
import { getDb } from '../db';
import { affiliations, organizations, people, productContacts, products } from '../db/schema';
import type { Tx } from '../db/transaction';
import { suggestFieldMapping, type FieldSynonyms } from '../spreadsheet/mapping';
import { normalizeName } from '../stats/lookup';
import { describeRowOrigin, type StatTable } from '../stats/parse';
import { contactFullName, parsePersonName, type ContactIdentity } from './contacts';
import {
	contactKeys,
	generateCode,
	insertImportedContact,
	insertImportedOrganization,
	insertImportedProduct,
	organizationNameKey,
	pickOne,
	storedContactKeys,
	textOf,
	type CatalogRowResult
} from './import';
import { linkProductContact, setAffiliationChannel, setProductVendor } from './write';

/**
 * Синонимы колонок. Начало каждого списка — то, как колонки названы в файле
 * заказчика («Компания», «Продукт», «ФИО», «Телефон», «Почта», «Способ связи»),
 * дальше — как те же величины называют другие выгрузки.
 */
const SYNONYMS: FieldSynonyms<VendorField> = {
	company: [
		'компания',
		'название компании',
		'наименование компании',
		'вендор',
		'правообладатель',
		'производитель',
		'поставщик',
		'организация',
		'company',
		'vendor'
	],
	companyInn: ['инн', 'инн компании', 'инн вендора', 'inn', 'tax id'],
	products: [
		'продукт',
		'продукты',
		'по',
		'программное обеспечение',
		'наименование продукта',
		'product',
		'products'
	],
	contactName: ['фио', 'фио контакта', 'контактное лицо', 'контакт', 'full name', 'contact'],
	contactPhone: ['телефон', 'телефон контакта', 'номер телефона', 'phone'],
	contactEmail: ['почта', 'электронная почта', 'e mail', 'email', 'mail'],
	contactChannel: ['способ связи', 'канал связи', 'как связаться', 'channel']
};

/** Предложенное сопоставление колонок файла вендоров. */
export function suggestVendorMapping(headers: readonly string[]): VendorMapping {
	return suggestFieldMapping(headers, VENDOR_FIELDS, SYNONYMS);
}

/** Виды, среди которых компания файла ищется по названию. */
const COMPANY_KINDS: readonly OrganizationKind[] = [
	'vendor',
	'operator',
	'customer_company',
	'legal_entity'
];

/** Должность контакта вендора: файл её не называет. */
const VENDOR_CONTACT_POSITION = 'Контакт вендора (импорт вендоров)';

/** Сколько символов принимает способ связи в роли человека. */
const MAX_CHANNEL = 200;

/* ------------------------------------------------------------------ разбор */

/** Кавычки, которыми обёрнут продукт целиком: «…», „…“, “…”, "…". */
const WRAPPED = [/^«([^«»]*)»$/u, /^„([^„“]*)“$/u, /^“([^“”]*)”$/u, /^"([^"]*)"$/u];

/** Несколько продуктов в ёлочках без разделителя: `«А» «Б»`. */
const QUOTED_ONLY = /^(?:\s*«[^«»]*»\s*)+$/u;

function unwrap(item: string): string {
	const value = item.trim();
	const unquoted = WRAPPED.map((pattern) => pattern.exec(value)?.[1]).find(
		(found) => found !== undefined
	);

	return (unquoted ?? value).trim().replaceAll(/\s+/gu, ' ');
}

/**
 * Продукты из ячейки.
 *
 * `«RT.DataLake», «RT.Warehouse»` — два продукта, `Облачная среда «Верстак»` —
 * один: запятая и точка с запятой делят ячейку только вне ёлочек, поэтому
 * кавычки внутри названия его не рвут. Продукт, целиком взятый в кавычки, из
 * них вынимается; пробелы по краям обрезаются. Повторы внутри ячейки
 * схлопываются — по тому же правилу сравнения, по которому продукт ищется.
 */
export function splitProductCell(cell: string): string[] {
	const pieces: string[] = [];
	let depth = 0;
	let current = '';

	for (const char of cell) {
		if (char === '«') {
			depth += 1;
		} else if (char === '»') {
			depth = Math.max(0, depth - 1);
		}

		if (depth === 0 && (char === ',' || char === ';' || char === '\n')) {
			pieces.push(current);
			current = '';
			continue;
		}

		current += char;
	}

	pieces.push(current);

	const items = pieces.flatMap((piece) =>
		QUOTED_ONLY.test(piece) ? [...piece.matchAll(/«([^«»]*)»/gu)].map((match) => match[1]) : [piece]
	);

	const seen = new Set<string>();
	const result: string[] = [];

	for (const item of items.map(unwrap)) {
		const key = normalizeName(item);

		if (key === '' || seen.has(key)) {
			continue;
		}

		seen.add(key);
		result.push(item);
	}

	return result;
}

/**
 * Способ связи в том виде, в каком он ляжет в роль человека: значения через
 * «, », пробелы схлопнуты, порядок исходный, повторы (без учёта регистра)
 * убраны. `null` — в ячейке ничего нет.
 */
export function normalizeChannels(cell: string | null): string | null {
	if (cell === null) {
		return null;
	}

	const seen = new Set<string>();
	const values: string[] = [];

	for (const piece of cell.split(/[,;\n]/u)) {
		const value = piece.trim().replaceAll(/\s+/gu, ' ');
		const key = value.toLocaleLowerCase('ru');

		if (value === '' || seen.has(key)) {
			continue;
		}

		seen.add(key);
		values.push(value);
	}

	return values.length === 0 ? null : values.join(', ');
}

/** Разобранные значения строки: то, что хранится в колонках строки загрузки. */
export type VendorRowValues = {
	companyName: string | null;
	companyInn: string | null;
	/** Ячейка продуктов как есть: делится на продукты при применении. */
	productsText: string | null;
};

/**
 * Контакт строки. Своих колонок в `directory_import_rows` у него нет — как и у
 * контактов каталога, он читается из сохранённой строки файла по сохранённому
 * сопоставлению: ФИО и телефоны не попадают в построчный ответ загрузки.
 */
export type VendorRowContact = {
	name: string | null;
	phone: string | null;
	email: string | null;
	channel: string | null;
};

export type VendorSourceRow = {
	rowNo: number;
	origin: number;
	raw: Record<string, string>;
	values: VendorRowValues;
	contact: VendorRowContact;
	issues: CatalogRowIssue[];
};

/** Контакт строки из сохранённой строки файла: и разбор, и подтверждение читают его так. */
export function vendorContactFromRaw(
	raw: Record<string, string>,
	mapping: ImportMapping
): VendorRowContact {
	return {
		name: textOf(raw, mapping, 'contactName'),
		phone: textOf(raw, mapping, 'contactPhone'),
		email: textOf(raw, mapping, 'contactEmail'),
		channel: textOf(raw, mapping, 'contactChannel')
	};
}

/** Разбирает таблицу файла в строки вендоров. Чистая функция. */
export function buildVendorRows(table: StatTable, mapping: VendorMapping): VendorSourceRow[] {
	return table.rows.map((row, position) => {
		const issues: CatalogRowIssue[] = [];
		const raw: Record<string, string> = {};

		table.headers.forEach((header, column) => {
			raw[header] = row.cells[column] ?? '';
		});

		// Лишние ячейки — сдвиг колонок: без претензии значения поедут не в те поля.
		const extra = row.cells.slice(table.headers.length).filter((cell) => cell !== '');

		if (extra.length > 0) {
			issues.push({
				field: null,
				message: `${describeRowOrigin(table.file, row.origin)} файла: ${extra.length} значений сверх колонок шапки — проверьте разделители`
			});
		}

		return {
			rowNo: position + 1,
			origin: row.origin,
			raw,
			values: {
				companyName: textOf(raw, mapping, 'company'),
				companyInn: textOf(raw, mapping, 'companyInn'),
				productsText: textOf(raw, mapping, 'products')
			},
			contact: vendorContactFromRaw(raw, mapping),
			issues
		};
	});
}

/** Строка загрузки, какой её сохранил предпросмотр, — снова строка для применения. */
export function vendorRowFromStored(
	stored: {
		rowNo: number;
		origin: number;
		raw: Record<string, string>;
		organizationName: string | null;
		organizationInn: string | null;
		productName: string | null;
	},
	mapping: ImportMapping
): VendorSourceRow {
	return {
		rowNo: stored.rowNo,
		origin: stored.origin,
		raw: stored.raw,
		values: {
			companyName: stored.organizationName,
			companyInn: stored.organizationInn,
			productsText: stored.productName
		},
		contact: vendorContactFromRaw(stored.raw, mapping),
		issues: []
	};
}

/** Колонки строки загрузки, в которые ложатся значения строки вендоров. */
export function vendorStoredValues(row: VendorSourceRow): {
	organizationName: string | null;
	organizationInn: string | null;
	productName: string | null;
} {
	return {
		organizationName: row.values.companyName,
		organizationInn: row.values.companyInn,
		productName: row.values.productsText
	};
}

/* ----------------------------------------------------- состояние справочника */

export type CompanyEntry = {
	id: string;
	name: string;
	inn: string | null;
	kind: OrganizationKind;
};

export type VendorProductEntry = {
	id: string;
	name: string;
	/** Правообладатель продукта; `null` — не указан. */
	vendorId: string | null;
};

/** Человек, уже заведённый у компании, и его роль в ней. */
export type KnownContact = {
	personId: string;
	affiliationId: string;
	fullName: string;
	channel: string | null;
};

/**
 * Справочник в память — тот же приём и та же цена, что у каталога: снимок
 * снимается один раз, поэтому применение идёт одной транзакцией.
 */
export type VendorState = {
	/** Организации по ИНН — все, какого бы вида ни были: ИНН уникален по базе. */
	companyByInn: Map<string, CompanyEntry>;
	/** Организации по названию — только виды, среди которых ищется компания. */
	companyByName: Map<string, CompanyEntry[]>;
	/** Названия организаций: чей продукт — говорят словами. */
	organizationNames: Map<string, string>;
	productByCode: Map<string, VendorProductEntry>;
	productByName: Map<string, VendorProductEntry[]>;
	productCodes: Set<string>;
	/** Люди компаний: `${организация} ${ключ}` — ФИО, почта или телефон. */
	contacts: Map<string, KnownContact[]>;
	/** Связи «продукт — контакт»: `${продукт} ${человек}`. */
	productContacts: Set<string>;
};

const contactIndexKey = (organizationId: string, key: string): string => `${organizationId} ${key}`;

const productContactKey = (productId: string, personId: string): string =>
	`${productId} ${personId}`;

function pushKeyed<TEntry>(index: Map<string, TEntry[]>, key: string, entry: TEntry): void {
	if (key === '') {
		return;
	}

	const found = index.get(key) ?? [];

	if (!found.includes(entry)) {
		index.set(key, [...found, entry]);
	}
}

export function emptyVendorState(): VendorState {
	return {
		companyByInn: new Map(),
		companyByName: new Map(),
		organizationNames: new Map(),
		productByCode: new Map(),
		productByName: new Map(),
		productCodes: new Set(),
		contacts: new Map(),
		productContacts: new Set()
	};
}

/** Кладёт организацию в снимок: по ИНН всегда, по названиям — если она может быть компанией. */
export function registerCompany(
	state: VendorState,
	entry: CompanyEntry,
	names: readonly string[]
): void {
	state.organizationNames.set(entry.id, entry.name);

	if (entry.inn !== null) {
		state.companyByInn.set(entry.inn, entry);
	}

	if (COMPANY_KINDS.includes(entry.kind)) {
		for (const name of names) {
			pushKeyed(state.companyByName, organizationNameKey(name), entry);
		}
	}
}

export function registerVendorProduct(
	state: VendorState,
	entry: VendorProductEntry,
	code: string
): void {
	state.productCodes.add(code);
	state.productByCode.set(normalizeName(code), entry);
	pushKeyed(state.productByName, normalizeName(entry.name), entry);
}

/** Кладёт человека компании в снимок под каждым его ключом. */
export function registerCompanyContact(
	state: VendorState,
	organizationId: string,
	keys: readonly string[],
	contact: KnownContact
): void {
	for (const key of keys) {
		pushKeyed(state.contacts, contactIndexKey(organizationId, key), contact);
	}
}

export function registerProductContact(
	state: VendorState,
	productId: string,
	personId: string
): void {
	state.productContacts.add(productContactKey(productId, personId));
}

/**
 * Снимает справочник целиком, без области: загрузка вендоров открыта только
 * полному доступу (`import.ts`), и ИНН уникален по всей базе — загрузка, не
 * увидевшая чужую компанию, завела бы её второй.
 */
export async function loadVendorState(
	executor: Tx | ReturnType<typeof getDb> = getDb()
): Promise<VendorState> {
	const state = emptyVendorState();

	const [organizationRows, productRows, linkRows, contactRows] = await Promise.all([
		executor
			.select({
				id: organizations.id,
				kind: organizations.kind,
				inn: organizations.inn,
				shortName: organizations.shortName,
				legalName: organizations.legalName
			})
			.from(organizations),
		executor
			.select({
				id: products.id,
				code: products.code,
				name: products.name,
				vendorId: products.vendorOrganizationId
			})
			.from(products),
		executor
			.select({ productId: productContacts.productId, personId: productContacts.personId })
			.from(productContacts),
		// Люди читаются ключами сравнения, а не значениями: расшифровывать
		// справочник ради дедупликации незачем. Действующие роли идут первыми —
		// у человека с закрытой и открытой ролью в одной компании способ связи
		// ведётся в открытой.
		executor
			.select({
				affiliationId: affiliations.id,
				organizationId: affiliations.organizationId,
				personId: people.id,
				lastName: people.lastName,
				firstName: people.firstName,
				middleName: people.middleName,
				emailHash: people.emailHash,
				phoneHash: people.phoneHash,
				channel: affiliations.channel,
				validTo: affiliations.validTo
			})
			.from(affiliations)
			.innerJoin(people, eq(people.id, affiliations.personId))
			.innerJoin(organizations, eq(organizations.id, affiliations.organizationId))
			.where(inArray(organizations.kind, [...COMPANY_KINDS]))
	]);

	for (const row of organizationRows) {
		registerCompany(state, { id: row.id, name: row.shortName, inn: row.inn, kind: row.kind }, [
			row.shortName,
			row.legalName
		]);
	}

	for (const row of productRows) {
		registerVendorProduct(state, { id: row.id, name: row.name, vendorId: row.vendorId }, row.code);
	}

	for (const row of linkRows) {
		registerProductContact(state, row.productId, row.personId);
	}

	const ordered = [...contactRows].sort(
		(left, right) => Number(left.validTo !== null) - Number(right.validTo !== null)
	);
	const byPerson = new Map<string, KnownContact>();

	for (const row of ordered) {
		const personKey = `${row.organizationId} ${row.personId}`;
		// Одна запись на человека в компании: вторая, закрытая, роль ключей не добавляет.
		const contact = byPerson.get(personKey) ?? {
			personId: row.personId,
			affiliationId: row.affiliationId,
			fullName: contactFullName(row),
			channel: row.channel
		};

		byPerson.set(personKey, contact);
		registerCompanyContact(
			state,
			row.organizationId,
			storedContactKeys(row, row.emailHash, row.phoneHash),
			contact
		);
	}

	return state;
}

/* --------------------------------------------------------- исполнитель записи */

/** Контакт, которого у компании ещё нет: имя, почта, телефон и должность. */
export type NewVendorContact = ContactIdentity & { position: string };

/**
 * Кто выполняет записи строки: предпросмотру достаётся исполнитель, который
 * ничего не пишет, подтверждению — тот, что пишет через сервисы справочника.
 */
export type VendorWriter = {
	organization(input: { name: string; inn: string | null }): Promise<string>;
	product(input: { code: string; name: string; vendorOrganizationId: string }): Promise<string>;
	setProductVendor(productId: string, vendorOrganizationId: string): Promise<void>;
	contact(input: {
		organizationId: string;
		contact: NewVendorContact;
		channel: string | null;
	}): Promise<{ personId: string; affiliationId: string }>;
	updateChannel(affiliationId: string, channel: string): Promise<void>;
	linkProductContact(productId: string, personId: string): Promise<void>;
};

/** Исполнитель предпросмотра: ничего не пишет, идентификаторы временные. */
export function dryVendorWriter(): VendorWriter {
	let counter = 0;
	const nextId = (): string => {
		counter += 1;

		return `pending-${counter}`;
	};

	return {
		organization: async () => nextId(),
		product: async () => nextId(),
		setProductVendor: async () => {},
		contact: async () => ({ personId: nextId(), affiliationId: nextId() }),
		updateChannel: async () => {},
		linkProductContact: async () => {}
	};
}

/** Исполнитель подтверждения: у каждой записи свой сервис, своё право и своё событие журнала. */
export function databaseVendorWriter(ctx: ActorContext, tx: Tx): VendorWriter {
	return {
		organization: async (input) =>
			insertImportedOrganization(ctx, tx, { ...input, kind: 'vendor' }),
		product: async (input) => insertImportedProduct(ctx, tx, input),
		setProductVendor: async (productId, vendorOrganizationId) =>
			setProductVendor(ctx, { productId, vendorOrganizationId }, tx),
		contact: async (input) =>
			insertImportedContact(ctx, tx, { ...input, roleKind: 'vendor_contact' }),
		updateChannel: async (affiliationId, channel) =>
			setAffiliationChannel(ctx, { affiliationId, channel }, tx),
		linkProductContact: async (productId, personId) =>
			linkProductContact(ctx, { productId, personId }, tx)
	};
}

/* --------------------------------------------------------------- применение */

/** Ключ контакта внутри файла: компания и ФИО. */
function fileContactKey(row: VendorSourceRow): string | null {
	if (row.contact.name === null) {
		return null;
	}

	const company = row.values.companyInn ?? organizationNameKey(row.values.companyName ?? '');

	return `${company}|${normalizeName(row.contact.name)}`;
}

/**
 * Один и тот же человек компании в двух строках файла с разным способом связи.
 * Выбрать одну строку значило бы выбрать наугад, а применить обе — записать
 * второй способ поверх первого: претензию получают обе строки.
 */
function markConflictingChannels(rows: readonly VendorSourceRow[]): void {
	const groups = new Map<string, VendorSourceRow[]>();

	for (const row of rows) {
		const key = fileContactKey(row);

		if (key !== null) {
			groups.set(key, [...(groups.get(key) ?? []), row]);
		}
	}

	for (const group of groups.values()) {
		const stated = new Set(
			group
				.map((row) => normalizeChannels(row.contact.channel))
				.filter((value): value is string => value !== null)
		);

		if (stated.size < 2) {
			continue;
		}

		for (const row of group) {
			const others = group.filter((other) => other !== row).map((other) => other.rowNo);

			row.issues.push({
				field: 'contactChannel',
				message: `Строки ${others.join(', ')} называют у того же контакта другой способ связи`
			});
		}
	}
}

/**
 * Разбирает и применяет строки вендоров. Один проход на предпросмотр и на
 * подтверждение; снимок по ходу обновляется, поэтому вторая строка про ту же
 * компанию видит её уже заведённой.
 */
export async function applyVendorRows(
	state: VendorState,
	writer: VendorWriter,
	rows: readonly VendorSourceRow[]
): Promise<CatalogRowResult[]> {
	markConflictingChannels(rows);

	const results: CatalogRowResult[] = [];

	for (const row of rows) {
		results.push(await applyVendorRow(state, writer, row));
	}

	return results;
}

/** Что строка сделает с продуктом. */
type ProductPlan =
	| { kind: 'create'; name: string }
	| { kind: 'setVendor'; entry: VendorProductEntry }
	| { kind: 'keep'; entry: VendorProductEntry };

/** Что строка сделает с контактом. */
type ContactPlan =
	| { kind: 'create'; contact: NewVendorContact; channel: string | null }
	| { kind: 'known'; entry: KnownContact; channel: string | null }
	| null;

/** Компания строки: найденная запись, `null` — её заведёт строка. */
function planCompany(
	state: VendorState,
	values: VendorRowValues,
	issues: CatalogRowIssue[]
): CompanyEntry | null {
	const { companyName, companyInn } = values;

	if (companyInn !== null && !isValidInn(companyInn)) {
		issues.push({
			field: 'companyInn',
			message: `ИНН «${companyInn}» не проходит проверку контрольной суммы`
		});

		return null;
	}

	if (companyInn !== null) {
		const byInn = state.companyByInn.get(companyInn) ?? null;

		if (byInn !== null && !COMPANY_KINDS.includes(byInn.kind)) {
			issues.push({
				field: 'companyInn',
				message: `ИНН ${companyInn} принадлежит организации «${byInn.name}» другого вида: правообладателем ПО она быть не может`
			});

			return null;
		}

		if (byInn !== null) {
			return byInn;
		}
	}

	if (companyName === null) {
		issues.push({
			field: 'company',
			message:
				companyInn === null
					? `${VENDOR_FIELD_LABELS.company}: значение не заполнено`
					: `Компания с ИНН «${companyInn}» не найдена, а названия для новой записи в файле нет`
		});

		return null;
	}

	const byName = pickOne(state.companyByName.get(organizationNameKey(companyName)), companyName);

	if (byName.message !== null) {
		issues.push({ field: 'company', message: byName.message });

		return null;
	}

	// Та же компания под другим ИНН — два юридических лица под одним названием
	// либо опечатка в файле. Решает человек, а не загрузка.
	if (
		byName.entry !== null &&
		companyInn !== null &&
		byName.entry.inn !== null &&
		byName.entry.inn !== companyInn
	) {
		issues.push({
			field: 'companyInn',
			message: `Компания «${companyName}» заведена с ИНН ${byName.entry.inn}, а в файле указан ${companyInn}`
		});

		return null;
	}

	return byName.entry;
}

/**
 * Продукты строки и что с каждым будет. `newCompany` — название компании,
 * которой в справочнике не нашлось и которую строка заведёт: если её продукт
 * уже у другого вендора, дело почти всегда в названии компании, а не в продукте.
 */
function planProducts(
	state: VendorState,
	company: CompanyEntry | null,
	newCompany: string | null,
	productsText: string | null,
	issues: CatalogRowIssue[]
): ProductPlan[] {
	if (productsText === null) {
		return [];
	}

	const plans: ProductPlan[] = [];

	for (const name of splitProductCell(productsText)) {
		const key = normalizeName(name);
		const byCode = state.productByCode.get(key);
		const found =
			byCode === undefined
				? pickOne(state.productByName.get(key), name)
				: { entry: byCode, message: null };

		if (found.message !== null) {
			issues.push({ field: 'products', message: found.message });
			continue;
		}

		const entry = found.entry;

		if (entry === null) {
			plans.push({ kind: 'create', name });
		} else if (entry.vendorId === null) {
			plans.push({ kind: 'setVendor', entry });
		} else if (company !== null && entry.vendorId === company.id) {
			plans.push({ kind: 'keep', entry });
		} else {
			// Чужого правообладателя загрузка не заменяет: смена вендора у продукта
			// меняет смысл всех договоров по нему и решается на его карточке.
			const owner = state.organizationNames.get(entry.vendorId) ?? 'без названия';

			issues.push(
				newCompany === null
					? {
							field: 'products',
							message: `Продукт «${entry.name}» уже принадлежит вендору «${owner}»`
						}
					: {
							field: 'company',
							message: `Компания «${newCompany}» не найдена в справочнике, а продукт «${entry.name}» уже у вендора «${owner}» — проверьте название компании в файле или заведите компанию в справочнике`
						}
			);
		}
	}

	return plans;
}

/**
 * Контакт строки: новый человек, уже заведённый у компании или никакого.
 * Проверяется теми же схемами, что и форма человека, — иначе предпросмотр
 * обещал бы запись, которая потом уронила бы подтверждение.
 */
function planContact(
	state: VendorState,
	company: CompanyEntry | null,
	contact: VendorRowContact,
	issues: CatalogRowIssue[]
): ContactPlan {
	const channel = normalizeChannels(contact.channel);

	if (contact.name === null) {
		if (contact.phone !== null || contact.email !== null || channel !== null) {
			issues.push({
				field: 'contactName',
				message: `${VENDOR_FIELD_LABELS.contactName} не заполнено: телефон, почту и способ связи не к кому отнести`
			});
		}

		return null;
	}

	const name = parsePersonName(contact.name);

	if (name === null) {
		issues.push({
			field: 'contactName',
			message: `«${contact.name}» не похоже на ФИО: нужны фамилия и имя`
		});

		return null;
	}

	const person = createPersonSchema.safeParse({
		...name,
		email: contact.email,
		phone: contact.phone,
		notes: null
	});

	if (!person.success) {
		for (const problem of person.error.issues) {
			issues.push({
				field: problem.path[0] === 'phone' ? 'contactPhone' : 'contactEmail',
				message: `Контакт «${contactFullName(name)}»: ${problem.message}`
			});
		}

		return null;
	}

	if (channel !== null && channel.length > MAX_CHANNEL) {
		issues.push({
			field: 'contactChannel',
			message: `Способ связи не длиннее ${MAX_CHANNEL} символов`
		});

		return null;
	}

	const identity: ContactIdentity = { ...name, email: contact.email, phone: contact.phone };
	const known =
		company === null
			? []
			: [
					...new Set(
						contactKeys(identity).flatMap(
							(key) => state.contacts.get(contactIndexKey(company.id, key)) ?? []
						)
					)
				];
	const people = [...new Map(known.map((entry) => [entry.personId, entry])).values()];

	if (people.length > 1) {
		issues.push({
			field: 'contactName',
			message: `Под «${contactFullName(name)}» подходят несколько людей компании — по ФИО, почте и телефону это разные записи`
		});

		return null;
	}

	if (people.length === 1) {
		return { kind: 'known', entry: people[0], channel };
	}

	return {
		kind: 'create',
		contact: { ...identity, position: VENDOR_CONTACT_POSITION },
		channel
	};
}

async function applyVendorRow(
	state: VendorState,
	writer: VendorWriter,
	row: VendorSourceRow
): Promise<CatalogRowResult> {
	const issues: CatalogRowIssue[] = [...row.issues];
	const creations: CatalogCreation[] = [];
	const changes: CatalogRowChange[] = [];

	const issuesBeforeCompany = issues.length;
	let company = planCompany(state, row.values, issues);
	// Компания не нашлась, и претензии к ней нет — значит, строка её заведёт.
	const newCompany =
		company === null && issues.length === issuesBeforeCompany ? row.values.companyName : null;
	const productPlans = planProducts(state, company, newCompany, row.values.productsText, issues);
	const contactPlan = planContact(state, company, row.contact, issues);

	// Дальше идут записи, и до них доходит только строка без единой претензии.
	if (issues.length > 0) {
		return {
			rowNo: row.rowNo,
			action: 'error',
			issues,
			creations: [],
			changes: [],
			organizationId: null,
			productId: null,
			contractId: null,
			contractItemId: null
		};
	}

	if (company === null) {
		// Название здесь заведомо не пусто: иначе выше стояла бы претензия.
		const name = row.values.companyName as string;
		const inn = row.values.companyInn;
		const id = await writer.organization({ name, inn });

		company = { id, name, inn, kind: 'vendor' };
		registerCompany(state, company, [name]);
		creations.push({ target: 'vendor', subject: name });
	}

	const rowProducts: VendorProductEntry[] = [];

	for (const plan of productPlans) {
		if (plan.kind === 'create') {
			const code = generateCode(plan.name, state.productCodes);
			const id = await writer.product({
				code,
				name: plan.name,
				vendorOrganizationId: company.id
			});
			const entry = { id, name: plan.name, vendorId: company.id };

			registerVendorProduct(state, entry, code);
			rowProducts.push(entry);
			creations.push({ target: 'product', subject: `${plan.name} (${code})` });
		} else if (plan.kind === 'setVendor') {
			await writer.setProductVendor(plan.entry.id, company.id);
			// Снимок идёт дальше с вендором: вторая строка про тот же продукт
			// ответит «без изменений», а строка другой компании — претензией.
			plan.entry.vendorId = company.id;
			rowProducts.push(plan.entry);
			changes.push({
				target: 'product',
				subject: plan.entry.name,
				field: 'Вендор',
				from: null,
				to: company.name
			});
		} else {
			rowProducts.push(plan.entry);
		}
	}

	let contact: KnownContact | null = null;

	if (contactPlan !== null && contactPlan.kind === 'create') {
		const created = await writer.contact({
			organizationId: company.id,
			contact: contactPlan.contact,
			channel: contactPlan.channel
		});

		contact = {
			...created,
			fullName: contactFullName(contactPlan.contact),
			channel: contactPlan.channel
		};
		registerCompanyContact(state, company.id, contactKeys(contactPlan.contact), contact);
		creations.push({ target: 'vendorContact', subject: `${contact.fullName} · ${company.name}` });
	} else if (contactPlan !== null) {
		contact = contactPlan.entry;

		// Пустая ячейка ничего не стирает: способ связи меняется, только если
		// файл его называет и называет иначе.
		if (contactPlan.channel !== null && contactPlan.channel !== contact.channel) {
			await writer.updateChannel(contact.affiliationId, contactPlan.channel);
			changes.push({
				target: 'vendorContact',
				subject: contact.fullName,
				field: 'Способ связи',
				from: contact.channel,
				to: contactPlan.channel
			});
			contact.channel = contactPlan.channel;
		}
	}

	if (contact !== null) {
		for (const product of rowProducts) {
			if (state.productContacts.has(productContactKey(product.id, contact.personId))) {
				continue;
			}

			await writer.linkProductContact(product.id, contact.personId);
			registerProductContact(state, product.id, contact.personId);
			changes.push({
				target: 'product',
				subject: product.name,
				field: 'Контакт вендора',
				from: null,
				to: contact.fullName
			});
		}
	}

	return {
		rowNo: row.rowNo,
		action: catalogRowAction({ issues, creations, changes }),
		issues,
		creations,
		changes,
		organizationId: company.id,
		// Ссылка на продукт одна, а продуктов в строке бывает несколько: ставится
		// только там, где она однозначна.
		productId: rowProducts.length === 1 ? rowProducts[0].id : null,
		contractId: null,
		contractItemId: null
	};
}
