/**
 * Взаимодействие с контрагентом и процесс, по которому оно идёт.
 *
 * Процесс живёт сам по себе, а пространство на него ссылается: в процессе
 * действует ровно одна редакция структуры, и взаимодействие ссылается на
 * пространство, а не на редакцию.
 * Прежние редакции остаются в базе — на их стадии ссылаются закрытые записи
 * истории. Текущая стадия — это открытая запись `stage_entries` (у неё пустой
 * `left_at`), отдельного поля-кэша нет: кэш пришлось бы синхронизировать, а
 * расходящийся кэш стадии — это неверный отчёт.
 */
import { relations, sql } from 'drizzle-orm';
import {
	bigint,
	boolean,
	check,
	date,
	doublePrecision,
	foreignKey,
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
import {
	DOCUMENT_TEMPLATE_KEYS,
	type DocumentMarkEvidence,
	type DocumentStatusFact,
	type DocumentTemplateKey
} from '$lib/contracts/documents';
import { CARD_PANELS, type CardPanel } from '$lib/contracts/process-card';
import type {
	ChecklistItem,
	ChecklistState,
	StageConfirmation,
	StageSnapshot
} from '$lib/contracts/interactions';
import {
	COMMENT_SOURCES,
	CONTRACT_STATUSES,
	EDIT_SOURCES,
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
	organizationKindEnum,
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
export const contractStatusEnum = pgEnum('contract_status', CONTRACT_STATUSES);
export const commentSourceEnum = pgEnum('comment_source', COMMENT_SOURCES);
export const editSourceEnum = pgEnum('edit_source', EDIT_SOURCES);

/**
 * Версия правки записи и автор этой версии.
 *
 * Целое число, а не момент изменения: `updated_at` двигают и события, которые
 * полей не трогают, а момент из PostgreSQL в `Date` теряет микросекунды —
 * сравнение по нему даёт и ложные отказы, и ложные совпадения. Версию сдвигают
 * только команды, которые переписывают защищённые поля
 * (`docs/workflow.md`, «Одновременная работа»); автор и момент — той самой
 * версии, чтобы отказ мог честно сказать, чью правку человек чуть не затёр.
 */
function editColumns() {
	return {
		editVersion: integer().notNull().default(1),
		editedBy: uuid().references(() => users.id, { onDelete: 'restrict' }),
		editedVia: editSourceEnum().notNull().default('system'),
		editedAt: timestamp({ withTimezone: true }).notNull().defaultNow()
	};
}

/** Автор-сотрудник есть ровно у правки сотрудника. */
function editedByMatchesSource(
	name: string,
	table: { editedBy: AnyPgColumn; editedVia: AnyPgColumn }
) {
	return check(name, sql`(${table.editedVia} = 'user') = (${table.editedBy} is not null)`);
}

/**
 * Пространство: рабочее место направления. Своё меню, свои взаимодействия,
 * свой процесс. Их два — `b2b` и `b2c`, — и добавить третье можно строкой.
 *
 * Работу описывает не оно, а назначенный ему процесс (`workflows`): на одном
 * процессе может стоять несколько пространств, и действующая редакция — его
 * свойство, а не свойство места.
 */
export const workspaces = pgTable(
	'workspaces',
	{
		id: uuid().primaryKey().defaultRandom(),
		key: text().notNull(),
		name: text().notNull(),
		description: text(),
		/**
		 * Процесс, по которому здесь работают. Допускает пустоту: пространство
		 * заводят раньше, чем описывают его работу, и «процесс не назначен» —
		 * рабочее состояние, которое доска объясняет словами. Требовать готовый
		 * процесс заранее значило бы запретить заводить пространство.
		 *
		 * `restrict`: процесс, назначенный хоть одному месту, не удаляется
		 * молча — сначала снимают назначение.
		 */
		workflowId: uuid().references((): AnyPgColumn => workflows.id, {
			onDelete: 'restrict'
		}),
		position: integer().notNull(),
		...timestamps
	},
	(table) => [
		unique('workspaces_key_key').on(table.key),
		unique('workspaces_position_key').on(table.position)
	]
);

/**
 * Членство сотрудника в пространстве: граница, внутри которой действует его
 * область доступа по назначениям и иерархии (`docs/access-matrix.md`, раздел 1).
 *
 * Строка — период, а не флаг, по образцу назначений ответственных
 * (`organization_responsibles`): исключение закрывает период (`valid_to`), а не
 * удаляет строку, поэтому на вопрос «кто видел работу направления в марте»
 * база отвечает без журнала. Действующее членство — строка с пустым `valid_to`,
 * и оно одно на пару «пространство × сотрудник»: это держит частичный
 * уникальный индекс, а не проверка в приложении, которая гоночна.
 *
 * Администратору членство не нужно: его область — всё, и в пространства его не
 * включают. Машинному субъекту обмена — тоже.
 */
export const workspaceMembers = pgTable(
	'workspace_members',
	{
		id: uuid().primaryKey().defaultRandom(),
		/**
		 * `cascade`: членство без пространства ничего не значит, а история
		 * доступа к удалённому направлению остаётся в журнале действий.
		 */
		workspaceId: uuid()
			.notNull()
			.references(() => workspaces.id, { onDelete: 'cascade' }),
		userId: uuid()
			.notNull()
			.references(() => users.id, { onDelete: 'restrict' }),
		validFrom: timestamp({ withTimezone: true }).notNull().defaultNow(),
		validTo: timestamp({ withTimezone: true }),
		/** Кто включил; пусто у строк миграции и сида. */
		grantedByUserId: uuid().references(() => users.id, { onDelete: 'set null' }),
		...timestamps
	},
	(table) => [
		uniqueIndex('workspace_members_active_key')
			.on(table.workspaceId, table.userId)
			.where(sql`${table.validTo} is null`),
		// Область доступа читает действующие членства сотрудника на каждом
		// запросе: индекс частичный, как и у назначений.
		index('workspace_members_user_idx')
			.on(table.userId)
			.where(sql`${table.validTo} is null`),
		check(
			'workspace_members_period_ordered',
			sql`${table.validTo} is null or ${table.validTo} > ${table.validFrom}`
		)
	]
);

/** Литерал массива строк для проверок по закрытому каталогу из контракта. */
function textArray(values: readonly string[]) {
	return sql.raw(`array[${values.map((value) => `'${value}'`).join(', ')}]::text[]`);
}

/**
 * Процесс: описание работы — стадии, переходы, нормативы, чек-листы, — живущее
 * само по себе.
 *
 * Вынесен из пространства, а не встроен в него, ради одного: один процесс можно
 * назначить нескольким пространствам. Два направления, работающих по одному
 * сценарию, — это два пространства и один процесс, а не две копии четырнадцати
 * стадий, которые разъедутся на первой же правке.
 *
 * Действующая редакция — свойство процесса, и вынесена в колонку, а не
 * выводится запросом «последняя опубликованная»: публикация обязана переключать
 * процесс одним значением, читаемым под блокировкой процесса, иначе переход и
 * публикация разойдутся на гонке. Блокировать при этом пространство, а не
 * процесс, значило бы пропустить гонку у процесса, назначенного двум местам.
 *
 * Состав карточки — панели и шаблоны документов — тоже свойство процесса, а не
 * редакции: это вид рабочего места, а не структура работы. Стадий он не
 * касается, переносить по нему нечего, и правка применяется сразу, без
 * черновика и публикации. Значения держит проверка по каталогу: неизвестная
 * панель в строке — это панель, которую карточка молча не нарисует. Новый
 * процесс получает весь каталог: карточка без панели, о которой администратор
 * ещё не знает, выглядела бы поломкой, а лишнее он снимет галочкой.
 */
export const workflows = pgTable(
	'workflows',
	{
		id: uuid().primaryKey().defaultRandom(),
		key: text().notNull(),
		name: text().notNull(),
		description: text(),
		activeRevisionId: uuid().references((): AnyPgColumn => processRevisions.id, {
			onDelete: 'restrict'
		}),
		cardPanels: text().array().$type<CardPanel[]>().notNull().default(textArray(CARD_PANELS)),
		documentTemplateKeys: text()
			.array()
			.$type<DocumentTemplateKey[]>()
			.notNull()
			.default(textArray(DOCUMENT_TEMPLATE_KEYS)),
		...timestamps
	},
	(table) => [
		unique('workflows_key_key').on(table.key),
		check('workflows_card_panels_known', sql`${table.cardPanels} <@ ${textArray(CARD_PANELS)}`),
		check(
			'workflows_document_template_keys_known',
			sql`${table.documentTemplateKeys} <@ ${textArray(DOCUMENT_TEMPLATE_KEYS)}`
		)
	]
);

/**
 * Маршруты приёма извне: в какое пространство попадает заявка с сайта от
 * контрагента такого вида.
 *
 * Только для приёма. Взаимодействие, заведённое руками, эту таблицу не
 * спрашивает: его заводят внутри пространства, и место известно из адреса. У
 * заявки человека нет, а адресат обязан быть однозначным — отсюда и первичный
 * ключ по виду: два маршрута на один вид означали бы, что одна и та же заявка
 * попадает то в одно место, то в другое. Проверка в приложении гоночна и не
 * переживает правку данных мимо приложения.
 *
 * Видов, которые заявителем не бывают (`customer_company`, `operator`), в
 * таблице нет вовсе.
 */
export const workspaceIntakeRoutes = pgTable(
	'workspace_intake_routes',
	{
		kind: organizationKindEnum().primaryKey(),
		workspaceId: uuid()
			.notNull()
			.references(() => workspaces.id, { onDelete: 'restrict' })
	},
	(table) => [index('workspace_intake_routes_workspace_idx').on(table.workspaceId)]
);

/**
 * Реестр ключей стадий процесса. Строка заводится при первом появлении ключа и
 * не удаляется никогда: идентичность стадии — пара «процесс + ключ», и
 * удалённый ключ обязан остаться занятым. Иначе под именем `signing` однажды
 * появилась бы стадия с другим смыслом, и лента карточки, отчёт и перенос
 * сопоставили бы по нему разные работы.
 *
 * Пара именно «процесс + ключ», а не «пространство + ключ»: если два
 * пространства работают по одному процессу, стадия `signing` в них — одна и та
 * же стадия, и отчёт по ним складывается.
 */
export const processStageKeys = pgTable(
	'process_stage_keys',
	{
		workflowId: uuid()
			.notNull()
			.references(() => workflows.id, { onDelete: 'cascade' }),
		key: text().notNull(),
		firstSeenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
		/** Ключ убрали из процесса; вернуть его с другим смыслом нельзя. */
		archivedAt: timestamp({ withTimezone: true })
	},
	(table) => [primaryKey({ columns: [table.workflowId, table.key] })]
);

/**
 * Редакция процесса: снимок структуры — стадии и переходы.
 *
 * Пока `published_at` пуст, редакция — черновик, и его правят; у процесса он
 * один, это держит частичная уникальность. Опубликованная редакция заморожена:
 * на её стадии ссылаются записи истории, и правка задним числом переписала бы
 * то, что видел исполнитель. Изменение процесса — новая редакция и миграция
 * незавершённых взаимодействий на неё.
 */
export const processRevisions = pgTable(
	'process_revisions',
	{
		id: uuid().primaryKey().defaultRandom(),
		workflowId: uuid()
			.notNull()
			.references((): AnyPgColumn => workflows.id, { onDelete: 'cascade' }),
		/** Номер редакции внутри процесса, с 1. Пользователь его не выбирает. */
		version: integer().notNull(),
		name: text().notNull(),
		/** Чем эта редакция отличается от предыдущей — словами автора черновика. */
		note: text(),
		publishedAt: timestamp({ withTimezone: true }),
		...timestamps
	},
	(table) => [
		unique('process_revisions_workflow_version_key').on(table.workflowId, table.version),
		// Два незаконченных описания одного процесса нечем свести: опубликуются
		// оба, и какое описывает работу, станет вопросом порядка нажатий.
		uniqueIndex('process_revisions_one_draft_per_workflow')
			.on(table.workflowId)
			.where(sql`${table.publishedAt} is null`)
	]
);

export const stages = pgTable(
	'stages',
	{
		id: uuid().primaryKey().defaultRandom(),
		revisionId: uuid()
			.notNull()
			.references(() => processRevisions.id, { onDelete: 'cascade' }),
		/** Порядковый номер в редакции, начиная с 1. */
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
		/** Стадия завершает процесс: с неё взаимодействие закрывают, а не идут дальше. */
		isFinal: boolean().notNull().default(false),
		/**
		 * Стадию подтверждают данными системы обучения: без факта по учебной
		 * группе движение дальше не разрешается.
		 */
		requiresLmsData: boolean().notNull().default(false),
		/**
		 * Отметка, которой по документу взаимодействия подтверждается стадия:
		 * `agreed`, `approved`, `in_effect`. Пусто — отметки не требуется.
		 *
		 * Одна колонка, а не jsonb со списком: стадия задаёт один вопрос
		 * («подписан ли документ»), и сравнение стадий при публикации читает
		 * параметр значением, а не разбором структуры.
		 */
		requiresDocumentMark: text().$type<DocumentStatusFact>(),
		checklist: jsonb().$type<ChecklistItem[]>().notNull().default([]),
		...timestamps
	},
	(table) => [
		unique('stages_revision_key_key').on(table.revisionId, table.key),
		unique('stages_revision_position_key').on(table.revisionId, table.position)
	]
);

export const stageTransitions = pgTable(
	'stage_transitions',
	{
		id: uuid().primaryKey().defaultRandom(),
		revisionId: uuid()
			.notNull()
			.references(() => processRevisions.id, { onDelete: 'cascade' }),
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

/**
 * Правила переноса записей при публикации: куда переехать взаимодействиям,
 * стоявшим на стадии, которой в новой редакции больше нет.
 *
 * Правило принадлежит редакции, а не группе: убрали стадию — сказали в этой же
 * публикации, куда девать тех, кто на ней стоял. Ключи, а не идентификаторы
 * стадий: стадия новой редакции — другая строка, а ключ тот же.
 */
export const stageMigrationRules = pgTable(
	'stage_migration_rules',
	{
		id: uuid().primaryKey().defaultRandom(),
		/** Редакция, в которой ключ исчез. */
		revisionId: uuid()
			.notNull()
			.references(() => processRevisions.id, { onDelete: 'cascade' }),
		removedStageKey: text().notNull(),
		targetStageKey: text().notNull(),
		...timestamps
	},
	(table) => [
		unique('stage_migration_rules_revision_key').on(table.revisionId, table.removedStageKey),
		check(
			'stage_migration_rules_keys_differ',
			sql`${table.removedStageKey} <> ${table.targetStageKey}`
		)
	]
);

/**
 * Договор с контрагентом. Принадлежит контрагенту, а не взаимодействию: один
 * договор обслуживает несколько взаимодействий, и привязка к записи процесса
 * означала бы копию договора на каждое.
 */
export const contracts = pgTable(
	'contracts',
	{
		id: uuid().primaryKey().defaultRandom(),
		organizationId: uuid()
			.notNull()
			.references(() => organizations.id, { onDelete: 'restrict' }),
		number: text().notNull(),
		signedOn: date(),
		validUntil: date(),
		status: contractStatusEnum().notNull().default('draft'),
		/** Одна версия на договор и все его позиции: их правят одним блоком карточки. */
		...editColumns(),
		...timestamps
	},
	(table) => [
		unique('contracts_organization_number_key').on(table.organizationId, table.number),
		index('contracts_organization_idx').on(table.organizationId),
		check(
			'contracts_period_ordered',
			sql`${table.validUntil} is null or ${table.signedOn} is null or ${table.validUntil} >= ${table.signedOn}`
		),
		editedByMatchesSource('contracts_edited_by_source', table)
	]
);

/**
 * Позиция договора: коммерческие условия по одному продукту.
 *
 * Источник истины о составе продуктов взаимодействия — `interaction_products`;
 * позиция добавляет к продукту сроки лицензии и статус передачи, но состав не
 * задаёт. Словарь `transfer_status` — свободный справочник до получения
 * каталога заказчика, поэтому текст, а не перечисление.
 */
export const contractItems = pgTable(
	'contract_items',
	{
		id: uuid().primaryKey().defaultRandom(),
		contractId: uuid()
			.notNull()
			.references(() => contracts.id, { onDelete: 'cascade' }),
		productId: uuid()
			.notNull()
			.references(() => products.id, { onDelete: 'restrict' }),
		licenseSignedAt: date(),
		licenseUntil: date(),
		transferStatus: text().notNull(),
		...timestamps
	},
	(table) => [
		unique('contract_items_contract_product_key').on(table.contractId, table.productId),
		// Цель ключа — не уникальность (она есть у первичного), а возможность
		// сослаться на пару «позиция + её договор»: так взаимодействие не выберет
		// позицию чужого договора.
		unique('contract_items_id_contract_key').on(table.id, table.contractId)
	]
);

export const interactions = pgTable(
	'interactions',
	{
		id: uuid().primaryKey().defaultRandom(),
		title: text().notNull(),
		/**
		 * Пространство, в котором идёт работа: по нему взаимодействие находит
		 * действующую редакцию. Выводится из вида основной стороны и меняется
		 * только вместе с ней; смена пространства у идущего взаимодействия — это
		 * начало другого процесса.
		 */
		workspaceId: uuid()
			.notNull()
			.references(() => workspaces.id, { onDelete: 'restrict' }),
		/** Договор, по которому идёт работа; позиции выбираются из него. */
		contractId: uuid().references((): AnyPgColumn => contracts.id, { onDelete: 'restrict' }),
		/**
		 * Последняя применённая ревизия источника заявки. Порядок сообщений не
		 * гарантирован ни очередью, ни сетью: сообщение с ревизией не больше
		 * применённой данных не меняет.
		 */
		externalRevision: bigint({ mode: 'number' }),
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
		...editColumns(),
		...externalRef,
		...timestamps
	},
	(table) => [
		editedByMatchesSource('interactions_edited_by_source', table),
		index('interactions_status_idx').on(table.status),
		index('interactions_workspace_status_idx').on(table.workspaceId, table.status),
		index('interactions_contract_idx').on(table.contractId),
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
		),
		// От основной стороны зависят и группа процесса, и область доступа:
		// вторая такая строка сделала бы обе величины зависящими от порядка строк.
		uniqueIndex('interaction_parties_one_primary')
			.on(table.interactionId)
			.where(sql`${table.isPrimary}`)
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
 * Позиции договора, выбранные этим взаимодействием. Принадлежность позиции
 * договору взаимодействия держит составной внешний ключ, а не проверка в
 * сервисе: иначе к записи прицепилась бы позиция чужого договора.
 */
export const interactionContractItems = pgTable(
	'interaction_contract_items',
	{
		interactionId: uuid()
			.notNull()
			.references(() => interactions.id, { onDelete: 'cascade' }),
		contractItemId: uuid().notNull(),
		contractId: uuid().notNull(),
		...createdAt
	},
	(table) => [
		primaryKey({ columns: [table.interactionId, table.contractItemId] }),
		foreignKey({
			name: 'interaction_contract_items_item_belongs_to_contract',
			columns: [table.contractItemId, table.contractId],
			foreignColumns: [contractItems.id, contractItems.contractId]
		}).onDelete('cascade')
	]
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
		/**
		 * Когда запись перенесли публикацией изменённого процесса. Заполнена
		 * только у переехавших: карточка показывает по ней предупреждение
		 * «стадия перенесена», пока запись открыта.
		 */
		migratedAt: timestamp({ withTimezone: true }),
		/** Ключ стадии, на которой запись стояла до переноса. */
		migratedFromStageKey: text(),
		/**
		 * Факты системы обучения, которыми подтверждена стадия: снимок того, что
		 * видел исполнитель. Форму задаёт контракт обмена.
		 */
		lmsEvidence: jsonb(),
		/**
		 * Отметка по документу, которой подтверждена стадия: снимок того, что
		 * видел исполнитель. Документ живёт своей жизнью — его заменяет новая
		 * редакция, его переименовывают, — а запись стадии обязана объяснять
		 * подтверждение и через год.
		 */
		documentMarkEvidence: jsonb().$type<DocumentMarkEvidence>(),
		...timestamps
	},
	(table) => [
		// Взаимодействие может стоять только на одной стадии одновременно.
		uniqueIndex('stage_entries_one_open_per_interaction')
			.on(table.interactionId)
			.where(sql`${table.leftAt} is null`),
		// Окно записи по одному взаимодействию: срез отчёта ищет запись, накрывшую
		// момент `T` (`entered_at < T` и `left_at is null or left_at >= T`), и по
		// той же паре столбцов считается момент закрытия записи. Порядок по входу
		// обратный: нужная запись — последняя из вошедших до `T`, и она находится
		// первой же строкой индекса, а `left_at` рядом отсекает не накрывшие.
		index('stage_entries_interaction_window_idx').on(
			table.interactionId,
			table.enteredAt.desc(),
			table.leftAt
		),
		// Отчёт на прошлую дату выбирает записи, чьё окно накрывает срез:
		// открытые (`left_at is null`) и закрытые позже него.
		index('stage_entries_window_idx').on(table.enteredAt, table.leftAt),
		// Движение за период отбирает записи по моменту ухода со стадии.
		index('stage_entries_left_at_idx').on(table.leftAt),
		// Индекс по ключу стадии из снимка (`stage_snapshot ->> 'key'`) объявлен
		// миграцией: индекс по выражению билдер Drizzle не выражает.
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
		// Паузы записи целиком: срез вычитает их пересечение с окном стадии на
		// момент `T`, и открытых среди них может не быть вовсе — частичный индекс
		// выше такому запросу не годится.
		index('stage_pauses_entry_idx').on(table.stageEntryId, table.startedAt),
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
		/**
		 * Откуда текст. Подписан комментарий заявки сотрудником, который принимает
		 * входящие, — по автору не отличить, а уничтожению персональных данных
		 * отличать обязательно: текст заявителя о себе оно стирает, текст
		 * сотрудника не трогает.
		 */
		source: commentSourceEnum().notNull().default('manual'),
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

export const workspacesRelations = relations(workspaces, ({ one, many }) => ({
	workflow: one(workflows, {
		fields: [workspaces.workflowId],
		references: [workflows.id]
	}),
	intakeRoutes: many(workspaceIntakeRoutes),
	interactions: many(interactions),
	members: many(workspaceMembers)
}));

export const workspaceMembersRelations = relations(workspaceMembers, ({ one }) => ({
	workspace: one(workspaces, {
		fields: [workspaceMembers.workspaceId],
		references: [workspaces.id]
	}),
	user: one(users, { fields: [workspaceMembers.userId], references: [users.id] })
}));

export const workflowsRelations = relations(workflows, ({ one, many }) => ({
	activeRevision: one(processRevisions, {
		fields: [workflows.activeRevisionId],
		references: [processRevisions.id]
	}),
	revisions: many(processRevisions),
	stageKeys: many(processStageKeys),
	workspaces: many(workspaces)
}));

export const workspaceIntakeRoutesRelations = relations(workspaceIntakeRoutes, ({ one }) => ({
	workspace: one(workspaces, {
		fields: [workspaceIntakeRoutes.workspaceId],
		references: [workspaces.id]
	})
}));

export const processStageKeysRelations = relations(processStageKeys, ({ one }) => ({
	workflow: one(workflows, {
		fields: [processStageKeys.workflowId],
		references: [workflows.id]
	})
}));

export const stageMigrationRulesRelations = relations(stageMigrationRules, ({ one }) => ({
	revision: one(processRevisions, {
		fields: [stageMigrationRules.revisionId],
		references: [processRevisions.id]
	})
}));

export const contractsRelations = relations(contracts, ({ one, many }) => ({
	organization: one(organizations, {
		fields: [contracts.organizationId],
		references: [organizations.id]
	}),
	items: many(contractItems),
	interactions: many(interactions)
}));

export const contractItemsRelations = relations(contractItems, ({ one }) => ({
	contract: one(contracts, { fields: [contractItems.contractId], references: [contracts.id] }),
	product: one(products, { fields: [contractItems.productId], references: [products.id] })
}));

export const interactionContractItemsRelations = relations(interactionContractItems, ({ one }) => ({
	interaction: one(interactions, {
		fields: [interactionContractItems.interactionId],
		references: [interactions.id]
	}),
	item: one(contractItems, {
		fields: [interactionContractItems.contractItemId],
		references: [contractItems.id]
	})
}));

export const processRevisionsRelations = relations(processRevisions, ({ one, many }) => ({
	workflow: one(workflows, {
		fields: [processRevisions.workflowId],
		references: [workflows.id]
	}),
	stages: many(stages),
	transitions: many(stageTransitions),
	migrationRules: many(stageMigrationRules)
}));

export const stagesRelations = relations(stages, ({ one, many }) => ({
	revision: one(processRevisions, {
		fields: [stages.revisionId],
		references: [processRevisions.id]
	}),
	entries: many(stageEntries)
}));

export const stageTransitionsRelations = relations(stageTransitions, ({ one }) => ({
	revision: one(processRevisions, {
		fields: [stageTransitions.revisionId],
		references: [processRevisions.id]
	}),
	fromStage: one(stages, { fields: [stageTransitions.fromStageId], references: [stages.id] }),
	toStage: one(stages, { fields: [stageTransitions.toStageId], references: [stages.id] }),
	requiredPermission: one(permissions, {
		fields: [stageTransitions.requiredPermissionKey],
		references: [permissions.key]
	})
}));

export const interactionsRelations = relations(interactions, ({ one, many }) => ({
	workspace: one(workspaces, {
		fields: [interactions.workspaceId],
		references: [workspaces.id]
	}),
	contract: one(contracts, { fields: [interactions.contractId], references: [contracts.id] }),
	contractItems: many(interactionContractItems),
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
