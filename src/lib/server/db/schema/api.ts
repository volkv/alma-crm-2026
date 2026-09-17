/**
 * Ключи доступа к публичному API.
 *
 * В базе лежит только хеш ключа: по строке из базы восстановить сам ключ
 * нельзя, поэтому утечка дампа не даёт доступа к системе. Ключ не удаляют, а
 * отзывают — иначе записи журнала потеряют смысл.
 */
import { relations, sql } from 'drizzle-orm';
import { check, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './auth';
import { timestamps } from './shared';

export const apiKeys = pgTable(
	'api_keys',
	{
		id: uuid().primaryKey().defaultRandom(),
		/** Подпись ключа в интерфейсе и в журнале. */
		name: text().notNull(),
		/** Ключ ищут по хешу, поэтому он уникален. */
		keyHash: text().notNull().unique(),
		/** Ключ действует правами того, кто его выпустил. */
		ownerUserId: uuid()
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		/**
		 * Подключение обмена, к которому привязан ключ: система (`cms`, `lms`) и
		 * экземпляр.
		 *
		 * Права роли `service` одинаковы у всех ключей обмена, и без этой пары ключ
		 * сайта подавал бы результаты учебных групп, а ключ системы обучения —
		 * заявки. Оба поля пустые у человеческого ключа: он не представляет никакую
		 * внешнюю систему, и маршруты обмена ему закрыты границей машинного субъекта.
		 */
		exchangeSystem: text(),
		exchangeInstance: text(),
		lastUsedAt: timestamp({ withTimezone: true }),
		revokedAt: timestamp({ withTimezone: true }),
		...timestamps
	},
	(table) => [
		// Половина связи ничего не разграничивает: экземпляр без системы не с чем
		// сверить, система без экземпляра пустила бы ключ на любое подключение.
		check(
			'api_keys_exchange_link_consistent',
			sql`(${table.exchangeSystem} is null) = (${table.exchangeInstance} is null)`
		),
		// Система обмена — из словаря контракта: направления только два, и `crm`
		// здесь означал бы ключ, выпущенный самому себе.
		check(
			'api_keys_exchange_system_known',
			sql`${table.exchangeSystem} is null or ${table.exchangeSystem} in ('cms', 'lms')`
		)
	]
);

export const apiKeysRelations = relations(apiKeys, ({ one }) => ({
	owner: one(users, { fields: [apiKeys.ownerUserId], references: [users.id] })
}));
