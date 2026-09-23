/**
 * Обмен с внешними системами: учебные группы, их результаты и журнал сообщений.
 *
 * Журнал обмена лежит в PostgreSQL, а не в Redis, в отличие от очереди
 * вебхуков: за состоянием интеграции здесь стоит история, за которую отвечает
 * сотрудник, — «ушла ли группа в систему обучения и что ответили», — и
 * перезапуск она обязана переживать.
 *
 * Значения перечислений объявлены здесь, а не в контрактах: схем обмена
 * (`src/lib/contracts/exchange.ts`) ещё нет, их заводит задача обмена вместе с
 * конвертом сообщения — она же переносит словари туда, где им место.
 */
import { relations, sql } from 'drizzle-orm';
import {
	check,
	date,
	foreignKey,
	index,
	integer,
	jsonb,
	pgEnum,
	pgTable,
	primaryKey,
	text,
	timestamp,
	unique,
	uniqueIndex,
	uuid
} from 'drizzle-orm/pg-core';
import { LEARNING_PURPOSES } from '$lib/contracts/exchange';
import { users } from './auth';
import { products, programs } from './directory';
import { documents } from './documents';
import { interactions } from './interactions';
import { createdAt } from './shared';

/** Куда идёт сообщение: к нам или от нас. */
export const EXCHANGE_DIRECTIONS = ['inbound', 'outbound'] as const;

/**
 * Состояние сообщения обмена. Конечные — `sent`, `processed`, `ignored_stale`,
 * `dismissed`; `failed` конечным не считается: он ждёт человека.
 */
export const EXCHANGE_MESSAGE_STATES = [
	'pending',
	'retrying',
	'sent',
	'processed',
	'ignored_stale',
	'failed',
	'dismissed'
] as const;

export const exchangeDirectionEnum = pgEnum('exchange_direction', EXCHANGE_DIRECTIONS);
export const exchangeMessageStateEnum = pgEnum('exchange_message_state', EXCHANGE_MESSAGE_STATES);
export const learningPurposeEnum = pgEnum('learning_purpose', LEARNING_PURPOSES);

/**
 * Одно входящее или исходящее сообщение контракта обмена.
 *
 * Тело сообщения и сохранённый ответ лежат целиком: без них повтор по тому же
 * `eventId` не смог бы вернуть прежний ответ, а значит, повтор перестал бы быть
 * безопасным. Хеш запроса отделяет настоящий повтор от другого тела под тем же
 * идентификатором события.
 */
export const exchangeMessages = pgTable(
	'exchange_messages',
	{
		id: uuid().primaryKey().defaultRandom(),
		direction: exchangeDirectionEnum().notNull(),
		/** Система обмена: `cms`, `lms`, `crm`. */
		system: text().notNull(),
		/** Экземпляр подключения: у одной системы их бывает несколько. */
		instance: text().notNull(),
		eventType: text().notNull(),
		/** Идентификатор события отправителя — ключ дедупликации. */
		eventId: text().notNull(),
		/** Идентификатор объекта во внешней системе, если он известен. */
		externalId: text(),
		interactionId: uuid().references(() => interactions.id, { onDelete: 'set null' }),
		state: exchangeMessageStateEnum().notNull(),
		attempt: integer().notNull().default(0),
		nextAttemptAt: timestamp({ withTimezone: true }),
		responseStatus: integer(),
		/** Последняя ошибка словами: её читает сотрудник, а не программа. */
		lastError: text(),
		payload: jsonb().notNull(),
		/**
		 * Замороженный конверт исходящего сообщения: то, что действительно ушло
		 * получателю в первой попытке.
		 *
		 * Отдельно от `payload` потому, что у них разные роли. `payload` — семя:
		 * у входящего это присланное сообщение, у исходящего — то, из чего
		 * собирается тело. `envelope` появляется один раз, при первой отправке, и
		 * дальше не меняется: повтор обязан нести то же сообщение под тем же
		 * `eventId`, иначе получатель вправе отвергнуть его как подмену
		 * (`docs/exchange-contract.md`, раздел 2). Изменение состояния — это новое
		 * событие, а не другое тело у старого.
		 *
		 * Текст, а не `jsonb`: повтор обязан уйти **байт в байт**, а `jsonb`
		 * хранит разобранное значение и порядок полей не сохраняет — тело,
		 * прочитанное обратно, отличалось бы от отправленного, и получатель,
		 * который сверяет повтор дословно, отверг бы его.
		 */
		envelope: text(),
		requestHash: text(),
		responseBody: jsonb(),
		closedAt: timestamp({ withTimezone: true }),
		...createdAt
	},
	(table) => [
		// Повторная доставка того же сообщения не заводит второй строки.
		unique('exchange_messages_event_key').on(
			table.direction,
			table.system,
			table.instance,
			table.eventId
		),
		// Очередь разбирается частичным индексом: ждущих сообщений единицы, а
		// строк в журнале со временем десятки тысяч.
		index('exchange_messages_queue_idx')
			.on(table.state, table.nextAttemptAt)
			.where(sql`${table.state} in ('pending', 'retrying')`),
		index('exchange_messages_interaction_idx').on(table.interactionId, table.createdAt)
	]
);

