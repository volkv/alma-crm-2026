/**
 * Ключи доступа к публичному API.
 *
 * В базе лежит только хеш ключа: по строке из базы восстановить сам ключ
 * нельзя, поэтому утечка дампа не даёт доступа к системе. Ключ не удаляют, а
 * отзывают — иначе записи журнала потеряют смысл.
 */
import { relations } from 'drizzle-orm';
import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './auth';
import { timestamps } from './shared';

export const apiKeys = pgTable('api_keys', {
	id: uuid().primaryKey().defaultRandom(),
	/** Подпись ключа в интерфейсе и в журнале. */
	name: text().notNull(),
	/** Ключ ищут по хешу, поэтому он уникален. */
	keyHash: text().notNull().unique(),
	/** Ключ действует правами того, кто его выпустил. */
	ownerUserId: uuid()
		.notNull()
		.references(() => users.id, { onDelete: 'cascade' }),
	lastUsedAt: timestamp({ withTimezone: true }),
	revokedAt: timestamp({ withTimezone: true }),
	...timestamps
});

export const apiKeysRelations = relations(apiKeys, ({ one }) => ({
	owner: one(users, { fields: [apiKeys.ownerUserId], references: [users.id] })
}));
