/**
 * Упоминания сотрудников в комментариях.
 *
 * Строка — «комментарий × адресат»: кого позвали в обсуждение и прочитал ли он
 * это. Текста здесь нет — только ссылки: сам комментарий живёт в `comments`, и
 * вторая копия его текста стала бы ещё одним местом, где лежат сказанные о
 * деле слова. По той же причине нет и подписи адресата: имя берётся из
 * справочника пользователей в момент показа.
 *
 * Письмо об упоминании — отдельная строка журнала доставок
 * (`notification_deliveries.mention_id`): у доставки свои попытки и ошибки, у
 * упоминания — только отметка прочтения в колокольчике.
 */
import { relations } from 'drizzle-orm';
import { index, pgTable, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { users } from './auth';
import { comments, interactions } from './interactions';
import { timestamps } from './shared';

export const commentMentions = pgTable(
	'comment_mentions',
	{
		id: uuid().primaryKey().defaultRandom(),
		commentId: uuid()
			.notNull()
			.references(() => comments.id, { onDelete: 'cascade' }),
		/** Дело комментария: колокольчик ведёт в карточку, а доступ проверяется по делу. */
		interactionId: uuid()
			.notNull()
			.references(() => interactions.id, { onDelete: 'cascade' }),
		/** Кого упомянули. */
		userId: uuid()
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		/** Когда адресат увидел упоминание; пусто — ещё не видел. */
		readAt: timestamp({ withTimezone: true }),
		...timestamps
	},
	(table) => [
		// Один адресат упоминается в комментарии один раз, сколько бы раз его
		// имя ни стояло в тексте.
		uniqueIndex('comment_mentions_comment_user_key').on(table.commentId, table.userId),
		// Колокольчик: свои упоминания, свежие сверху.
		index('comment_mentions_user_idx').on(table.userId, table.createdAt),
		index('comment_mentions_interaction_idx').on(table.interactionId)
	]
);

export const commentMentionsRelations = relations(commentMentions, ({ one }) => ({
	comment: one(comments, { fields: [commentMentions.commentId], references: [comments.id] }),
	interaction: one(interactions, {
		fields: [commentMentions.interactionId],
		references: [interactions.id]
	}),
	user: one(users, { fields: [commentMentions.userId], references: [users.id] })
}));
