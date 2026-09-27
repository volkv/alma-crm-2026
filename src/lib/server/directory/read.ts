/**
 * Чтение справочников для остальных модулей.
 *
 * Здесь только выборки: запись справочников — отдельная задача. Каждая функция
 * начинается с проверки права и подмешивает область доступа в условие, даже
 * пока все роли видят всё: правило, которое соблюдают не везде, — это не
 * правило, а совпадение.
 */
import {
	and,
	asc,
	count,
	countDistinct,
	desc,
	eq,
	exists,
	ilike,
	inArray,
	isNull,
	max,
	or,
	sql,
	type SQL
} from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import type { PageResult } from '$lib/contracts/common';
import type {
	AffiliationView,
	CatalogListQuery,
	DirectionDetail,
	DirectionDirectoryQuery,
	DirectionListItem,
	DirectionView,
	LookupOption,
	OrganizationDirectoryQuery,
	OrganizationListQuery,
	OrganizationRow,
	OrganizationView,
	PeopleListQuery,
	PersonAffiliationView,
	PersonListItem,
	PersonView,
	ProductContactView,
	ProductDetail,
	ProductDirectoryQuery,
	ProductView,
	ProgramDetail,
	ProgramDirectoryQuery,
	ProgramListItem,
	ProgramVersionView,
	ProgramView,
	SiteView
} from '$lib/contracts/directory';
import type { ActorContext } from '../actor';
import { cachedDirectoryOptions } from '../cache/directory';
import { getDb } from '../db';
import {
	affiliations,
	directions,
	organizations,
	people,
	productContacts,
	productDirections,
	products,
	programs,
	programVersions,
	sites
} from '../db/schema';
import type { Tx } from '../db/transaction';
import { NotFoundError } from '../errors';
import { visibleOrganizationFilter } from '../interactions/access';
import { personInScope, personVisible } from '../people/access';
import { withPiiTrace } from '../people/pii-trace';
import { retentionExpired } from '../people/retention';
import { toPersonView } from '../people/serialize';
import { requirePermission, scopeFilter } from '../rbac';

/**
 * Кто выполняет выборку: транзакция вызывающего или общий пул. Чтение внутри
 * чужой транзакции обязано видеть то, что она уже записала, но ещё не
 * закоммитила, — иначе заведение организации и роли в ней одной операцией
 * распадается на «организации нет».
 */
type Executor = Tx | ReturnType<typeof getDb>;

export function toOrganizationView(row: typeof organizations.$inferSelect): OrganizationView {
	return {
		id: row.id,
		kind: row.kind,
		educationLevel: row.educationLevel,
		legalName: row.legalName,
		shortName: row.shortName,
		inn: row.inn,
		kpp: row.kpp,
		ogrn: row.ogrn,
		region: row.region,
		website: row.website,
		notes: row.notes,
		isActive: row.isActive,
		externalSource: row.externalSource,
		externalId: row.externalId,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt
	};
}

export async function listOrganizations(
	ctx: ActorContext,
	query: OrganizationListQuery
): Promise<PageResult<OrganizationView>> {
	requirePermission(ctx, 'organizations.read');

	const conditions: SQL[] = [scopeFilter(ctx, organizations.id)];

	if (query.kind !== null) {
		conditions.push(eq(organizations.kind, query.kind));
	}

	if (query.q !== null) {
		const pattern = `%${query.q}%`;
		const search = or(
			ilike(organizations.legalName, pattern),
			ilike(organizations.shortName, pattern),
			ilike(organizations.inn, pattern)
		);
		if (search !== undefined) {
			conditions.push(search);
		}
	}

	const where = and(...conditions);
	const db = getDb();

	const [rows, totals] = await Promise.all([
		db
			.select()
			.from(organizations)
			.where(where)
			.orderBy(asc(organizations.shortName))
			.limit(query.pageSize)
			.offset((query.page - 1) * query.pageSize),
		db.select({ value: count() }).from(organizations).where(where)
	]);

	return {
		items: rows.map(toOrganizationView),
		total: totals[0]?.value ?? 0,
		page: query.page,
		pageSize: query.pageSize
	};
}

export async function getOrganization(
	ctx: ActorContext,
	id: string,
	executor: Executor = getDb()
): Promise<OrganizationView> {
	requirePermission(ctx, 'organizations.read');

	const [row] = await executor
		.select()
		.from(organizations)
		.where(and(eq(organizations.id, id), visibleOrganizationFilter(ctx, organizations.id)))
		.limit(1);

	if (row === undefined) {
		throw new NotFoundError('Организация не найдена');
	}

	return toOrganizationView(row);
}

