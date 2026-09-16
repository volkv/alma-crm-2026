/**
 * Документы и шаблоны, по которым их генерируют.
 *
 * Файл неизменяем: новая редакция — новая запись документа. Иначе хеш, размер
 * и даты согласования начали бы описывать файл, которого уже нет на диске.
 * Три факта по документу (согласован, утверждён, вступил в силу) хранятся
 * раздельно: это не стадии одного статуса, они наступают независимо.
 */
import { relations, sql } from 'drizzle-orm';
import {
	bigint,
	check,
	integer,
	jsonb,
	pgTable,
	primaryKey,
	text,
	timestamp,
	uniqueIndex,
	uuid,
	type AnyPgColumn
} from 'drizzle-orm/pg-core';
import type { DocumentTemplateVariable } from '$lib/contracts/documents';
import { users } from './auth';
import { interactions, stageEntries } from './interactions';
import { createdAt, timestamps } from './shared';

export const documentTemplates = pgTable('document_templates', {
	id: uuid().primaryKey().defaultRandom(),
	key: text().notNull().unique(),
	name: text().notNull(),
	/** Ключ объекта с файлом шаблона в хранилище документов (`files/<uuid>`). */
	filePath: text().notNull(),
	version: integer().notNull().default(1),
	/** Переменные, которые шаблон умеет подставлять. */
	variables: jsonb().$type<DocumentTemplateVariable[]>().notNull().default([]),
	...timestamps
});

export const documents = pgTable(
	'documents',
	{
		id: uuid().primaryKey().defaultRandom(),
		/** Документ может жить вне взаимодействия — например, типовая форма. */
		interactionId: uuid().references((): AnyPgColumn => interactions.id, { onDelete: 'cascade' }),
		/**
		 * Редакция, которую заменил этот файл. Файл неизменяем, поэтому история
		 * документа — это цепочка записей, а не версии одной строки: у каждой
		 * редакции свой хеш и свои даты согласования.
		 *
		 * `set null` при удалении: поштучно документы не удаляются вовсе, а
		 * каскад от взаимодействия сносит всю цепочку целиком — ссылке всё равно
		 * будет некуда указывать.
		 */
		supersedesId: uuid().references((): AnyPgColumn => documents.id, { onDelete: 'set null' }),
		/** Вид документа: соглашение, приказ, акт, отчёт. */
		kind: text().notNull(),
		title: text().notNull(),
		/** Ключ объекта с файлом в хранилище документов (`files/<uuid>`). */
		filePath: text().notNull(),
		mime: text().notNull(),
		sizeBytes: bigint({ mode: 'number' }).notNull(),
		/** Хеш содержимого: по нему видно, что файл не подменили. */
		sha256: text().notNull(),
		uploadedBy: uuid().references(() => users.id, { onDelete: 'set null' }),
		agreedAt: timestamp({ withTimezone: true }),
		agreedBy: uuid().references(() => users.id, { onDelete: 'set null' }),
		approvedAt: timestamp({ withTimezone: true }),
		approvedBy: uuid().references(() => users.id, { onDelete: 'set null' }),
		inEffectAt: timestamp({ withTimezone: true }),
		inEffectBy: uuid().references(() => users.id, { onDelete: 'set null' }),
		...timestamps
	},
	(table) => [
		// Одну редакцию заменяют один раз: иначе у документа вырастает две
		// «следующих» редакции, и на вопрос «какая сейчас действует» ответа нет.
		// Частичная, потому что первых редакций в базе сколько угодно.
		uniqueIndex('documents_supersedes_key')
			.on(table.supersedesId)
			.where(sql`${table.supersedesId} is not null`),
		check(
			'documents_supersedes_not_self',
			sql`${table.supersedesId} is null or ${table.supersedesId} <> ${table.id}`
		)
	]
);

/**
 * Файлы, приложенные к записи стадии: чем подтверждён шаг процесса.
 *
 * Отдельной таблицей, а не колонкой в `documents`: один и тот же файл бывает
 * приложен к нескольким шагам (соглашение подтверждает и подписание, и передачу
 * материалов), а копия строки документа означала бы копию файла. Проверка
 * «документ и запись принадлежат одному взаимодействию» — в сервисе загрузки:
 * у связующей таблицы нет колонки взаимодействия, по которой её выразил бы
 * составной внешний ключ.
 */
export const stageEntryDocuments = pgTable(
	'stage_entry_documents',
	{
		stageEntryId: uuid()
			.notNull()
			.references((): AnyPgColumn => stageEntries.id, { onDelete: 'cascade' }),
		documentId: uuid()
			.notNull()
			.references((): AnyPgColumn => documents.id, { onDelete: 'cascade' }),
		...createdAt
	},
	(table) => [primaryKey({ columns: [table.stageEntryId, table.documentId] })]
);

export const stageEntryDocumentsRelations = relations(stageEntryDocuments, ({ one }) => ({
	stageEntry: one(stageEntries, {
		fields: [stageEntryDocuments.stageEntryId],
		references: [stageEntries.id]
	}),
	document: one(documents, {
		fields: [stageEntryDocuments.documentId],
		references: [documents.id]
	})
}));

export const documentsRelations = relations(documents, ({ one }) => ({
	interaction: one(interactions, {
		fields: [documents.interactionId],
		references: [interactions.id]
	}),
	uploadedByUser: one(users, { fields: [documents.uploadedBy], references: [users.id] })
}));
