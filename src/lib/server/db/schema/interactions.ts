/**
 * Взаимодействие с учебным заведением и маршрут стадий, по которому оно идёт.
 *
 * Маршрут версионируется: опубликованную версию менять нельзя, а взаимодействие
 * ссылается на конкретную версию. Текущая стадия — это открытая запись
 * `stage_entries` (у неё пустой `left_at`), отдельного поля-кэша нет: кэш
 * пришлось бы синхронизировать, а расходящийся кэш стадии — это неверный отчёт.
 */
import { relations, sql } from 'drizzle-orm';
import {
	boolean,
	check,
	date,
	doublePrecision,
	index,
	integer,
	jsonb,
	pgEnum,
	pgTable,
	pgView,
	primaryKey,
	text,
	timestamp,
	unique,
	uniqueIndex,
	uuid,
	type AnyPgColumn
} from 'drizzle-orm/pg-core';
import type {
	ChecklistItem,
	ChecklistState,
	StageConfirmation,
	StageSnapshot
} from '$lib/contracts/interactions';
import {
	INTERACTION_STATUSES,
	PARTY_ROLES,
	PAUSE_REASONS,
	STAGE_CATEGORIES,
	STAGE_OUTCOMES,
	STAGE_TRANSITION_KINDS
} from '$lib/contracts/interactions';
import { permissions, users } from './auth';
import { documents } from './documents';
import {
	affiliations,
	organizations,
	products,
	programs,
	programVersions,
	sites
} from './directory';
import { createdAt, externalRef, externalRefUnique, timestamps } from './shared';

export const stageCategoryEnum = pgEnum('stage_category', STAGE_CATEGORIES);
export const stageTransitionKindEnum = pgEnum('stage_transition_kind', STAGE_TRANSITION_KINDS);
export const interactionStatusEnum = pgEnum('interaction_status', INTERACTION_STATUSES);
export const partyRoleEnum = pgEnum('party_role', PARTY_ROLES);
export const stageOutcomeEnum = pgEnum('stage_outcome', STAGE_OUTCOMES);
export const pauseReasonEnum = pgEnum('pause_reason', PAUSE_REASONS);

/**
 * Версия маршрута стадий. Пока `published_at` пуст, маршрут — черновик и его
 * можно править; после публикации он заморожен, а изменения оформляются новой
 * версией с тем же ключом. Правило соблюдает сервис: база хранит только факт.
 */
export const stageRoutes = pgTable(
	'stage_routes',
	{
		id: uuid().primaryKey().defaultRandom(),
		/** Устойчивое имя маршрута; версии одного маршрута делят ключ. */
		key: text().notNull(),
		version: integer().notNull(),
		name: text().notNull(),
		description: text(),
		/** Маршрут, который предлагается для новых взаимодействий. */
		isDefault: boolean().notNull().default(false),
		publishedAt: timestamp({ withTimezone: true }),
		...timestamps
	},
	(table) => [unique('stage_routes_key_version_key').on(table.key, table.version)]
);

export const stages = pgTable(
	'stages',
	{
		id: uuid().primaryKey().defaultRandom(),
		routeId: uuid()
			.notNull()
			.references(() => stageRoutes.id, { onDelete: 'cascade' }),
		/** Порядковый номер в маршруте, начиная с 1. */
		position: integer().notNull(),
		key: text().notNull(),
		name: text().notNull(),
		category: stageCategoryEnum().notNull(),
		/** Норматив стадии в днях; из него считается срок в `stage_entry_status`. */
		slaDays: integer().notNull(),
		/** Через сколько дней без событий стадия считается протухшей. */
		staleAfterDays: integer(),
		requiresResult: boolean().notNull().default(false),
		requiresConfirmation: boolean().notNull().default(false),
		checklist: jsonb().$type<ChecklistItem[]>().notNull().default([]),
		...timestamps
	},
	(table) => [
		unique('stages_route_key_key').on(table.routeId, table.key),
		unique('stages_route_position_key').on(table.routeId, table.position)
	]
);

