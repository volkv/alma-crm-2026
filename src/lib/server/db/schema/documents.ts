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
import {
	DOCUMENT_TEMPLATE_KEYS,
	type DocumentSigning,
	type DocumentTemplateKey,
	type DocumentTemplateVariable
} from '$lib/contracts/documents';
import { users } from './auth';
import { programs } from './directory';
import { contractItems, interactions, stageEntries } from './interactions';
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
		/**
		 * Шаблон, по которому документ собран; пусто — загружен руками или
		 * собран до того, как ключ начали записывать. Новая редакция наследует
		 * ключ заменённой: скан подписанного акта — тот же акт. По ключу стадия
		 * находит отметку на документе нужного вида (`stages.requires_document_template`).
		 */
		templateKey: text().$type<DocumentTemplateKey>(),
		title: text().notNull(),
		/**
		 * Что изменилось в этой редакции по сравнению с заменённой — словами
		 * того, кто её загрузил. У первой редакции пусто: менять было нечего.
		 */
		revisionNote: text(),
		/**
		 * Город и подписанты, с которыми документ собран по шаблону; у
		 * загруженного руками — пусто. По ним форма следующей сборки подставляет
		 * то же, что назвали в прошлый раз.
		 */
		signing: jsonb().$type<DocumentSigning>(),
		/** Ключ объекта с файлом в хранилище документов (`files/<uuid>`). */
		filePath: text().notNull(),
		mime: text().notNull(),
		sizeBytes: bigint({ mode: 'number' }).notNull(),
		/** Хеш содержимого: по нему видно, что файл не подменили. */
		sha256: text().notNull(),
		uploadedBy: uuid().references(() => users.id, { onDelete: 'set null' }),
		agreedAt: timestamp({ withTimezone: true }),
		agreedBy: uuid().references(() => users.id, { onDelete: 'set null' }),
		/**
		 * Чем отметка объясняется: номер протокола, кто подписал экземпляр. Текст
		 * принадлежит отметке, а не документу, поэтому колонка на каждый факт —
		 * общий комментарий пришлось бы переписывать второй отметкой, а отметка
		 * неизменяема.
		 */
		agreedNote: text(),
		approvedAt: timestamp({ withTimezone: true }),
		approvedBy: uuid().references(() => users.id, { onDelete: 'set null' }),
		approvedNote: text(),
		inEffectAt: timestamp({ withTimezone: true }),
		inEffectBy: uuid().references(() => users.id, { onDelete: 'set null' }),
		inEffectNote: text(),
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
			'documents_template_key_known',
			sql`${table.templateKey} is null or ${table.templateKey} in (${sql.raw(DOCUMENT_TEMPLATE_KEYS.map((key) => `'${key}'`).join(', '))})`
		),
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

/**
 * Позиции договора, которые передаёт документ: акт передачи материалов и
 * лицензий называет продукты, по которым он составлен.
 *
 * Связь стоит на редакции, как и отметки: подписывают конкретный файл, и
 * отметка «Утверждён» на нём переводит в «передан» ровно эти позиции. Новая
 * редакция (скан подписанного экземпляра) получает связи заменённой при
 * загрузке — это тот же акт, а не другой документ. Удаление позиции снимает
 * связь каскадом: передавать по акту больше нечего.
 */
export const documentContractItems = pgTable(
	'document_contract_items',
	{
		documentId: uuid()
			.notNull()
			.references((): AnyPgColumn => documents.id, { onDelete: 'cascade' }),
		contractItemId: uuid()
			.notNull()
			.references((): AnyPgColumn => contractItems.id, { onDelete: 'cascade' }),
		...createdAt
	},
	(table) => [primaryKey({ columns: [table.documentId, table.contractItemId] })]
);

/**
 * Материалы образовательной программы: файлы с её полным описанием, которые
 * показывает карточка и которые уходят вузу вложением.
 *
 * Файл — обычная строка `documents` без взаимодействия, а принадлежность
 * программе живёт здесь, связью: так хранилище, проверка содержимого, хеш и
 * скачивание остаются одними на все документы системы. Убрать материал из
 * программы — значит снять связь; сама строка документа остаётся, потому что
 * документы поштучно не удаляются (см. `documents.supersedes_id`), а письмо,
 * отправленное с этим файлом, должно и дальше ссылаться на то, что ушло.
 */
export const programDocuments = pgTable(
	'program_documents',
	{
		programId: uuid()
			.notNull()
			.references((): AnyPgColumn => programs.id, { onDelete: 'cascade' }),
		documentId: uuid()
			.notNull()
			.references((): AnyPgColumn => documents.id, { onDelete: 'cascade' }),
		...createdAt
	},
	(table) => [primaryKey({ columns: [table.programId, table.documentId] })]
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