export async function listSites(ctx: ActorContext, organizationId: string): Promise<SiteView[]> {
	requirePermission(ctx, 'organizations.read');

	const rows = await getDb()
		.select({
			id: sites.id,
			organizationId: sites.organizationId,
			kind: sites.kind,
			name: sites.name,
			address: sites.address,
			region: sites.region
		})
		.from(sites)
		.where(
			and(
				eq(sites.organizationId, organizationId),
				visibleOrganizationFilter(ctx, sites.organizationId)
			)
		)
		.orderBy(asc(sites.name));

	return rows;
}

export async function listAffiliations(
	ctx: ActorContext,
	organizationId: string
): Promise<AffiliationView[]> {
	requirePermission(ctx, 'people.read');

	// Контакты уходят наружу — значит, чтение объявляет себя областью сбора
	// следа просмотра: одно событие журнала на запрос, а не на строку таблицы.
	// Область открывается до выборки: тогда чтения, запущенные загрузчиком
	// страницы разом, попадают в одну область, а не в две подряд.
	return withPiiTrace(ctx, async () => {
		const rows = await getDb()
			.select({ affiliation: affiliations, person: people })
			.from(affiliations)
			.innerJoin(people, eq(people.id, affiliations.personId))
			.where(
				and(
					eq(affiliations.organizationId, organizationId),
					// Контактные лица карточки: видны там же, где видна сама
					// карточка, — включая основную сторону видимого взаимодействия.
					visibleOrganizationFilter(ctx, affiliations.organizationId)
				)
			)
			.orderBy(asc(people.lastName), asc(people.firstName));

		return rows.map(({ affiliation, person }) => ({
			id: affiliation.id,
			person: toPersonView(ctx, person),
			organizationId: affiliation.organizationId,
			siteId: affiliation.siteId,
			position: affiliation.position,
			roleKind: affiliation.roleKind,
			isPrimary: affiliation.isPrimary,
			validFrom: affiliation.validFrom,
			validTo: affiliation.validTo,
			channel: affiliation.channel
		}));
	});
}

/**
 * Программы и продукты — общий справочник оператора, а не имущество отдельной
 * организации, поэтому область доступа к ним не применяется.
 */
export async function listPrograms(
	ctx: ActorContext,
	query: CatalogListQuery
): Promise<PageResult<ProgramView>> {
	requirePermission(ctx, 'programs.read');

	const conditions: SQL[] = [];

	if (query.status !== null) {
		conditions.push(eq(programs.status, query.status));
	}

	if (query.q !== null) {
		const pattern = `%${query.q}%`;
		const search = or(ilike(programs.name, pattern), ilike(programs.code, pattern));
		if (search !== undefined) {
			conditions.push(search);
		}
	}

	const where = conditions.length === 0 ? undefined : and(...conditions);
	const db = getDb();

	const [rows, totals] = await Promise.all([
		db
			.select({
				id: programs.id,
				code: programs.code,
				name: programs.name,
				level: programs.level,
				directionCode: programs.directionCode,
				priority: programs.priority,
				status: programs.status
			})
			.from(programs)
			.where(where)
			.orderBy(asc(programs.code))
			.limit(query.pageSize)
			.offset((query.page - 1) * query.pageSize),
		db.select({ value: count() }).from(programs).where(where)
	]);

	return {
		items: rows,
		total: totals[0]?.value ?? 0,
		page: query.page,
		pageSize: query.pageSize
	};
}

export async function listProducts(
	ctx: ActorContext,
	query: CatalogListQuery
): Promise<PageResult<ProductView>> {
	requirePermission(ctx, 'products.read');

	const conditions: SQL[] = [];

	if (query.status !== null) {
		conditions.push(eq(products.status, query.status));
	}

	if (query.q !== null) {
		const pattern = `%${query.q}%`;
		const search = or(ilike(products.name, pattern), ilike(products.code, pattern));
		if (search !== undefined) {
			conditions.push(search);
		}
	}

	const where = conditions.length === 0 ? undefined : and(...conditions);
	const db = getDb();

	const [rows, totals] = await Promise.all([
		db
			.select({
				id: products.id,
				code: products.code,
				name: products.name,
				vendorOrganizationId: products.vendorOrganizationId,
				description: products.description,
				status: products.status
			})
			.from(products)
			.where(where)
			.orderBy(asc(products.code))
			.limit(query.pageSize)
			.offset((query.page - 1) * query.pageSize),
		db.select({ value: count() }).from(products).where(where)
	]);

	return {
		items: rows,
		total: totals[0]?.value ?? 0,
		page: query.page,
		pageSize: query.pageSize
	};
}