export const stageTransitions = pgTable(
	'stage_transitions',
	{
		id: uuid().primaryKey().defaultRandom(),
		routeId: uuid()
			.notNull()
			.references(() => stageRoutes.id, { onDelete: 'cascade' }),
		fromStageId: uuid()
			.notNull()
			.references(() => stages.id, { onDelete: 'cascade' }),
		toStageId: uuid()
			.notNull()
			.references(() => stages.id, { onDelete: 'cascade' }),
		kind: stageTransitionKindEnum().notNull(),
		/** Право, без которого переход недоступен. */
		requiredPermissionKey: text()
			.notNull()
			.references(() => permissions.key, { onDelete: 'restrict' }),
		requiresReason: boolean().notNull().default(false),
		...timestamps
	},
	(table) => [unique('stage_transitions_from_to_key').on(table.fromStageId, table.toStageId)]
);

export const interactions = pgTable(
	'interactions',
	{
		id: uuid().primaryKey().defaultRandom(),
		title: text().notNull(),
		/** Конкретная версия маршрута, по которой идёт это взаимодействие. */
		routeId: uuid()
			.notNull()
			.references(() => stageRoutes.id, { onDelete: 'restrict' }),
		status: interactionStatusEnum().notNull().default('active'),
		/** Срок действия договора или соглашения. */
		agreementPeriodStart: date(),
		agreementPeriodEnd: date(),
		/** Учебный период, к которому относится взаимодействие. */
		academicPeriodStart: date(),
		academicPeriodEnd: date(),
		ownerUserId: uuid()
			.notNull()
			.references(() => users.id, { onDelete: 'restrict' }),
		/**
		 * Момент последнего события по взаимодействию. Обновляют сервисы; по
		 * нему считается протухание, потому что оно про тишину вокруг записи,
		 * а не про часы на стадии.
		 */
		lastActivityAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
		...externalRef,
		...timestamps
	},
	(table) => [
		index('interactions_status_idx').on(table.status),
		index('interactions_owner_idx').on(table.ownerUserId),
		index('interactions_last_activity_idx').on(table.lastActivityAt),
		externalRefUnique('interactions_external_ref_key', table)
	]
);

export const interactionParties = pgTable(
	'interaction_parties',
	{
		id: uuid().primaryKey().defaultRandom(),
		interactionId: uuid()
			.notNull()
			.references(() => interactions.id, { onDelete: 'cascade' }),
		organizationId: uuid()
			.notNull()
			.references(() => organizations.id, { onDelete: 'restrict' }),
		partyRole: partyRoleEnum().notNull(),
		/** Основная сторона: с ней ведётся процесс. */
		isPrimary: boolean().notNull().default(false),
		/** Контактное лицо участника — одна из его ролей в организации. */
		contactAffiliationId: uuid().references(() => affiliations.id, { onDelete: 'set null' }),
		...timestamps
	},
	(table) => [
		unique('interaction_parties_interaction_organization_key').on(
			table.interactionId,
			table.organizationId
		)
	]
);

export const interactionPartySites = pgTable(
	'interaction_party_sites',
	{
		partyId: uuid()
			.notNull()
			.references(() => interactionParties.id, { onDelete: 'cascade' }),
		siteId: uuid()
			.notNull()
			.references(() => sites.id, { onDelete: 'cascade' }),
		...createdAt
	},
	(table) => [primaryKey({ columns: [table.partyId, table.siteId] })]
);

export const interactionPrograms = pgTable(
	'interaction_programs',
	{
		interactionId: uuid()
			.notNull()
			.references(() => interactions.id, { onDelete: 'cascade' }),
		programId: uuid()
			.notNull()
			.references(() => programs.id, { onDelete: 'restrict' }),
		/** Конкретная версия программы, если взаимодействие привязано к ней. */
		programVersionId: uuid().references(() => programVersions.id, { onDelete: 'set null' }),
		...createdAt
	},
	(table) => [primaryKey({ columns: [table.interactionId, table.programId] })]
);

