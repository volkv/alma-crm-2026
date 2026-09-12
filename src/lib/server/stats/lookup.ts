/**
 * Поиск записей справочника по тому, что написано в файле.
 *
 * В выгрузке нет идентификаторов — там название вуза, ИНН и код программы,
 * набранные человеком. Поэтому строка ищется по нескольким ключам сразу, а
 * неоднозначность — это отказ, а не выбор наугад: две организации с одним
 * коротким названием означают, что строку нельзя отнести ни к одной из них,
 * и человек должен об этом узнать.
 */
import { getDb } from '../db';
import { organizations, programs, sites } from '../db/schema';

/** Название в сравнимом виде: регистр, «ё», кавычки и пробелы к делу не относятся. */
export function normalizeName(value: string): string {
	return value
		.toLocaleLowerCase('ru')
		.replaceAll('ё', 'е')
		.replaceAll(/[^\p{L}\p{N}]+/gu, ' ')
		.trim();
}

/** Похоже ли значение на ИНН: десять или двенадцать цифр. */
function looksLikeInn(value: string): boolean {
	return /^\d{10}$|^\d{12}$/.test(value.replaceAll(/\s/g, ''));
}

/** Ключи поиска → идентификаторы. Список, а не один id: дубль обязан быть виден. */
type Keyed = Map<string, string[]>;

function add(index: Keyed, key: string, id: string): void {
	if (key === '') {
		return;
	}

	const found = index.get(key);

	if (found === undefined) {
		index.set(key, [id]);
	} else if (!found.includes(id)) {
		found.push(id);
	}
}

export type DirectoryIndex = {
	organizationByInn: Keyed;
	organizationByName: Keyed;
	programByCode: Keyed;
	programByName: Keyed;
	/** Ключ площадки — её организация и название: имена уникальны только внутри вуза. */
	siteByName: Keyed;
};

/**
 * Справочник целиком в память. Организаций и программ у оператора десятки, а
 * файл на двадцать тысяч строк иначе дал бы двадцать тысяч запросов.
 */
export async function loadDirectoryIndex(): Promise<DirectoryIndex> {
	const db = getDb();

	const [organizationRows, programRows, siteRows] = await Promise.all([
		db
			.select({
				id: organizations.id,
				inn: organizations.inn,
				shortName: organizations.shortName,
				legalName: organizations.legalName
			})
			.from(organizations),
		db.select({ id: programs.id, code: programs.code, name: programs.name }).from(programs),
		db.select({ id: sites.id, organizationId: sites.organizationId, name: sites.name }).from(sites)
	]);

	const index: DirectoryIndex = {
		organizationByInn: new Map(),
		organizationByName: new Map(),
		programByCode: new Map(),
		programByName: new Map(),
		siteByName: new Map()
	};

	for (const row of organizationRows) {
		if (row.inn !== null) {
			add(index.organizationByInn, row.inn, row.id);
		}

		add(index.organizationByName, normalizeName(row.shortName), row.id);
		add(index.organizationByName, normalizeName(row.legalName), row.id);
	}

	for (const row of programRows) {
		add(index.programByCode, normalizeName(row.code), row.id);
		add(index.programByName, normalizeName(row.name), row.id);
	}

	for (const row of siteRows) {
		add(index.siteByName, siteKey(row.organizationId, row.name), row.id);
	}

	return index;
}

function siteKey(organizationId: string, name: string): string {
	return `${organizationId} ${normalizeName(name)}`;
}

/** Чем кончился поиск: запись или объяснение, почему её нет. */
export type Resolution = {
	id: string | null;
	/** Претензия для строки; `null` — нашлось, либо искать было нечего. */
	message: string | null;
};

const EMPTY: Resolution = { id: null, message: null };

function pick(index: Keyed, key: string, value: string): Resolution | null {
	const found = index.get(key);

	if (found === undefined) {
		return null;
	}

	if (found.length > 1) {
		return {
			id: null,
			message: `Под «${value}» подходит несколько записей справочника — уточните значение`
		};
	}

	return { id: found[0], message: null };
}

/**
 * Организация по ИНН или названию. ИНН сильнее: он и заведён ради того, чтобы
 * различать одноимённые юридические лица.
 */
export function lookupOrganization(index: DirectoryIndex, raw: string): Resolution {
	const value = raw.trim();

	if (value === '') {
		return EMPTY;
	}

	if (looksLikeInn(value)) {
		const inn = value.replaceAll(/\s/g, '');
		const byInn = pick(index.organizationByInn, inn, value);

		return byInn ?? { id: null, message: `Организация с ИНН «${inn}» не найдена в справочнике` };
	}

	const byName = pick(index.organizationByName, normalizeName(value), value);

	return byName ?? { id: null, message: `Организация «${value}» не найдена в справочнике` };
}

/** Программа по коду или названию. */
export function lookupProgram(index: DirectoryIndex, raw: string): Resolution {
	const value = raw.trim();

	if (value === '') {
		return EMPTY;
	}

	const key = normalizeName(value);
	const byCode = pick(index.programByCode, key, value);

	if (byCode !== null) {
		return byCode;
	}

	const byName = pick(index.programByName, key, value);

	return byName ?? { id: null, message: `Программа «${value}» не найдена в справочнике` };
}

/**
 * Площадка внутри организации. Без организации искать нечего: одинаковые
 * названия площадок («Главный корпус») встречаются у разных вузов.
 */
export function lookupSite(
	index: DirectoryIndex,
	organizationId: string | null,
	raw: string
): Resolution {
	const value = raw.trim();

	if (value === '') {
		return EMPTY;
	}

	if (organizationId === null) {
		return {
			id: null,
			message: `Площадку «${value}» не к чему привязать: организация не опознана`
		};
	}

	const found = pick(index.siteByName, siteKey(organizationId, value), value);

	return found ?? { id: null, message: `Площадка «${value}» не найдена у этой организации` };
}
