/**
 * Журнал действий.
 *
 * Таблица append-only: триггер в миграции запрещает UPDATE и DELETE, поэтому
 * запись, однажды попавшая в журнал, не может быть подчищена ни приложением,
 * ни человеком с доступом к базе. Подпись действующего лица и адрес хранятся
 * прямо в строке: журнал обязан читаться и тогда, когда пользователь давно
 * деактивирован, а ключ API отозван.
 */
import { relations } from 'drizzle-orm';
import { index, jsonb, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { AUDIT_OUTCOMES, AUDIT_SOURCES } from '$lib/contracts/audit';
import { users } from './auth';

export const auditSourceEnum = pgEnum('audit_source', AUDIT_SOURCES);
export const auditOutcomeEnum = pgEnum('audit_outcome', AUDIT_OUTCOMES);

export const auditEvents = pgTable(
	'audit_events',
	{
		id: uuid().primaryKey().defaultRandom(),
		occurredAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
		/** Идентификатор запроса: связывает запись журнала со строкой лога. */
		requestId: text().notNull(),
		source: auditSourceEnum().notNull(),
		/** Код события из словаря `$lib/contracts/audit`. */
		eventType: text().notNull(),
		outcome: auditOutcomeEnum().notNull(),
		actorUserId: uuid().references(() => users.id, { onDelete: 'restrict' }),
		/**
		 * Ключ API без внешнего ключа: журнал переживает удаление ключа, и
		 * ссылочная целостность не должна мешать записать событие.
		 */
		apiKeyId: uuid(),
		/** Подпись действующего лица на момент события. */
		actorLabel: text().notNull(),
		ip: text(),
		userAgent: text(),
		/** Над чем действовали: имя сущности и её идентификатор. */
		subjectType: text(),
		subjectId: uuid(),
		/**
		 * Подробности. Допустимы только ссылки вида `<что-то>Id` и список
		 * изменённых полей — проверяет `validateAuditDetails`.
		 */
		details: jsonb().notNull().default({})
	},
	(table) => [
		index('audit_events_occurred_at_idx').on(table.occurredAt),
		index('audit_events_subject_idx').on(table.subjectType, table.subjectId),
		index('audit_events_actor_idx').on(table.actorUserId)
	]
);

export const auditEventsRelations = relations(auditEvents, ({ one }) => ({
	actor: one(users, { fields: [auditEvents.actorUserId], references: [users.id] })
}));
