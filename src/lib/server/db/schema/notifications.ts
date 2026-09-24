/**
 * Журнал доставок уведомлений.
 *
 * Лежит в PostgreSQL, а не в Redis, по тому же критерию, что и журнал обмена:
 * состояние живёт в Redis, **пока за ним нет истории, за которую кто-то
 * отвечает**. Здесь она есть — руководитель спрашивает «почему мне не пришло»,
 * администратор повторяет неудавшуюся отправку, и перезапуск это обязано
 * переживать. Здесь же лежит и отметка следующего напоминания: потеряйся она с
 * очисткой Redis — и первый же проход цикла разослал бы всё заново.
 *
 * Строка одна на «вид × предмет × канал», а не на каждую отправку. Строка
 * на отправку превратила бы журнал в лог: напоминание повторяется, пока запись
 * стадии открыта, и за полгода стояния на одной стадии дало бы два десятка
 * одинаковых строк. Что повторов было несколько, видно по счётчику попыток и по
 * моменту последней отправки.
 *
 * Предметов четыре, и у строки заполнен ровно один (проверка
 * `notification_deliveries_subject_one_of`):
 * - запись стадии (`stage_entry_id` вместе со своим взаимодействием) — у
 *   напоминания о зависшем взаимодействии;
 * - позиция договора вместе со сроком лицензии (`contract_item_id`,
 *   `license_until`) — у уведомлений о лицензии. Срок входит в ключ: продлили
 *   лицензию — новый срок напоминает заново, а история прежнего остаётся;
 * - день утренней сводки (`digest_day`) вместе с получателем — у сводки «Мой
 *   день»: одна на сотрудника, день и канал;
 * - упоминание в комментарии (`mention_id` вместе со своим взаимодействием) —
 *   у письма «Вас упомянули в деле»: одно на упоминание и канал.
 */
import { relations, sql } from 'drizzle-orm';
import {
	check,
	date,
	index,
	integer,
	pgEnum,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid
} from 'drizzle-orm/pg-core';
import {
	NOTIFICATION_CHANNELS,
	NOTIFICATION_DELIVERY_STATUSES,
	NOTIFICATION_KINDS
} from '$lib/contracts/notifications';
import { users } from './auth';
import { contractItems, interactions, stageEntries } from './interactions';
import { commentMentions } from './mentions';
import { timestamps } from './shared';

export const notificationKindEnum = pgEnum('notification_kind', NOTIFICATION_KINDS);
export const notificationChannelEnum = pgEnum('notification_channel', NOTIFICATION_CHANNELS);
export const notificationDeliveryStatusEnum = pgEnum(
	'notification_delivery_status',
	NOTIFICATION_DELIVERY_STATUSES
);

