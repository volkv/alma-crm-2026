/**
 * Документы и шаблоны, по которым их генерируют.
 *
 * Файл неизменяем: новая редакция — новая запись документа. Иначе хеш, размер
 * и даты согласования начали бы описывать файл, которого уже нет на диске.
 * Три факта по документу (согласован, утверждён, вступил в силу) хранятся
 * раздельно: это не стадии одного статуса, они наступают независимо.
 */
import { relations } from 'drizzle-orm';
import {
	bigint,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
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
	/** Путь к файлу шаблона относительно каталога данных (`DATA_DIR`). */
	filePath: text().notNull(),
	version: integer().notNull().default(1),
	/** Переменные, которые шаблон умеет подставлять. */
	variables: jsonb().$type<DocumentTemplateVariable[]>().notNull().default([]),
	...timestamps
});

export const documents = pgTable('documents', {
	id: uuid().primaryKey().defaultRandom(),
	/** Документ может жить вне взаимодействия — например, типовая форма. */
	interactionId: uuid().references((): AnyPgColumn => interactions.id, { onDelete: 'cascade' }),
	/** Вид документа: соглашение, приказ, акт, отчёт. */
	kind: text().notNull(),
	title: text().notNull(),
	/** Путь к файлу относительно каталога данных (`DATA_DIR`). */
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
});

export const documentsRelations = relations(documents, ({ one }) => ({
	interaction: one(interactions, {
		fields: [documents.interactionId],
		references: [interactions.id]
	}),
	uploadedByUser: one(users, { fields: [documents.uploadedBy], references: [users.id] })
}));
