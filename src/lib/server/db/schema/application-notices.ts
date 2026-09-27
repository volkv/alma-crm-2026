/**
 * Уведомления о новых делах с сайта.
 *
 * Строка — «дело × ответственный»: кому досталось дело, заведённое заявкой или
 * оплатой с сайта, и видел ли он это в колокольчике. Заводит её тот же приём,
 * что заводит дело, той же транзакцией (`notifications/application.ts`):
 * откатится приём — не останется ни дела, ни уведомления.
 *
 * Уникальность «дело × адресат» держит правило «одно уведомление о новом
 * деле»: повтор сообщения сайта и новая ревизия заявки второго не заводят.
 * Письмо — отдельная строка журнала доставок
 * (`notification_deliveries.application_notice_id`), как у упоминаний.
 */
import { relations } from 'drizzle-orm';
import { index, pgTable, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { users } from './auth';
import { interactions } from './interactions';
import { timestamps } from './shared';

export const applicationNotices = pgTable(
	'application_notices',
	{
		id: uuid().primaryKey().defaultRandom(),
		/** Новое дело: колокольчик ведёт в карточку, а доступ проверяется по делу. */
		interactionId: uuid()
			.notNull()
			.references(() => interactions.id, { onDelete: 'cascade' }),
		/** Кому дело назначено при приёме. */
		userId: uuid()
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		/** Когда адресат увидел уведомление; пусто — ещё не видел. */
		readAt: timestamp({ withTimezone: true }),
		...timestamps
	},
	(table) => [
		uniqueIndex('application_notices_interaction_user_key').on(table.interactionId, table.userId),
		// Колокольчик: свои уведомления, свежие сверху.
		index('application_notices_user_idx').on(table.userId, table.createdAt)
	]
);

export const applicationNoticesRelations = relations(applicationNotices, ({ one }) => ({
	interaction: one(interactions, {
		fields: [applicationNotices.interactionId],
		references: [interactions.id]
	}),
	user: one(users, { fields: [applicationNotices.userId], references: [users.id] })
}));