/**
 * Какую организацию можно выбрать стороной взаимодействия: действующую и в
 * области доступа. Одно условие на поиск в форме и на подстановку по ссылке —
 * иначе ссылка стала бы обходом того, чего человек не нашёл бы поиском.
 */
function pickableOrganization(ctx: ActorContext): SQL[] {
	return [scopeFilter(ctx, organizations.id), eq(organizations.isActive, true)];
}

/** Организация для подстановки в форму взаимодействия; `null` — выбрать её нельзя. */
export async function pickOrganization(
	ctx: ActorContext,
	id: string
): Promise<LookupOption | null> {
	requirePermission(ctx, 'organizations.read');

	const [row] = await getDb()
		.select({ id: organizations.id, label: organizations.shortName })
		.from(organizations)
		.where(and(eq(organizations.id, id), ...pickableOrganization(ctx)))
		.limit(1);

	return row ?? null;
}

/**
 * Какие ИНН уже заняты в справочнике и можно ли занявшую организацию выбрать.
 *
 * В ответе — только занятые ИНН: `LookupOption` — организацию можно выбрать
 * (действует и в области доступа), `null` — она есть, но выбрать её нельзя.
 * Второе приходится называть: ИНН уникален по всей базе, и завести такую
 * организацию заново не выйдет всё равно — об этом же скажет и сохранение
 * (`assertInnIsFree`).
 */
export async function matchOrganizationsByInn(
	ctx: ActorContext,
	inns: readonly string[]
): Promise<Map<string, LookupOption | null>> {
	requirePermission(ctx, 'organizations.read');

	const matches = new Map<string, LookupOption | null>();

	if (inns.length === 0) {
		return matches;
	}

	const [taken, pickable] = await Promise.all([
		getDb()
			.select({ inn: organizations.inn })
			.from(organizations)
			.where(inArray(organizations.inn, [...inns])),
		getDb()
			.select({ inn: organizations.inn, id: organizations.id, label: organizations.shortName })
			.from(organizations)
			.where(and(inArray(organizations.inn, [...inns]), ...pickableOrganization(ctx)))
	]);

	for (const row of taken) {
		if (row.inn !== null) {
			matches.set(row.inn, null);
		}
	}

	for (const row of pickable) {
		if (row.inn !== null) {
			matches.set(row.inn, { id: row.id, label: row.label });
		}
	}

	return matches;
}

/** Строки для выпадающего списка: коротко и с потолком по количеству. */
export async function lookupOrganizations(
	ctx: ActorContext,
	q: string | null
): Promise<LookupOption[]> {
	requirePermission(ctx, 'organizations.read');

	const conditions: SQL[] = pickableOrganization(ctx);

	if (q !== null && q.trim() !== '') {
		const pattern = `%${q.trim()}%`;
		const search = or(
			ilike(organizations.shortName, pattern),
			ilike(organizations.legalName, pattern),
			ilike(organizations.inn, pattern)
		);
		if (search !== undefined) {
			conditions.push(search);
		}
	}

	const rows = await getDb()
		.select({ id: organizations.id, label: organizations.shortName })
		.from(organizations)
		.where(and(...conditions))
		.orderBy(asc(organizations.shortName))
		.limit(20);

	return rows;
}

/**
 * Списки разделов интерфейса.
 *
 * Они отличаются от выборок API тем, что умеют сортировку по колонке и
 * возвращают то, что рисует таблица целиком — например, число площадок рядом с
 * организацией. Схемы API при этом не меняются: у публичного контракта свой
 * набор параметров и свой темп изменений.
 */

/** Колонка сортировки выбирается из закрытого словаря: имя из адреса в `order by` не попадает. */
function ordered(column: PgColumn | SQL, direction: 'asc' | 'desc'): SQL {
	return direction === 'desc' ? desc(column) : asc(column);
}

/**
 * Число площадок считается соединением с группировкой, а не подзапросом в
 * `sql`: в подзапросе Drizzle выводит имена столбцов без имени таблицы, и
 * `sites.organization_id = id` попадает на `sites.id`, а не на организацию —
 * запрос при этом остаётся синтаксически верным и молча возвращает нули.
 */
const siteCountExpression = count(sites.id);

const ORGANIZATION_SORT_COLUMNS = {
	shortName: organizations.shortName,
	kind: organizations.kind,
	inn: organizations.inn,
	region: organizations.region,
	isActive: organizations.isActive,
	siteCount: siteCountExpression
} as const;

