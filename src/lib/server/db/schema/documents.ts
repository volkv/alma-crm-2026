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
	text,
	timestamp,
	uniqueIndex,
	uuid,
	type AnyPgColumn
} from 'drizzle-orm/pg-core';
import type { DocumentTemplateVariable } from '$lib/contracts/documents';
import { users } from './auth';
import { interactions } from './interactions';
import { timestamps } from './shared';

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

export const documentsRelations = relations(documents, ({ one }) => ({
	interaction: one(interactions, {
		fields: [documents.interactionId],
		references: [interactions.id]
	}),
	uploadedByUser: one(users, { fields: [documents.uploadedBy], references: [users.id] })
}));
