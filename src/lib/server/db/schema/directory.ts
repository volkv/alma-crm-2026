/**
 * Справочники: организации и их площадки, люди и их роли в организациях,
 * образовательные программы и продукты.
 *
 * Набор полей — гипотеза до получения технического задания, поэтому имена
 * нейтральные, а смысл каждого столбца описан рядом. Значения перечислений
 * берутся из контрактов, чтобы список вариантов был один на форму и на базу.
 */
import { relations, sql } from 'drizzle-orm';
import {
	boolean,
	check,
	date,
	foreignKey,
	integer,
	pgEnum,
	pgTable,
	text,
	unique,
	uniqueIndex,
	uuid
} from 'drizzle-orm/pg-core';
import {
	AFFILIATION_ROLE_KINDS,
	EDUCATION_LEVELS,
	LIFECYCLE_STATUSES,
	ORGANIZATION_KINDS,
	PROGRAM_LEVELS,
	SITE_KINDS
} from '$lib/contracts/directory';
import { users } from './auth';
import { externalRef, externalRefUnique, timestamps } from './shared';

export const organizationKindEnum = pgEnum('organization_kind', ORGANIZATION_KINDS);
export const educationLevelEnum = pgEnum('education_level', EDUCATION_LEVELS);
export const siteKindEnum = pgEnum('site_kind', SITE_KINDS);
export const affiliationRoleKindEnum = pgEnum('affiliation_role_kind', AFFILIATION_ROLE_KINDS);
export const programLevelEnum = pgEnum('program_level', PROGRAM_LEVELS);
export const lifecycleStatusEnum = pgEnum('lifecycle_status', LIFECYCLE_STATUSES);

export const organizations = pgTable(
	'organizations',
	{
		id: uuid().primaryKey().defaultRandom(),
		kind: organizationKindEnum().notNull(),
		/** Заполнен ровно у учебных заведений — это же проверяет CHECK ниже. */
		educationLevel: educationLevelEnum(),
		legalName: text().notNull(),
		shortName: text().notNull(),
		inn: text(),
		kpp: text(),
		ogrn: text(),
		region: text(),
		website: text(),
		notes: text(),
		isActive: boolean().notNull().default(true),
		...externalRef,
		...timestamps
	},
	(table) => [
		// Организация без ИНН — нормальная ситуация (филиал, школа), поэтому
		// уникальность частичная: дублей среди заполненных ИНН быть не должно.
		uniqueIndex('organizations_inn_key')
			.on(table.inn)
			.where(sql`${table.inn} is not null`),
		externalRefUnique('organizations_external_ref_key', table),
		check(
			'organizations_education_level_matches_kind',
			sql`(${table.educationLevel} is not null) = (${table.kind} = 'educational_institution')`
		)
	]
);

export const sites = pgTable(
	'sites',
	{
		id: uuid().primaryKey().defaultRandom(),
		organizationId: uuid()
			.notNull()
			.references(() => organizations.id, { onDelete: 'cascade' }),
		kind: siteKindEnum().notNull(),
		name: text().notNull(),
		address: text(),
		region: text(),
		...externalRef,
		...timestamps
	},
	(table) => [
		unique('sites_organization_name_key').on(table.organizationId, table.name),
		// Цель этого ключа — не уникальность (она уже есть у первичного ключа),
		// а возможность сослаться на пару «площадка + её организация»: так роль
		// человека не может указать на площадку чужой организации.
		unique('sites_id_organization_key').on(table.id, table.organizationId),
		externalRefUnique('sites_external_ref_key', table)
	]
);

export const people = pgTable('people', {
	id: uuid().primaryKey().defaultRandom(),
	lastName: text().notNull(),
	firstName: text().notNull(),
	middleName: text(),
	/** Контакты — персональные данные: наружу их отдаёт только сериализатор. */
	email: text(),
	phone: text(),
	notes: text(),
	...timestamps
});