export async function listOrganizationRows(
	ctx: ActorContext,
	query: OrganizationDirectoryQuery
): Promise<PageResult<OrganizationRow>> {
	requirePermission(ctx, 'organizations.read');

	const conditions: SQL[] = [scopeFilter(ctx, organizations.id)];

	if (query.kind.length > 0) {
		conditions.push(inArray(organizations.kind, query.kind));
	}

	if (query.educationLevel.length > 0) {
		conditions.push(inArray(organizations.educationLevel, query.educationLevel));
	}

	if (query.q !== null) {
		const pattern = `%${query.q}%`;
		const search = or(
			ilike(organizations.legalName, pattern),
			ilike(organizations.shortName, pattern),
			ilike(organizations.inn, pattern),
			ilike(organizations.region, pattern)
		);
		if (search !== undefined) {
			conditions.push(search);
		}
	}

	const where = and(...conditions);
	const db = getDb();

	const [rows, totals] = await Promise.all([
		db
			.select({ organization: organizations, siteCount: siteCountExpression })
			.from(organizations)
			.leftJoin(sites, eq(sites.organizationId, organizations.id))
			.where(where)
			.groupBy(organizations.id)
			// Второй ключ сортировки — первичный: без него строки с одинаковым
			// значением в колонке могут поменяться местами между страницами.
			.orderBy(
				ordered(ORGANIZATION_SORT_COLUMNS[query.sortBy], query.sortDirection),
				asc(organizations.id)
			)
			.limit(query.pageSize)
			.offset((query.page - 1) * query.pageSize),
		db.select({ value: count() }).from(organizations).where(where)
	]);

	return {
		items: rows.map((row) => ({
			organization: toOrganizationView(row.organization),
			siteCount: row.siteCount
		})),
		total: totals[0]?.value ?? 0,
		page: query.page,
		pageSize: query.pageSize
	};
}

/**
 * Организация с таким ИНН в области доступа вызывающего — по ней форма строит
 * ссылку на найденный дубль. Вне области доступа ответ пустой: сам факт занятого
 * ИНН сообщает сервис записи, а вот чужую организацию по нему не показывают.
 */
export async function findOrganizationByInn(
	ctx: ActorContext,
	inn: string,
	executor: Executor = getDb()
): Promise<LookupOption | null> {
	requirePermission(ctx, 'organizations.read');

	const [row] = await executor
		.select({ id: organizations.id, label: organizations.shortName })
		.from(organizations)
		.where(and(eq(organizations.inn, inn), scopeFilter(ctx, organizations.id)))
		.limit(1);

	return row ?? null;
}

export async function getSite(
	ctx: ActorContext,
	id: string,
	executor: Executor = getDb()
): Promise<SiteView> {
	requirePermission(ctx, 'organizations.read');

	const [row] = await executor
		.select({
			id: sites.id,
			organizationId: sites.organizationId,
			kind: sites.kind,
			name: sites.name,
			address: sites.address,
			region: sites.region
		})
		.from(sites)
		.where(and(eq(sites.id, id), visibleOrganizationFilter(ctx, sites.organizationId)))
		.limit(1);

	if (row === undefined) {
		throw new NotFoundError('Площадка не найдена');
	}

	return row;
}

/** ФИО одной строкой — по нему ищут человека в списке. */
const fullNameExpression = sql<string>`trim(
	${people.lastName} || ' ' || ${people.firstName} || ' ' || coalesce(${people.middleName}, '')
)`;

const PEOPLE_SORT_COLUMNS = {
	lastName: people.lastName,
	firstName: people.firstName
} as const;

export async function getPerson(ctx: ActorContext, id: string): Promise<PersonView> {
	requirePermission(ctx, 'people.read');

	return withPiiTrace(ctx, async () => {
		const [row] = await getDb()
			.select()
			.from(people)
			.where(and(eq(people.id, id), personVisible(ctx)))
			.limit(1);

		if (row === undefined) {
			throw new NotFoundError('Человек не найден');
		}

		return toPersonView(ctx, row);
	});
}