/**
 * Поток обучения, заведённый по взаимодействию в системе обучения.
 *
 * Своей таблицей, а не полем взаимодействия: потоков у одного взаимодействия
 * бывает несколько, и у группы своя жизнь, которая продолжается после того, как
 * стадия пройдена.
 *
 * Группа закрепляет, **что** и **для кого** обучается: программу, продукты и
 * назначение. Выбор делается один раз, при заявке, и не следует за правкой
 * взаимодействия: в системе обучения группа уже заведена по этой программе, и
 * переписать её задним числом значило бы солгать о том, что туда ушло.
 */
export const learningGroups = pgTable(
	'learning_groups',
	{
		id: uuid().primaryKey().defaultRandom(),
		interactionId: uuid()
			.notNull()
			.references(() => interactions.id, { onDelete: 'cascade' }),
		/** Номер потока в пределах взаимодействия. */
		streamNumber: integer().notNull(),
		system: text().notNull(),
		instance: text().notNull(),
		/** Идентификатор группы на стороне системы обучения. */
		groupExternalId: text(),
		requestedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
		plannedSeats: integer(),
		startsOn: date(),
		endsOn: date(),
		/** Момент последнего подтверждённого результата — вывод из истории. */
		lastResultAt: timestamp({ withTimezone: true }),
		/**
		 * Программа группы. `null` — только у групп, заведённых до закрепления,
		 * где выбор нельзя восстановить однозначно (миграция `0023`); новая
		 * группа без программы не заводится.
		 */
		programId: uuid().references(() => programs.id, { onDelete: 'restrict' }),
		/** Для кого обучение; `null` — у групп, заведённых до закрепления. */
		purpose: learningPurposeEnum(),
		/**
		 * Отметка сотрудника «обучение завершено»: итога из системы обучения нет,
		 * а обучение закончилось. Момент и комментарий ставятся вместе.
		 */
		completionMarkedAt: timestamp({ withTimezone: true }),
		completionMarkedBy: uuid().references(() => users.id, { onDelete: 'set null' }),
		completionComment: text(),
		...createdAt
	},
	(table) => [
		// Повторное нажатие «Отправить группу» не заводит второй поток.
		unique('learning_groups_interaction_stream_key').on(table.interactionId, table.streamNumber),
		uniqueIndex('learning_groups_external_key')
			.on(table.system, table.instance, table.groupExternalId)
			.where(sql`${table.groupExternalId} is not null`),
		check(
			'learning_groups_completion_mark_whole',
			sql`(${table.completionMarkedAt} is null) = (${table.completionComment} is null)`
		)
	]
);