export const interactionProducts = pgTable(
	'interaction_products',
	{
		interactionId: uuid()
			.notNull()
			.references(() => interactions.id, { onDelete: 'cascade' }),
		productId: uuid()
			.notNull()
			.references(() => products.id, { onDelete: 'restrict' }),
		...createdAt
	},
	(table) => [primaryKey({ columns: [table.interactionId, table.productId] })]
);

/**
 * Предметная история изменений плана: сроки, стороны, программы, ответственный.
 * Это не журнал действий — здесь лежит то, что показывают в карточке
 * взаимодействия рядом с полем, а не то, что читает служба безопасности.
 */
export const interactionChanges = pgTable(
	'interaction_changes',
	{
		id: uuid().primaryKey().defaultRandom(),
		interactionId: uuid()
			.notNull()
			.references(() => interactions.id, { onDelete: 'cascade' }),
		changedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
		authorId: uuid()
			.notNull()
			.references(() => users.id, { onDelete: 'restrict' }),
		/** Имя поля в терминах контракта, а не столбца базы. */
		field: text().notNull(),
		oldValue: jsonb(),
		newValue: jsonb(),
		reason: text()
	},
	(table) => [index('interaction_changes_interaction_idx').on(table.interactionId, table.changedAt)]
);

export const stageEntries = pgTable(
	'stage_entries',
	{
		id: uuid().primaryKey().defaultRandom(),
		interactionId: uuid()
			.notNull()
			.references(() => interactions.id, { onDelete: 'cascade' }),
		stageId: uuid()
			.notNull()
			.references(() => stages.id, { onDelete: 'restrict' }),
		/**
		 * Слепок стадии на момент входа. Маршрут может быть переиздан, а сроки
		 * и чек-лист уже пройденной стадии обязаны остаться такими, какими их
		 * видел исполнитель.
		 */
		stageSnapshot: jsonb().$type<StageSnapshot>().notNull(),
		enteredAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
		leftAt: timestamp({ withTimezone: true }),
		outcome: stageOutcomeEnum(),
		outcomeReason: text(),
		responsibleUserId: uuid().references(() => users.id, { onDelete: 'set null' }),
		/** Кого ждём — участник этого же взаимодействия. */
		waitingPartyId: uuid().references(() => interactionParties.id, { onDelete: 'set null' }),
		resultText: text(),
		confirmation: jsonb().$type<StageConfirmation>(),
		/**
		 * Дубль `documentId` из `confirmation` ради внешнего ключа: внутри jsonb
		 * ссылочную целостность база не проверяет.
		 */
		confirmationDocumentId: uuid().references((): AnyPgColumn => documents.id, {
			onDelete: 'set null'
		}),
		confirmedAt: timestamp({ withTimezone: true }),
		confirmedBy: uuid().references(() => users.id, { onDelete: 'set null' }),
		/** Отметки по чек-листу: ключ пункта → выполнен или нет. */
		checklistState: jsonb().$type<ChecklistState>().notNull().default({}),
		...timestamps
	},
	(table) => [
		// Взаимодействие может стоять только на одной стадии одновременно.
		uniqueIndex('stage_entries_one_open_per_interaction')
			.on(table.interactionId)
			.where(sql`${table.leftAt} is null`),
		index('stage_entries_interaction_idx').on(table.interactionId, table.enteredAt),
		check(
			'stage_entries_left_after_entered',
			sql`${table.leftAt} is null or ${table.leftAt} >= ${table.enteredAt}`
		)
	]
);

/**
 * Пауза на стадии. Пока она открыта, часы норматива стоят: ждать ответа вуза
 * и не успеть — разные вещи, и отчёт обязан их различать.
 */
export const stagePauses = pgTable(
	'stage_pauses',
	{
		id: uuid().primaryKey().defaultRandom(),
		stageEntryId: uuid()
			.notNull()
			.references(() => stageEntries.id, { onDelete: 'cascade' }),
		reason: pauseReasonEnum().notNull(),
		waitingPartyId: uuid().references(() => interactionParties.id, { onDelete: 'set null' }),
		nextAction: text(),
		note: text().notNull(),
		startedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
		endedAt: timestamp({ withTimezone: true }),
		...timestamps
	},
	(table) => [
		uniqueIndex('stage_pauses_one_open_per_entry')
			.on(table.stageEntryId)
			.where(sql`${table.endedAt} is null`),
		check('stage_pauses_ended_after_started', sql`${table.endedAt} > ${table.startedAt}`)
	]
);