export async function listPeople(
	ctx: ActorContext,
	query: PeopleListQuery
): Promise<PageResult<PersonListItem>> {
	requirePermission(ctx, 'people.read');

	const conditions: SQL[] = [personInScope(ctx)];

	const db = getDb();

	if (query.retention === 'expired') {
		conditions.push(retentionExpired);
	}

	if (query.organizationId !== null) {
		conditions.push(
			exists(
				db
					.select({ one: sql`1` })
					.from(affiliations)
					.where(
						and(
							eq(affiliations.personId, people.id),
							eq(affiliations.organizationId, query.organizationId),
							scopeFilter(ctx, affiliations.organizationId)
						)
					)
			)
		);
	}

	if (query.q !== null) {
		const pattern = `%${query.q}%`;
		// Поиск идёт и по названию организации: человека чаще ищут «кто у нас в
		// политехе», чем по фамилии, которую ещё надо вспомнить.
		const byOrganization = exists(
			db
				.select({ one: sql`1` })
				.from(affiliations)
				.innerJoin(organizations, eq(organizations.id, affiliations.organizationId))
				.where(
					and(
						eq(affiliations.personId, people.id),
						scopeFilter(ctx, affiliations.organizationId),
						or(ilike(organizations.shortName, pattern), ilike(organizations.legalName, pattern))
					)
				)
		);

		conditions.push(sql`(${fullNameExpression} ilike ${pattern} or ${byOrganization})`);
	}

	const where = and(...conditions);

	return withPiiTrace(ctx, async () => {
		const [rows, totals] = await Promise.all([
			db
				// Истёкший срок хранения считает база: «сегодня» у неё и у приложения
				// должно быть одно, иначе строка то помечена, то нет.
				.select({ person: people, retentionExpired })
				.from(people)
				.where(where)
				.orderBy(ordered(PEOPLE_SORT_COLUMNS[query.sortBy], query.sortDirection), asc(people.id))
				.limit(query.pageSize)
				.offset((query.page - 1) * query.pageSize),
			db.select({ value: count() }).from(people).where(where)
		]);

		const ids = rows.map((row) => row.person.id);
		const links =
			ids.length === 0
				? []
				: await db
						.selectDistinct({
							personId: affiliations.personId,
							id: organizations.id,
							label: organizations.shortName
						})
						.from(affiliations)
						.innerJoin(organizations, eq(organizations.id, affiliations.organizationId))
						.where(
							and(
								inArray(affiliations.personId, ids),
								scopeFilter(ctx, affiliations.organizationId)
							)
						)
						.orderBy(asc(organizations.shortName));

		const byPerson = new Map<string, LookupOption[]>();
		for (const link of links) {
			const list = byPerson.get(link.personId) ?? [];
			list.push({ id: link.id, label: link.label });
			byPerson.set(link.personId, list);
		}

		return {
			items: rows.map((row) => ({
				person: toPersonView(ctx, row.person),
				organizations: byPerson.get(row.person.id) ?? [],
				retentionExpired: row.retentionExpired
			})),
			total: totals[0]?.value ?? 0,
			page: query.page,
			pageSize: query.pageSize
		};
	});
}

/** Роли одного человека — вместе с названиями организации и площадки. */
export async function listPersonAffiliations(
	ctx: ActorContext,
	personId: string
): Promise<PersonAffiliationView[]> {
	requirePermission(ctx, 'people.read');

	return withPiiTrace(ctx, async () => {
		const rows = await getDb()
			.select({
				affiliation: affiliations,
				person: people,
				organization: organizations,
				site: sites
			})
			.from(affiliations)
			.innerJoin(people, eq(people.id, affiliations.personId))
			.innerJoin(organizations, eq(organizations.id, affiliations.organizationId))
			.leftJoin(sites, eq(sites.id, affiliations.siteId))
			.where(
				and(
					eq(affiliations.personId, personId),
					visibleOrganizationFilter(ctx, affiliations.organizationId)
				)
			)
			.orderBy(desc(affiliations.validFrom), asc(organizations.shortName));

		return rows.map(({ affiliation, person, organization, site }) => ({
			affiliation: {
				id: affiliation.id,
				person: toPersonView(ctx, person),
				organizationId: affiliation.organizationId,
				siteId: affiliation.siteId,
				position: affiliation.position,
				roleKind: affiliation.roleKind,
				isPrimary: affiliation.isPrimary,
				validFrom: affiliation.validFrom,
				validTo: affiliation.validTo,
				channel: affiliation.channel
			},
			organization: { id: organization.id, label: organization.shortName },
			site: site === null ? null : { id: site.id, label: site.name }
		}));
	});
}

/**
 * Приоритет — ручной порядок показа: 1 первым, без приоритета — в конце. Явное
 * `nulls last` стоит потому, что по убыванию Postgres поставил бы `null`
 * первыми, и список открывался бы теми программами, которым приоритет как раз
 * не назначали.
 */
const programPriorityOrder = {
	asc: sql`${programs.priority} asc nulls last`,
	desc: sql`${programs.priority} desc nulls last`
} as const;

const PROGRAM_SORT_COLUMNS = {
	code: programs.code,
	name: programs.name,
	level: programs.level,
	status: programs.status
} as const;

/**
 * Номер последней версии программы: в списке он важнее, чем вся их история.
 * Считается соединением с группировкой по той же причине, что и число
 * площадок, — Drizzle не квалифицирует столбцы в подзапросе внутри `sql`.
 */
