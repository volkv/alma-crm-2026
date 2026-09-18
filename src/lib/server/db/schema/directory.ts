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
	index,
	integer,
	pgEnum,
	pgTable,
	primaryKey,
	text,
	timestamp,
	unique,
	uniqueIndex,
	uuid,
	type AnyPgColumn
} from 'drizzle-orm/pg-core';
import {
	AFFILIATION_ROLE_KINDS,
	CONSENT_BASES,
	EDUCATION_LEVELS,
	LIFECYCLE_STATUSES,
	ORGANIZATION_KINDS,
	PROGRAM_LEVELS,
	SITE_KINDS
} from '$lib/contracts/directory';
import { users } from './auth';
import { createdAt, externalRef, externalRefUnique, timestamps } from './shared';

export const organizationKindEnum = pgEnum('organization_kind', ORGANIZATION_KINDS);
export const educationLevelEnum = pgEnum('education_level', EDUCATION_LEVELS);
export const siteKindEnum = pgEnum('site_kind', SITE_KINDS);
export const affiliationRoleKindEnum = pgEnum('affiliation_role_kind', AFFILIATION_ROLE_KINDS);
export const programLevelEnum = pgEnum('program_level', PROGRAM_LEVELS);
export const lifecycleStatusEnum = pgEnum('lifecycle_status', LIFECYCLE_STATUSES);
export const consentBasisEnum = pgEnum('consent_basis', CONSENT_BASES);

/**
 * ИТ-направление, по которому идёт работа: DevOps, тестирование, аналитика.
 *
 * Это не код направления подготовки ФГОС (`programs.direction_code`), а разрез
 * продуктов и ответственности: по направлению назначают ответственного за вуз и
 * по нему же собирают отчёт. Позиция задаёт порядок в списках и подсказках —
 * алфавит здесь не помогает, у направлений есть свой порядок значимости.
 */
export const directions = pgTable(
	'directions',
	{
		id: uuid().primaryKey().defaultRandom(),
		code: text().notNull(),
		name: text().notNull(),
		position: integer().notNull(),
		/**
		 * Направление, по которому больше не работают, уходит в архив, а не
		 * удаляется: на него ссылаются назначения ответственных, продукты и
		 * программы, и «такого направления у нас никогда не было» — неправда.
		 */
		isActive: boolean().notNull().default(true),
		...timestamps
	},
	(table) => [
		unique('directions_code_key').on(table.code),
		unique('directions_position_key').on(table.position)
	]
);