export const blockers = pgTable(
	'blockers',
	{
		id: uuid().primaryKey().defaultRandom(),
		interactionId: uuid()
			.notNull()
			.references(() => interactions.id, { onDelete: 'cascade' }),
		stageEntryId: uuid().references(() => stageEntries.id, { onDelete: 'set null' }),
		/** Код причины из настраиваемого справочника. */
		reasonCode: text().notNull(),
		description: text().notNull(),
		/** Блокирующая проблема запрещает переход на следующую стадию. */
		blocksTransition: boolean().notNull().default(true),
		raisedBy: uuid()
			.notNull()
			.references(() => users.id, { onDelete: 'restrict' }),
		assigneeUserId: uuid().references(() => users.id, { onDelete: 'set null' }),
		raisedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
		resolvedAt: timestamp({ withTimezone: true }),
		resolvedBy: uuid().references(() => users.id, { onDelete: 'set null' }),
		resolution: text(),
		...timestamps
	},
	(table) => [index('blockers_interaction_idx').on(table.interactionId, table.raisedAt)]
);

export const comments = pgTable(
	'comments',
	{
		id: uuid().primaryKey().defaultRandom(),
		interactionId: uuid()
			.notNull()
			.references(() => interactions.id, { onDelete: 'cascade' }),
		authorId: uuid()
			.notNull()
			.references(() => users.id, { onDelete: 'restrict' }),
		body: text().notNull(),
		...timestamps
	},
	(table) => [index('comments_interaction_idx').on(table.interactionId, table.createdAt)]
);

/**
 * Срок стадии с учётом пауз. Представление создаётся в миграции (`.existing()`
 * означает «Drizzle про него знает, но не управляет им»): вычисления опираются
 * на пересечение интервалов, а это SQL, а не ORM.
 *
 * Окно записи — от входа на стадию до `left_at`, а у открытой записи до `now()`.
 * `paused_seconds` — суммарная длина пересечения пауз с этим окном, `due_at`
 * сдвигается ровно на неё. Закрытая запись «не едет»: её окно больше не растёт.
 */
export const stageEntryStatus = pgView('stage_entry_status', {
	stageEntryId: uuid().notNull(),
	interactionId: uuid().notNull(),
	stageId: uuid().notNull(),
	enteredAt: timestamp({ withTimezone: true }).notNull(),
	leftAt: timestamp({ withTimezone: true }),
	/** Правая граница окна: `left_at` у закрытой записи, `now()` у открытой. */
	windowEnd: timestamp({ withTimezone: true }).notNull(),
	slaDays: integer().notNull(),
	pausedSeconds: doublePrecision().notNull(),
	activeSeconds: doublePrecision().notNull(),
	dueAt: timestamp({ withTimezone: true }).notNull(),
	isPaused: boolean().notNull(),
	/** Может быть отрицательным: столько времени уже просрочено. */
	remainingSeconds: doublePrecision().notNull(),
	overdueSeconds: doublePrecision().notNull(),
	isOverdue: boolean().notNull()
}).existing();

export const stageRoutesRelations = relations(stageRoutes, ({ many }) => ({
	stages: many(stages),
	transitions: many(stageTransitions),
	interactions: many(interactions)
}));

export const stagesRelations = relations(stages, ({ one, many }) => ({
	route: one(stageRoutes, { fields: [stages.routeId], references: [stageRoutes.id] }),
	entries: many(stageEntries)
}));

export const stageTransitionsRelations = relations(stageTransitions, ({ one }) => ({
	route: one(stageRoutes, { fields: [stageTransitions.routeId], references: [stageRoutes.id] }),
	fromStage: one(stages, { fields: [stageTransitions.fromStageId], references: [stages.id] }),
	toStage: one(stages, { fields: [stageTransitions.toStageId], references: [stages.id] }),
	requiredPermission: one(permissions, {
		fields: [stageTransitions.requiredPermissionKey],
		references: [permissions.key]
	})
}));