/**
 * Продукты группы — подмножество продуктов взаимодействия на момент заявки.
 * Таблицей, а не массивом: продукт — запись справочника, и ссылка на неё
 * обязана держать внешний ключ.
 */
export const learningGroupProducts = pgTable(
	'learning_group_products',
	{
		learningGroupId: uuid()
			.notNull()
			.references(() => learningGroups.id, { onDelete: 'cascade' }),
		productId: uuid()
			.notNull()
			.references(() => products.id, { onDelete: 'restrict' }),
		...createdAt
	},
	(table) => [primaryKey({ columns: [table.learningGroupId, table.productId] })]
);

/**
 * Результат потока за период: сколько зачислено, завершило и отчислено.
 *
 * История строками, а не перезаписью: подтверждённый снимок статистики
 * неизменяем, и «последний результат» обязан быть выводом из истории, а не
 * единственным сохранённым фактом. Актуальным считается результат с наибольшим
 * `occurred_at`.
 */
export const learningGroupResults = pgTable(
	'learning_group_results',
	{
		id: uuid().primaryKey().defaultRandom(),
		learningGroupId: uuid()
			.notNull()
			.references(() => learningGroups.id, { onDelete: 'cascade' }),
		/** Момент, которым отправитель датировал результат. */
		occurredAt: timestamp({ withTimezone: true }).notNull(),
		periodStart: date(),
		periodEnd: date(),
		finishedOn: date(),
		enrolled: integer(),
		completed: integer(),
		expelled: integer(),
		/** Файл-подтверждение: ведомость, акт, выгрузка. */
		documentId: uuid().references(() => documents.id, { onDelete: 'set null' }),
		/** Сообщение, которым результат приехал. */
		exchangeMessageId: uuid(),
		...createdAt
	},
	(table) => [
		unique('learning_group_results_group_occurred_key').on(table.learningGroupId, table.occurredAt),
		// Имя ключа задано вручную: вычисленное по столбцам не влезает в 63
		// символа идентификатора PostgreSQL и молча обрезается.
		foreignKey({
			name: 'learning_group_results_message_fk',
			columns: [table.exchangeMessageId],
			foreignColumns: [exchangeMessages.id]
		}).onDelete('set null'),
		index('learning_group_results_group_idx').on(table.learningGroupId, table.occurredAt.desc()),
		check(
			'learning_group_results_counts_consistent',
			sql`${table.enrolled} is null or coalesce(${table.completed}, 0) + coalesce(${table.expelled}, 0) <= ${table.enrolled}`
		)
	]
);

export const exchangeMessagesRelations = relations(exchangeMessages, ({ one }) => ({
	interaction: one(interactions, {
		fields: [exchangeMessages.interactionId],
		references: [interactions.id]
	})
}));

export const learningGroupsRelations = relations(learningGroups, ({ one, many }) => ({
	interaction: one(interactions, {
		fields: [learningGroups.interactionId],
		references: [interactions.id]
	}),
	program: one(programs, { fields: [learningGroups.programId], references: [programs.id] }),
	products: many(learningGroupProducts),
	results: many(learningGroupResults)
}));

export const learningGroupProductsRelations = relations(learningGroupProducts, ({ one }) => ({
	group: one(learningGroups, {
		fields: [learningGroupProducts.learningGroupId],
		references: [learningGroups.id]
	}),
	product: one(products, { fields: [learningGroupProducts.productId], references: [products.id] })
}));

export const learningGroupResultsRelations = relations(learningGroupResults, ({ one }) => ({
	group: one(learningGroups, {
		fields: [learningGroupResults.learningGroupId],
		references: [learningGroups.id]
	}),
	document: one(documents, {
		fields: [learningGroupResults.documentId],
		references: [documents.id]
	}),
	message: one(exchangeMessages, {
		fields: [learningGroupResults.exchangeMessageId],
		references: [exchangeMessages.id]
	})
}));
