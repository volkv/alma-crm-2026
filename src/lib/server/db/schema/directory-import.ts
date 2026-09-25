/**
 * Импорт каталога: загрузка целиком и её строки.
 *
 * Импорт справочника отличается от импорта данных об обучении тем, что его
 * результат живёт **не здесь**: организации, продукты, направления, договоры и
 * их позиции лежат в своих таблицах и после подтверждения ничем не отличаются
 * от заведённых руками. Эти две таблицы отвечают на другой вопрос — «откуда в
 * справочнике взялась эта строка и что именно импорт с ней сделал»: какой файл,
 * какое сопоставление колонок, какое действие вышло у каждой строки и какие
 * поля она поменяла.
 *
 * Поэтому строки не удаляются вместе с применением и не становятся частью
 * справочника: это журнал загрузки, а не её копия. Ссылки на заведённые записи
 * (`organization_id`, `product_id`, `contract_id`, `contract_item_id`)
 * проставляются подтверждением и гасятся, если запись потом удалят.
 */
import { sql } from 'drizzle-orm';
import {
	check,
	date,
	index,
	integer,
	jsonb,
	pgEnum,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid,
	type AnyPgColumn
} from 'drizzle-orm/pg-core';
import type {
	CatalogCreation,
	CatalogRowChange,
	CatalogRowIssue,
	ImportMapping
} from '$lib/contracts/directory-import';
import {
	CATALOG_IMPORT_STATUSES,
	CATALOG_ROW_ACTIONS,
	DIRECTORY_IMPORT_KINDS
} from '$lib/contracts/directory-import';
import { users } from './auth';
import { organizations, products } from './directory';
import { documents } from './documents';
import { contractItems, contracts } from './interactions';
import { timestamps } from './shared';

export const directoryImportKindEnum = pgEnum('directory_import_kind', DIRECTORY_IMPORT_KINDS);
export const directoryImportStatusEnum = pgEnum('directory_import_status', CATALOG_IMPORT_STATUSES);
export const directoryImportRowActionEnum = pgEnum(
	'directory_import_row_action',
	CATALOG_ROW_ACTIONS
);

export const directoryImports = pgTable(
	'directory_imports',
	{
		id: uuid().primaryKey().defaultRandom(),
		/**
		 * Что описывает файл: каталог вузов или вендоров с контактами. Выбирается
		 * на первом шаге и дальше не меняется — от него зависят поля строки.
		 */
		kind: directoryImportKindEnum().notNull().default('catalog'),
		status: directoryImportStatusEnum().notNull().default('uploading'),
		/** Исходный файл в хранилище документов: по нему проверяют результат. */
		fileDocumentId: uuid().references((): AnyPgColumn => documents.id, { onDelete: 'set null' }),
		/** Сопоставление колонок файла с полями строки: `{колонка: поле}`. */
		mapping: jsonb().$type<ImportMapping>().notNull().default({}),
		rowCount: integer().notNull().default(0),
		createCount: integer().notNull().default(0),
		updateCount: integer().notNull().default(0),
		unchangedCount: integer().notNull().default(0),
		errorCount: integer().notNull().default(0),
		/** Примечание при загрузке, а после отказа — его причина. */
		note: text(),
		createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),
		confirmedAt: timestamp({ withTimezone: true }),
		confirmedBy: uuid().references(() => users.id, { onDelete: 'set null' }),
		...timestamps
	},
	(table) => [
		index('directory_imports_status_idx').on(table.status),
		index('directory_imports_created_idx').on(table.createdAt),
		// Момент применения и состояние ставит одна команда, но разойтись они
		// могут молча — и тогда карточка скажет «применён», не назвав когда.
		check(
			'directory_imports_confirmed_has_moment',
			sql`(${table.status} = 'confirmed') = (${table.confirmedAt} is not null)`
		)
	]
);

export const directoryImportRows = pgTable(
	'directory_import_rows',
	{
		id: uuid().primaryKey().defaultRandom(),
		importId: uuid()
			.notNull()
			.references(() => directoryImports.id, { onDelete: 'cascade' }),
		/** Порядок среди строк данных: шапка и пустые строки в него не считаются. */
		rowNo: integer().notNull(),
		/** Место в файле: номер строки листа (с 1) или индекс элемента JSON (с 0). */
		origin: integer().notNull(),
		action: directoryImportRowActionEnum().notNull().default('error'),
		/**
		 * Разобранные значения строки. Хранятся отдельно от `raw`, потому что
		 * применение работает с ними, а не с текстом ячейки: между предпросмотром
		 * и подтверждением файл читать заново нельзя — человек согласился с тем,
		 * что увидел.
		 *
		 * Строка файла вендоров кладёт компанию в `organization_name` и
		 * `organization_inn`, а ячейку продуктов как есть — в `product_name`:
		 * это те же вопросы «к какой организации» и «про какие продукты», и
		 * отдельные колонки под них были бы вторым ответом. Контакт своих колонок
		 * не имеет — как и контакты каталога, он читается из `raw`.
		 */
		organizationName: text(),
		organizationInn: text(),
		vendorName: text(),
		productName: text(),
		productCode: text(),
		directionName: text(),
		contractNumber: text(),
		contractSignedOn: date(),
		contractValidUntil: date(),
		licenseSignedAt: date(),
		licenseUntil: date(),
		transferStatus: text(),
		/**
		 * Записи справочника, на которые строка легла; ставит подтверждение. У
		 * строки вендоров `organization_id` — компания: по нему загрузку видит
		 * тот, чья это организация.
		 */
		organizationId: uuid().references(() => organizations.id, { onDelete: 'set null' }),
		productId: uuid().references(() => products.id, { onDelete: 'set null' }),
		contractId: uuid().references(() => contracts.id, { onDelete: 'set null' }),
		contractItemId: uuid().references(() => contractItems.id, { onDelete: 'set null' }),
		/** Строка файла как есть: колонка → значение. */
		raw: jsonb().$type<Record<string, string>>().notNull().default({}),
		/** Претензии к строке: `[{field, message}]`. */
		issues: jsonb().$type<CatalogRowIssue[]>().notNull().default([]),
		/** Что строка заводит: `[{target, subject}]`. */
		creations: jsonb().$type<CatalogCreation[]>().notNull().default([]),
		/** Что строка меняет: `[{target, subject, field, from, to}]`. */
		changes: jsonb().$type<CatalogRowChange[]>().notNull().default([]),
		...timestamps
	},
	(table) => [
		uniqueIndex('directory_import_rows_import_row_key').on(table.importId, table.rowNo),
		index('directory_import_rows_action_idx').on(table.importId, table.action),
		index('directory_import_rows_organization_idx').on(table.organizationId),
		// Строка с претензией ничего не записала: иначе «ошибка» в предпросмотре
		// означала бы одно, а в справочнике — другое.
		check(
			'directory_import_rows_error_has_issue',
			sql`(${table.action} = 'error') = (jsonb_array_length(${table.issues}) > 0)`
		)
	]
);
