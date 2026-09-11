/**
 * Настройки приложения, которые администратор меняет из интерфейса.
 *
 * Значение хранится как есть в `jsonb`; что считается допустимым значением для
 * каждого ключа, описано в `$lib/contracts/settings`, а значения по умолчанию
 * применяет `$lib/server/settings` при отсутствии строки.
 */
import { relations } from 'drizzle-orm';
import { jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './auth';

export const appSettings = pgTable('app_settings', {
	key: text().primaryKey(),
	value: jsonb().notNull(),
	updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
	/** Кто поменял. Пусто у значений, выставленных миграцией или сидом. */
	updatedBy: uuid().references(() => users.id, { onDelete: 'set null' })
});

export const appSettingsRelations = relations(appSettings, ({ one }) => ({
	updatedByUser: one(users, { fields: [appSettings.updatedBy], references: [users.id] })
}));
