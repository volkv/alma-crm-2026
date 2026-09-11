/**
 * Чтение справочников для остальных модулей.
 *
 * Здесь только выборки: запись справочников — отдельная задача. Каждая функция
 * начинается с проверки права и подмешивает область доступа в условие, даже
 * пока все роли видят всё: правило, которое соблюдают не везде, — это не
 * правило, а совпадение.
 */
import { and, asc, count, eq, ilike, or, type SQL } from 'drizzle-orm';
import type { PageResult } from '$lib/contracts/common';
import type {
	AffiliationView,
	CatalogListQuery,
	LookupOption,
	OrganizationListQuery,
	OrganizationView,
	ProductView,
	ProgramView,
	SiteView
} from '$lib/contracts/directory';
import type { ActorContext } from '../actor';
import { getDb } from '../db';
import { affiliations, organizations, people, products, programs, sites } from '../db/schema';
import { NotFoundError } from '../errors';
import { toPersonView } from '../people/serialize';
import { requirePermission, scopeFilter } from '../rbac';

function toOrganizationView(row: typeof organizations.$inferSelect): OrganizationView {
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

export async function getOrganization(ctx: ActorContext, id: string): Promise<OrganizationView> {
	requirePermission(ctx, 'organizations.read');

	const [row] = await getDb()
		.select()
		.from(organizations)
		.where(and(eq(organizations.id, id), scopeFilter(ctx, organizations.id)))
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
		.where(and(eq(sites.organizationId, organizationId), scopeFilter(ctx, sites.organizationId)))
		.orderBy(asc(sites.name));

	return rows;
}

export async function listAffiliations(
	ctx: ActorContext,
	organizationId: string
): Promise<AffiliationView[]> {
	requirePermission(ctx, 'people.read');

	const rows = await getDb()
		.select({ affiliation: affiliations, person: people })
		.from(affiliations)
		.innerJoin(people, eq(people.id, affiliations.personId))
		.where(
			and(
				eq(affiliations.organizationId, organizationId),
				scopeFilter(ctx, affiliations.organizationId)
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

/** Строки для выпадающего списка: коротко и с потолком по количеству. */
export async function lookupOrganizations(
	ctx: ActorContext,
	q: string | null
): Promise<LookupOption[]> {
	requirePermission(ctx, 'organizations.read');

	const conditions: SQL[] = [scopeFilter(ctx, organizations.id), eq(organizations.isActive, true)];

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