export const notificationDeliveries = pgTable(
	'notification_deliveries',
	{
		id: uuid().primaryKey().defaultRandom(),
		kind: notificationKindEnum().notNull(),
		interactionId: uuid().references(() => interactions.id, { onDelete: 'cascade' }),
		/**
		 * Запись стадии, о которой напоминают. Она же — предмет дедупликации:
		 * закрылась запись, и напоминать больше не о чем, а строка остаётся
		 * историей вместе со своей записью.
		 */
		stageEntryId: uuid().references(() => stageEntries.id, { onDelete: 'cascade' }),
		/**
		 * Позиция договора, о лицензии которой напоминают. Удалили позицию —
		 * напоминать не о чем, и строка уходит вместе с ней.
		 */
		contractItemId: uuid().references(() => contractItems.id, { onDelete: 'cascade' }),
		/** Срок лицензии, о котором напомнили: часть ключа дедупликации. */
		licenseUntil: date(),
		/**
		 * День утренней сводки по Москве: часть ключа дедупликации вместе с
		 * получателем. Завтра — новый день и новая строка.
		 */
		digestDay: date(),
		/**
		 * Упоминание, о котором письмо. Предмет дедупликации: одно письмо на
		 * упоминание и канал, сколько бы раз цикл ни прошёл. Взаимодействие
		 * заполнено рядом с ним — по нему журнал сужается областью читателя.
		 */
		mentionId: uuid().references(() => commentMentions.id, { onDelete: 'cascade' }),
		/**
		 * Кому уходит: руководитель ответственного за взаимодействие, ответственный
		 * за вуз или его руководитель — по виду. Пусто — получателя нет, и это не
		 * ошибка отправки, а незаполненное назначение или иерархия: строка со
		 * статусом «получатель не определён» и есть сообщение об этом.
		 */
		recipientUserId: uuid().references(() => users.id, { onDelete: 'set null' }),
		channel: notificationChannelEnum().notNull(),
		status: notificationDeliveryStatusEnum().notNull(),
		/**
		 * Тема и тело того, что система сказала по этой записи. Хранятся, потому
		 * что руководитель спрашивает не только «дошло ли», но и «что там было», а
		 * текст собирается на лету и без этих колонок нигде не остаётся. У
		 * канала-заглушки они тоже заполнены: строка обязана показывать, что
		 * ушло бы, — иначе про заглушку нечего и смотреть.
		 *
		 * Пусто — у строк, заведённых до того, как текст начали хранить.
		 */
		subject: text(),
		body: text(),
		/** Сколько раз пытались отправить. Заглушка и пропуск попыткой не считаются. */
		attempts: integer().notNull().default(0),
		/** Последняя ошибка словами: её читает человек, а не программа. */
		lastError: text(),
		sentAt: timestamp({ withTimezone: true }),
		/**
		 * Когда напоминание по этой записи полагается повторить. `null` — больше
		 * не повторять само: попытки кончились и дальше решает человек кнопкой.
		 */
		nextNotifyAt: timestamp({ withTimezone: true }),
		...timestamps
	},
	(table) => [
		// Ключ дедупликации. Он же держит правило «одно напоминание на открытую
		// запись стадии»: второй проход цикла обновляет эту строку, а не заводит
		// соседнюю.
		uniqueIndex('notification_deliveries_target_key').on(
			table.kind,
			table.stageEntryId,
			table.channel
		),
		// Тот же ключ для лицензий: одно уведомление на позицию и срок по каналу.
		uniqueIndex('notification_deliveries_license_key')
			.on(table.kind, table.contractItemId, table.licenseUntil, table.channel)
			.where(sql`${table.contractItemId} is not null`),
		// И для сводки: одна на получателя, день и канал.
		uniqueIndex('notification_deliveries_digest_key')
			.on(table.kind, table.recipientUserId, table.digestDay, table.channel)
			.where(sql`${table.digestDay} is not null`),
		// И для упоминания: одно письмо на упоминание по каналу.
		uniqueIndex('notification_deliveries_mention_key')
			.on(table.kind, table.mentionId, table.channel)
			.where(sql`${table.mentionId} is not null`),
		check(
			'notification_deliveries_subject_one_of',
			sql`(${table.stageEntryId} is not null and ${table.interactionId} is not null and ${table.contractItemId} is null and ${table.licenseUntil} is null and ${table.digestDay} is null and ${table.mentionId} is null) or (${table.stageEntryId} is null and ${table.interactionId} is null and ${table.contractItemId} is not null and ${table.licenseUntil} is not null and ${table.digestDay} is null and ${table.mentionId} is null) or (${table.stageEntryId} is null and ${table.interactionId} is null and ${table.contractItemId} is null and ${table.licenseUntil} is null and ${table.digestDay} is not null and ${table.mentionId} is null) or (${table.stageEntryId} is null and ${table.interactionId} is not null and ${table.contractItemId} is null and ${table.licenseUntil} is null and ${table.digestDay} is null and ${table.mentionId} is not null)`
		),
		// Наблюдатель выбирает то, чему пришёл срок: строк в журнале со временем
		// тысячи, а созревших единицы.
		index('notification_deliveries_due_idx').on(table.nextNotifyAt),
		index('notification_deliveries_status_idx').on(table.status, table.createdAt),
		index('notification_deliveries_interaction_idx').on(table.interactionId, table.createdAt),
		index('notification_deliveries_contract_item_idx').on(table.contractItemId),
		index('notification_deliveries_mention_idx').on(table.mentionId)
	]
);

export const notificationDeliveriesRelations = relations(notificationDeliveries, ({ one }) => ({
	interaction: one(interactions, {
		fields: [notificationDeliveries.interactionId],
		references: [interactions.id]
	}),
	stageEntry: one(stageEntries, {
		fields: [notificationDeliveries.stageEntryId],
		references: [stageEntries.id]
	}),
	contractItem: one(contractItems, {
		fields: [notificationDeliveries.contractItemId],
		references: [contractItems.id]
	}),
	mention: one(commentMentions, {
		fields: [notificationDeliveries.mentionId],
		references: [commentMentions.id]
	}),
	recipient: one(users, {
		fields: [notificationDeliveries.recipientUserId],
		references: [users.id]
	})
}));