export const affiliations = pgTable(
	'affiliations',
	{
		id: uuid().primaryKey().defaultRandom(),
		personId: uuid()
			.notNull()
			.references(() => people.id, { onDelete: 'cascade' }),
		organizationId: uuid()
			.notNull()
			.references(() => organizations.id, { onDelete: 'cascade' }),
		/** Внешний ключ на площадку — составной, объявлен ниже вместе с проверкой. */
		siteId: uuid(),
		position: text().notNull(),
		roleKind: affiliationRoleKindEnum().notNull(),
		/** Основной контакт организации по процессу. */
		isPrimary: boolean().notNull().default(false),
		validFrom: date().notNull(),
		validTo: date(),
		/** Как договорились общаться: почта, телефон, мессенджер, портал. */
		channel: text(),
		...timestamps
	},
	(table) => [
		// Площадка обязана принадлежать той же организации. Составной внешний
		// ключ проверяет это декларативно; при `site_id is null` он ничего не
		// требует — правило MATCH SIMPLE, это и нужно. Удаление осталось NO
		// ACTION: проверка откладывается до конца оператора, поэтому каскад от
		// организации (он сносит и площадки, и роли) проходит, а точечное
		// удаление площадки, на которую ссылается роль, будет отвергнуто.
		foreignKey({
			name: 'affiliations_site_belongs_to_organization',
			columns: [table.siteId, table.organizationId],
			foreignColumns: [sites.id, sites.organizationId]
		}),
		check(
			'affiliations_period_ordered',
			sql`${table.validTo} is null or ${table.validTo} >= ${table.validFrom}`
		)
	]
);

export const programs = pgTable(
	'programs',
	{
		id: uuid().primaryKey().defaultRandom(),
		/** Код программы в номенклатуре оператора. */
		code: text().notNull().unique(),
		name: text().notNull(),
		level: programLevelEnum().notNull(),
		/** Код направления подготовки, например 09.03.01. */
		directionCode: text(),
		status: lifecycleStatusEnum().notNull().default('draft'),
		...externalRef,
		...timestamps
	},
	(table) => [externalRefUnique('programs_external_ref_key', table)]
);

export const programVersions = pgTable(
	'program_versions',
	{
		id: uuid().primaryKey().defaultRandom(),
		programId: uuid()
			.notNull()
			.references(() => programs.id, { onDelete: 'cascade' }),
		version: integer().notNull(),
		summary: text().notNull(),
		effectiveFrom: date().notNull(),
		createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),
		...timestamps
	},
	(table) => [unique('program_versions_program_version_key').on(table.programId, table.version)]
);

export const products = pgTable(
	'products',
	{
		id: uuid().primaryKey().defaultRandom(),
		code: text().notNull().unique(),
		name: text().notNull(),
		/** Правообладатель или поставщик продукта, если он известен. */
		vendorOrganizationId: uuid().references(() => organizations.id, { onDelete: 'set null' }),
		description: text(),
		status: lifecycleStatusEnum().notNull().default('draft'),
		...externalRef,
		...timestamps
	},
	(table) => [externalRefUnique('products_external_ref_key', table)]
);

export const organizationsRelations = relations(organizations, ({ many }) => ({
	sites: many(sites),
	affiliations: many(affiliations),
	products: many(products)
}));

export const sitesRelations = relations(sites, ({ one }) => ({
	organization: one(organizations, {
		fields: [sites.organizationId],
		references: [organizations.id]
	})
}));

export const peopleRelations = relations(people, ({ many }) => ({
	affiliations: many(affiliations)
}));

export const affiliationsRelations = relations(affiliations, ({ one }) => ({
	person: one(people, { fields: [affiliations.personId], references: [people.id] }),
	organization: one(organizations, {
		fields: [affiliations.organizationId],
		references: [organizations.id]
	}),
	site: one(sites, { fields: [affiliations.siteId], references: [sites.id] })
}));

export const programsRelations = relations(programs, ({ many }) => ({
	versions: many(programVersions)
}));

export const programVersionsRelations = relations(programVersions, ({ one }) => ({
	program: one(programs, { fields: [programVersions.programId], references: [programs.id] }),
	createdByUser: one(users, { fields: [programVersions.createdBy], references: [users.id] })
}));

export const productsRelations = relations(products, ({ one }) => ({
	vendor: one(organizations, {
		fields: [products.vendorOrganizationId],
		references: [organizations.id]
	})
}));