export const interactionsRelations = relations(interactions, ({ one, many }) => ({
	route: one(stageRoutes, { fields: [interactions.routeId], references: [stageRoutes.id] }),
	owner: one(users, { fields: [interactions.ownerUserId], references: [users.id] }),
	parties: many(interactionParties),
	programs: many(interactionPrograms),
	products: many(interactionProducts),
	changes: many(interactionChanges),
	stageEntries: many(stageEntries),
	blockers: many(blockers),
	comments: many(comments)
}));

export const interactionPartiesRelations = relations(interactionParties, ({ one, many }) => ({
	interaction: one(interactions, {
		fields: [interactionParties.interactionId],
		references: [interactions.id]
	}),
	organization: one(organizations, {
		fields: [interactionParties.organizationId],
		references: [organizations.id]
	}),
	contact: one(affiliations, {
		fields: [interactionParties.contactAffiliationId],
		references: [affiliations.id]
	}),
	sites: many(interactionPartySites)
}));

export const interactionPartySitesRelations = relations(interactionPartySites, ({ one }) => ({
	party: one(interactionParties, {
		fields: [interactionPartySites.partyId],
		references: [interactionParties.id]
	}),
	site: one(sites, { fields: [interactionPartySites.siteId], references: [sites.id] })
}));

export const interactionProgramsRelations = relations(interactionPrograms, ({ one }) => ({
	interaction: one(interactions, {
		fields: [interactionPrograms.interactionId],
		references: [interactions.id]
	}),
	program: one(programs, { fields: [interactionPrograms.programId], references: [programs.id] }),
	programVersion: one(programVersions, {
		fields: [interactionPrograms.programVersionId],
		references: [programVersions.id]
	})
}));

export const interactionProductsRelations = relations(interactionProducts, ({ one }) => ({
	interaction: one(interactions, {
		fields: [interactionProducts.interactionId],
		references: [interactions.id]
	}),
	product: one(products, { fields: [interactionProducts.productId], references: [products.id] })
}));

export const interactionChangesRelations = relations(interactionChanges, ({ one }) => ({
	interaction: one(interactions, {
		fields: [interactionChanges.interactionId],
		references: [interactions.id]
	}),
	author: one(users, { fields: [interactionChanges.authorId], references: [users.id] })
}));

export const stageEntriesRelations = relations(stageEntries, ({ one, many }) => ({
	interaction: one(interactions, {
		fields: [stageEntries.interactionId],
		references: [interactions.id]
	}),
	stage: one(stages, { fields: [stageEntries.stageId], references: [stages.id] }),
	responsible: one(users, { fields: [stageEntries.responsibleUserId], references: [users.id] }),
	waitingParty: one(interactionParties, {
		fields: [stageEntries.waitingPartyId],
		references: [interactionParties.id]
	}),
	pauses: many(stagePauses)
}));

export const stagePausesRelations = relations(stagePauses, ({ one }) => ({
	stageEntry: one(stageEntries, {
		fields: [stagePauses.stageEntryId],
		references: [stageEntries.id]
	}),
	waitingParty: one(interactionParties, {
		fields: [stagePauses.waitingPartyId],
		references: [interactionParties.id]
	})
}));

export const blockersRelations = relations(blockers, ({ one }) => ({
	interaction: one(interactions, {
		fields: [blockers.interactionId],
		references: [interactions.id]
	}),
	stageEntry: one(stageEntries, { fields: [blockers.stageEntryId], references: [stageEntries.id] }),
	raisedByUser: one(users, { fields: [blockers.raisedBy], references: [users.id] }),
	assignee: one(users, { fields: [blockers.assigneeUserId], references: [users.id] })
}));

export const commentsRelations = relations(comments, ({ one }) => ({
	interaction: one(interactions, {
		fields: [comments.interactionId],
		references: [interactions.id]
	}),
	author: one(users, { fields: [comments.authorId], references: [users.id] })
}));