const latestVersionExpression = max(programVersions.version);

export async function listProgramRows(
	ctx: ActorContext,
	query: ProgramDirectoryQuery
): Promise<PageResult<ProgramListItem>> {
	requirePermission(ctx, 'programs.read');

	const conditions: SQL[] = [];

	if (query.status !== null) {
		conditions.push(eq(programs.status, query.status));
	}

	if (query.level !== null) {
		conditions.push(eq(programs.level, query.level));
	}

	if (query.q !== null) {
		const pattern = `%${query.q}%`;
		const search = or(
			ilike(programs.name, pattern),
			ilike(programs.code, pattern),
			ilike(programs.directionCode, pattern)
		);
		if (search !== undefined) {
			conditions.push(search);
		}
	}

	const where = conditions.length === 0 ? undefined : and(...conditions);
	const db = getDb();

	const [rows, totals] = await Promise.all([
		db
			.select({
				id: programs.id,
				code: programs.code,
				name: programs.name,
				level: programs.level,
				directionCode: programs.directionCode,
				priority: programs.priority,
				status: programs.status,
				latestVersion: latestVersionExpression
			})
			.from(programs)
			.leftJoin(programVersions, eq(programVersions.programId, programs.id))
			.where(where)
			.groupBy(programs.id)
			// Второй ключ — название: у ручного приоритета совпадения — обычное
			// дело, а «в каком угодно порядке» для списка, который читают глазами,
			// не порядок. Третий — идентификатор, чтобы строка с границы страниц
			// не показалась дважды.
			.orderBy(
				query.sortBy === 'priority'
					? programPriorityOrder[query.sortDirection]
					: ordered(PROGRAM_SORT_COLUMNS[query.sortBy], query.sortDirection),
				asc(programs.name),
				asc(programs.id)
			)
			.limit(query.pageSize)
			.offset((query.page - 1) * query.pageSize),
		db.select({ value: count() }).from(programs).where(where)
	]);

	return {
		items: rows.map(({ latestVersion, ...program }) => ({ program, latestVersion })),
		total: totals[0]?.value ?? 0,
		page: query.page,
		pageSize: query.pageSize
	};
}

function toProgramVersionView(row: typeof programVersions.$inferSelect): ProgramVersionView {
	return {
		id: row.id,
		programId: row.programId,
		version: row.version,
		summary: row.summary,
		effectiveFrom: row.effectiveFrom,
		createdAt: row.createdAt
	};
}

export async function getProgram(ctx: ActorContext, id: string): Promise<ProgramDetail> {
	requirePermission(ctx, 'programs.read');

	const db = getDb();

	const [program] = await db
		.select({
			id: programs.id,
			code: programs.code,
			name: programs.name,
			level: programs.level,
			directionCode: programs.directionCode,
			priority: programs.priority,
			status: programs.status
		})
		.from(programs)
		.where(eq(programs.id, id))
		.limit(1);

	if (program === undefined) {
		throw new NotFoundError('Программа не найдена');
	}

	const versions = await db
		.select()
		.from(programVersions)
		.where(eq(programVersions.programId, id))
		.orderBy(desc(programVersions.version));

	return { program, versions: versions.map(toProgramVersionView) };
}

const PRODUCT_SORT_COLUMNS = {
	code: products.code,
	name: products.name,
	status: products.status
} as const;

export async function listProductRows(
	ctx: ActorContext,
	query: ProductDirectoryQuery
): Promise<PageResult<ProductDetail>> {
	requirePermission(ctx, 'products.read');

	const conditions: SQL[] = [];

	if (query.status !== null) {
		conditions.push(eq(products.status, query.status));
	}

	if (query.q !== null) {
		const pattern = `%${query.q}%`;
		const search = or(ilike(products.name, pattern), ilike(products.code, pattern));
		if (search !== undefined) {
			conditions.push(search);
		}
	}

	const where = conditions.length === 0 ? undefined : and(...conditions);
	const db = getDb();

	const [rows, totals] = await Promise.all([
		db
			.select({
				id: products.id,
				code: products.code,
				name: products.name,
				vendorOrganizationId: products.vendorOrganizationId,
				description: products.description,
				status: products.status,
				vendorName: organizations.shortName
			})
			.from(products)
			.leftJoin(organizations, eq(organizations.id, products.vendorOrganizationId))
			.where(where)
			.orderBy(ordered(PRODUCT_SORT_COLUMNS[query.sortBy], query.sortDirection), asc(products.id))
			.limit(query.pageSize)
			.offset((query.page - 1) * query.pageSize),
		db.select({ value: count() }).from(products).where(where)
	]);

	return {
		items: rows.map(({ vendorName, ...product }) => ({
			product,
			vendor:
				product.vendorOrganizationId === null || vendorName === null
					? null
					: { id: product.vendorOrganizationId, label: vendorName }
		})),
		total: totals[0]?.value ?? 0,
		page: query.page,
		pageSize: query.pageSize
	};
}