export const organizations = pgTable(
	'organizations',
	{
		id: uuid().primaryKey().defaultRandom(),
		kind: organizationKindEnum().notNull(),
		/** Заполнен ровно у учебных заведений — это же проверяет CHECK ниже. */
		educationLevel: educationLevelEnum(),
		/**
		 * Человек, которым является этот контрагент. Заполнен ровно у вида
		 * `individual` — это же проверяет CHECK ниже.
		 *
		 * Физическое лицо живёт строкой организации, а не отдельной таблицей
		 * контрагентов: так ФИО, контакты, согласия, срок хранения и
		 * обезличивание остаются в единственном контуре персональных данных, а
		 * все внешние ключи на организацию продолжают работать. `restrict` —
		 * потому что удалить человека, который сам является стороной
		 * взаимодействий, значило бы оставить их без контрагента.
		 */
		personId: uuid()
			.unique('organizations_person_key')
			.references((): AnyPgColumn => people.id, { onDelete: 'restrict' }),
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
		),
		// Физлицо без человека — контрагент без имени; человек у вуза — лишняя
		// связь, по которой обезличивание однажды дошло бы до организации.
		check(
			'organizations_person_matches_kind',
			sql`(${table.personId} is not null) = (${table.kind} = 'individual')`
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

export const people = pgTable(
	'people',
	{
		id: uuid().primaryKey().defaultRandom(),
		lastName: text().notNull(),
		firstName: text().notNull(),
		middleName: text(),
		/**
		 * Контакты — персональные данные. В базе они лежат шифртекстом
		 * (`enc:v1:…`, AES-256-GCM), наружу их отдаёт только сериализатор, а
		 * кладёт и расшифровывает только `src/lib/server/people/pii.ts`.
		 */
		email: text(),
		phone: text(),
		/**
		 * Ключи сравнения контактов: HMAC-SHA256 по нормализованному значению.
		 * Шифртекст у одного и того же адреса каждый раз разный — сравнивать по
		 * нему нельзя, — поэтому дедупликация заявок и импорта и поиск по точному
		 * контакту идут по этим колонкам. Считает их тот же `people/pii.ts`.
		 */
		emailHash: text(),
		phoneHash: text(),
		notes: text(),
		/**
		 * До какого дня хранятся персональные данные этого человека. `null` —
		 * срок не назначен: назначает его человек, а не умолчание.
		 */
		retentionUntil: date(),
		/**
		 * Когда данные уничтожили обезличиванием. Строка остаётся — на неё
		 * ссылаются роли и взаимодействия, — но персональных данных в ней больше
		 * нет, и обратного хода у этого нет тоже.
		 */
		anonymizedAt: timestamp({ withTimezone: true }),
		...timestamps
	},
	(table) => [
		// Не уникальные: один и тот же адрес бывает у двух записей — контакт вуза
		// и он же заявитель с сайта, — и разводит их организация, а не почта.
		index('people_email_hash_idx').on(table.emailHash),
		index('people_phone_hash_idx').on(table.phoneHash)
	]
);

/**
 * Согласия на обработку персональных данных.
 *
 * Согласие — не галочка на карточке, а запись: у него есть основание, версия
 * текста, дата получения и, возможно, дата отзыва. Отозванное согласие не
 * удаляется, иначе на вопрос «на каком основании данные лежали до отзыва»
 * ответить будет нечем.
 */
export const consents = pgTable(
	'consents',
	{
		id: uuid().primaryKey().defaultRandom(),
		personId: uuid()
			.notNull()
			.references(() => people.id, { onDelete: 'cascade' }),
		basis: consentBasisEnum().notNull(),
		/** Версия текста, под которым человек подписался: `2026-09-01`, `v3`. */
		textVersion: text().notNull(),
		givenAt: date().notNull(),
		withdrawnAt: date(),
		withdrawnBy: uuid().references(() => users.id, { onDelete: 'set null' }),
		recordedBy: uuid().references(() => users.id, { onDelete: 'set null' }),
		...timestamps
	},
	(table) => [
		check(
			'consents_withdrawal_ordered',
			sql`${table.withdrawnAt} is null or ${table.withdrawnAt} >= ${table.givenAt}`
		),
		// Автор отзыва без самого отзыва — запись ни о чём. Обратное допустимо:
		// внешний ключ на учётную запись гасится при её удалении.
		check(
			'consents_withdrawn_by_requires_withdrawal',
			sql`${table.withdrawnBy} is null or ${table.withdrawnAt} is not null`
		)
	]
);

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

/**
 * Кто отвечает за вуз и за какое направление в заданный период.
 *
 * Назначения не удаляются, а закрываются точной меткой времени: две смены
 * ответственного за один день обязаны выстроиться в историю, иначе отчёт за
 * прошлый период не сможет сказать, кто вёл вуз тогда. Отсюда же
 * `timestamptz`, а не `date`.
 *
 * `direction_id is null` — общее назначение на весь вуз. Правило «общее
 * назначение и назначения по направлениям на одном вузе не сосуществуют»
 * уникальным индексом не выражается (`null` и значение — разные ключи) и
 * держится сервисом назначений — под блокировкой строки вуза, иначе два
 * одновременных назначения прошли бы оба.
 */
export const organizationResponsibles = pgTable(
	'organization_responsibles',
	{
		id: uuid().primaryKey().defaultRandom(),
		organizationId: uuid()
			.notNull()
			.references(() => organizations.id, { onDelete: 'cascade' }),
		userId: uuid()
			.notNull()
			.references(() => users.id, { onDelete: 'restrict' }),
		/** Направление назначения; `null` — ответственный за вуз целиком. */
		directionId: uuid().references(() => directions.id, { onDelete: 'restrict' }),
		validFrom: timestamp({ withTimezone: true }).notNull().defaultNow(),
		validTo: timestamp({ withTimezone: true }),
		assignedByUserId: uuid().references(() => users.id, { onDelete: 'set null' }),
		...timestamps
	},
	(table) => [
		// Область доступа читает действующие назначения подзапросом на каждой
		// выборке, поэтому оба индекса — частичные по `valid_to is null`.
		index('organization_responsibles_organization_idx')
			.on(table.organizationId, table.userId)
			.where(sql`${table.validTo} is null`),
		index('organization_responsibles_user_idx')
			.on(table.userId)
			.where(sql`${table.validTo} is null`),
		check(
			'organization_responsibles_period_ordered',
			sql`${table.validTo} is null or ${table.validTo} > ${table.validFrom}`
		)
		// Уникальность «один действующий ответственный на вуз × направление»
		// объявлена миграцией: ей нужен NULLS NOT DISTINCT, которого билдер
		// индексов Drizzle не выражает. См. `docs/data-model.md`.
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
		/** ИТ-направление продукта — разрез ответственности, а не код ФГОС. */
		directionId: uuid().references(() => directions.id, { onDelete: 'restrict' }),
		/**
		 * Ручной приоритет показа: 1 — самая важная программа. `null` означает
		 * «приоритет не назначен», а не нулевую важность, поэтому такие программы
		 * идут в списке после всех, кому его проставили.
		 */
		priority: integer(),
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

/**
 * Направления продукта. Их бывает несколько: один продукт закрывает и DevOps,
 * и администрирование, и делить его надвое ради разреза отчёта — значит
 * заводить два продукта там, где заказчик видит один.
 */
export const productDirections = pgTable(
	'product_directions',
	{
		productId: uuid()
			.notNull()
			.references(() => products.id, { onDelete: 'cascade' }),
		directionId: uuid()
			.notNull()
			.references(() => directions.id, { onDelete: 'restrict' }),
		...createdAt
	},
	(table) => [
		primaryKey({ columns: [table.productId, table.directionId] }),
		index('product_directions_direction_idx').on(table.directionId)
	]
);

export const organizationsRelations = relations(organizations, ({ many, one }) => ({
	sites: many(sites),
	affiliations: many(affiliations),
	products: many(products),
	responsibles: many(organizationResponsibles),
	person: one(people, { fields: [organizations.personId], references: [people.id] })
}));

export const sitesRelations = relations(sites, ({ one }) => ({
	organization: one(organizations, {
		fields: [sites.organizationId],
		references: [organizations.id]
	})
}));

export const peopleRelations = relations(people, ({ many }) => ({
	affiliations: many(affiliations),
	consents: many(consents)
}));

export const consentsRelations = relations(consents, ({ one }) => ({
	person: one(people, { fields: [consents.personId], references: [people.id] })
}));

export const affiliationsRelations = relations(affiliations, ({ one }) => ({
	person: one(people, { fields: [affiliations.personId], references: [people.id] }),
	organization: one(organizations, {
		fields: [affiliations.organizationId],
		references: [organizations.id]
	}),
	site: one(sites, { fields: [affiliations.siteId], references: [sites.id] })
}));

export const directionsRelations = relations(directions, ({ many }) => ({
	programs: many(programs),
	products: many(productDirections),
	responsibles: many(organizationResponsibles)
}));

export const organizationResponsiblesRelations = relations(organizationResponsibles, ({ one }) => ({
	organization: one(organizations, {
		fields: [organizationResponsibles.organizationId],
		references: [organizations.id]
	}),
	user: one(users, { fields: [organizationResponsibles.userId], references: [users.id] }),
	direction: one(directions, {
		fields: [organizationResponsibles.directionId],
		references: [directions.id]
	}),
	assignedBy: one(users, {
		fields: [organizationResponsibles.assignedByUserId],
		references: [users.id]
	})
}));

export const productDirectionsRelations = relations(productDirections, ({ one }) => ({
	product: one(products, { fields: [productDirections.productId], references: [products.id] }),
	direction: one(directions, {
		fields: [productDirections.directionId],
		references: [directions.id]
	})
}));

export const programsRelations = relations(programs, ({ many, one }) => ({
	direction: one(directions, { fields: [programs.directionId], references: [directions.id] }),
	versions: many(programVersions)
}));

export const programVersionsRelations = relations(programVersions, ({ one }) => ({
	program: one(programs, { fields: [programVersions.programId], references: [programs.id] }),
	createdByUser: one(users, { fields: [programVersions.createdBy], references: [users.id] })
}));

export const productsRelations = relations(products, ({ one, many }) => ({
	vendor: one(organizations, {
		fields: [products.vendorOrganizationId],
		references: [organizations.id]
	}),
	directions: many(productDirections)
}));