export async function getProduct(ctx: ActorContext, id: string): Promise<ProductDetail> {
	requirePermission(ctx, 'products.read');

	const [row] = await getDb()
		.select({
			id: products.id,
			code: products.code,
			name: products.name,
			vendorOrganizationId: products.vendorOrganizationId,
			description: products.description,
			status: products.status,
			vendorName: organizations.shortName
		})
		.from(products)
		.leftJoin(organizations, eq(organizations.id, products.vendorOrganizationId))
		.where(eq(products.id, id))
		.limit(1);

	if (row === undefined) {
		throw new NotFoundError('Продукт не найден');
	}

	const { vendorName, ...product } = row;

	return {
		product,
		vendor:
			product.vendorOrganizationId === null || vendorName === null
				? null
				: { id: product.vendorOrganizationId, label: vendorName }
	};
}

/**
 * Контакты вендора по продукту для карточки продукта.
 *
 * Видны всем, у кого есть `people.read`, без области доступа: это деловые
 * контакты правообладателя по общему справочнику продуктов, и КАМу они нужны
 * при передаче лицензий — а сами вендоры в область не попадают ни у кого,
 * кроме полного доступа. Поэтому человек отбирается связью `product_contacts`,
 * а не общим правилом видимости людей (`personVisible`) — по нему считается
 * только признак `openable`: откроется ли вызывающему карточка человека. Почта и телефон
 * по-прежнему маскируются без `people.read_pii` (сериализатор), чтение
 * оставляет след просмотра. Роль берётся у правообладателя продукта,
 * действующая — первой.
 */
export async function listProductContacts(
	ctx: ActorContext,
	productId: string
): Promise<ProductContactView[]> {
	requirePermission(ctx, 'people.read');

	return withPiiTrace(ctx, async () => {
		const rows = await getDb()
			.select({
				person: people,
				affiliation: affiliations,
				openable: sql<boolean>`${personVisible(ctx)}`
			})
			.from(productContacts)
			.innerJoin(products, eq(products.id, productContacts.productId))
			.innerJoin(people, eq(people.id, productContacts.personId))
			.leftJoin(
				affiliations,
				and(
					eq(affiliations.personId, productContacts.personId),
					eq(affiliations.organizationId, products.vendorOrganizationId)
				)
			)
			.where(eq(productContacts.productId, productId))
			.orderBy(
				asc(people.lastName),
				asc(people.firstName),
				sql`${affiliations.validTo} is not null`,
				desc(affiliations.validFrom)
			);

		const byPerson = new Map<string, ProductContactView>();

		for (const { person, affiliation, openable } of rows) {
			if (byPerson.has(person.id)) {
				continue;
			}

			byPerson.set(person.id, {
				person: toPersonView(ctx, person),
				position: affiliation?.position ?? null,
				roleKind: affiliation?.roleKind ?? null,
				channel: affiliation?.channel ?? null,
				openable
			});
		}

		return [...byPerson.values()];
	});
}

export function toDirectionView(row: typeof directions.$inferSelect): DirectionView {
	return {
		id: row.id,
		code: row.code,
		name: row.name,
		position: row.position,
		isActive: row.isActive
	};
}

/**
 * Строка направления или «не найдено».
 *
 * Области доступа здесь нет и быть не может: направления — общий разрез работы
 * оператора, такой же общий каталог, как программы и продукты
 * (`docs/directory.md`). Ограничивает доступ право `directions.read`, а оно
 * есть у всех трёх ролей.
 */
export async function getDirectionRow(ctx: ActorContext, id: string): Promise<DirectionView> {
	requirePermission(ctx, 'directions.read');

	const [row] = await getDb().select().from(directions).where(eq(directions.id, id)).limit(1);

	if (row === undefined) {
		throw new NotFoundError('Направление не найдено');
	}

	return toDirectionView(row);
}

const DIRECTION_SORT_COLUMNS = {
	position: directions.position,
	code: directions.code,
	name: directions.name
} as const;

/**
 * Список направлений вместе с тем, что на них ссылается.
 *
 * Оба счётчика — `countDistinct`: соединений два, и обычный `count` перемножил
 * бы продукты на программы, показав направлению с двумя продуктами и тремя
 * программами по шесть тех и других.
 */
export async function listDirectionRows(
	ctx: ActorContext,
	query: DirectionDirectoryQuery
): Promise<PageResult<DirectionListItem>> {
	requirePermission(ctx, 'directions.read');

	const conditions: SQL[] = [];

	if (query.state !== null) {
		conditions.push(eq(directions.isActive, query.state === 'active'));
	}

	if (query.q !== null) {
		const pattern = `%${query.q}%`;
		const search = or(ilike(directions.name, pattern), ilike(directions.code, pattern));

		if (search !== undefined) {
			conditions.push(search);
		}
	}

	const where = conditions.length === 0 ? undefined : and(...conditions);
	const db = getDb();

	const [rows, totals] = await Promise.all([
		db
			.select({
				direction: directions,
				productCount: countDistinct(productDirections.productId),
				programCount: countDistinct(programs.id)
			})
			.from(directions)
			.leftJoin(productDirections, eq(productDirections.directionId, directions.id))
			.leftJoin(programs, eq(programs.directionId, directions.id))
			.where(where)
			.groupBy(directions.id)
			.orderBy(
				ordered(DIRECTION_SORT_COLUMNS[query.sortBy], query.sortDirection),
				asc(directions.id)
			)
			.limit(query.pageSize)
			.offset((query.page - 1) * query.pageSize),
		db.select({ value: count() }).from(directions).where(where)
	]);

	return {
		items: rows.map((row) => ({
			direction: toDirectionView(row.direction),
			productCount: row.productCount,
			programCount: row.programCount
		})),
		total: totals[0]?.value ?? 0,
		page: query.page,
		pageSize: query.pageSize
	};
}

/**
 * Карточка направления: оно само, его продукты и его программы. Названия, а не
 * идентификаторы: по направлению отвечают на вопрос «что мы по нему предлагаем»,
 * и ответ должен читаться глазами.
 */
export async function getDirection(ctx: ActorContext, id: string): Promise<DirectionDetail> {
	const direction = await getDirectionRow(ctx, id);
	const db = getDb();

	const [productRows, programRows] = await Promise.all([
		db
			.select({ id: products.id, code: products.code, name: products.name })
			.from(productDirections)
			.innerJoin(products, eq(products.id, productDirections.productId))
			.where(eq(productDirections.directionId, id))
			.orderBy(asc(products.code)),
		db
			.select({ id: programs.id, code: programs.code, name: programs.name })
			.from(programs)
			.where(eq(programs.directionId, id))
			.orderBy(asc(programs.code))
	]);

	return {
		direction,
		products: productRows.map((row) => ({ id: row.id, label: `${row.code} — ${row.name}` })),
		programs: programRows.map((row) => ({ id: row.id, label: `${row.code} — ${row.name}` }))
	};
}

/**
 * Потолок выпадающего списка. Больше пятисот строк в `<select>` человек всё
 * равно не разберёт — такой справочник пора искать, а не листать.
 */
const OPTIONS_LIMIT = 500;

/**
 * Действующие организации для выпадающего списка формы.
 *
 * Подбор приезжает почти с каждой формой и меняется только вместе со
 * справочником, поэтому собранный список живёт в Redis — под ключом своей
 * области доступа (`cache/directory.ts`). Право проверяется до кэша: запись в
 * Redis не должна становиться обходом проверки.
 */
export async function listOrganizationOptions(ctx: ActorContext): Promise<LookupOption[]> {
	requirePermission(ctx, 'organizations.read');

	return cachedDirectoryOptions(
		ctx,
		'organizations',
		async () =>
			getDb()
				.select({ id: organizations.id, label: organizations.shortName })
				.from(organizations)
				.where(and(eq(organizations.isActive, true), scopeFilter(ctx, organizations.id)))
				.orderBy(asc(organizations.shortName))
				.limit(OPTIONS_LIMIT),
		// Ни одного поля со временем: подбор — это пара «идентификатор и подпись».
		(stored) => stored as LookupOption[]
	);
}

/**
 * Люди для выпадающего списка формы; ФИО собирается на стороне базы.
 * Обезличенных в подборе нет: выбирать контактом того, чьи данные уничтожены,
 * незачем, а в уже заведённых ролях он остаётся.
 */
export async function listPersonOptions(ctx: ActorContext): Promise<LookupOption[]> {
	requirePermission(ctx, 'people.read');

	return cachedDirectoryOptions(
		ctx,
		'people',
		async () =>
			getDb()
				.select({ id: people.id, label: fullNameExpression })
				.from(people)
				.where(and(personInScope(ctx), isNull(people.anonymizedAt)))
				.orderBy(asc(people.lastName), asc(people.firstName))
				.limit(OPTIONS_LIMIT),
		(stored) => stored as LookupOption[]
	);
}
