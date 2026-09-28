/**
 * Очередь писем вузу: описание программ, пакет документов, приглашение на
 * встречу и её отмена.
 *
 * Строка — одно нажатие «Отправить» (или «Тестовое письмо себе»). Её ставит
 * сама команда той же транзакцией, в которой записана постановка, а письма
 * уходят фоновым обработчиком после фиксации (`mail/queue.ts`): почтовый
 * сервер отвечает секунды на каждого получателя, и держать на нём окно и
 * запрос нельзя.
 *
 * В задании — только идентификаторы: ролей контактных лиц, сотрудников,
 * документов, дела и отправителя. Адресов и ФИО нет — обработчик подставляет
 * их заново, по действующему праву отправителя, как и в момент нажатия;
 * обезличивание человека не должно гоняться за копиями его адреса по очереди.
 *
 * Та же строка — уведомление отправителю в колокольчике, если ушло не всем
 * или не ушло вовсе (`notice_read_at` — когда он его увидел).
 */
import { relations, sql } from 'drizzle-orm';
import {
	boolean,
	check,
	index,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
	uuid
} from 'drizzle-orm/pg-core';
import type { AuditSource } from '$lib/contracts/audit';
import { OUTBOUND_MAIL_STATUSES, type OutboundMailStatus } from '$lib/contracts/outbound-mail';
import { users } from './auth';
import { interactions } from './interactions';
import { timestamps } from './shared';

/** Данные задания: идентификаторы и то, что отправитель ввёл сам (повестка встречи). */
export type OutboundMailPayload = Record<string, string | number | boolean | null | string[]>;

export const outboundMailJobs = pgTable(
	'outbound_mail_jobs',
	{
		id: uuid().primaryKey().defaultRandom(),
		/**
		 * Вид письма: `program_offer`, `document_package` — ядра;
		 * `<модуль>:<вид>` — модуля (`meetings:invite`). По нему обработчик
		 * находит, кто это письмо собирает.
		 */
		kind: text().notNull(),
		/** Как письмо называется в колокольчике: «Описание программ». */
		label: text().notNull(),
		interactionId: uuid()
			.notNull()
			.references(() => interactions.id, { onDelete: 'cascade' }),
		/** Кто нажал: письмо подписано им, и право на него проверяется по нему же. */
		senderUserId: uuid()
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		/** Тестовое письмо себе: следа в деле не оставляет. */
		test: boolean().notNull().default(false),
		/** Откуда пришло нажатие и под каким идентификатором запроса: им же подписан журнал. */
		source: text().$type<AuditSource>().notNull(),
		requestId: text().notNull(),
		payload: jsonb().$type<OutboundMailPayload>().notNull(),
		status: text().$type<OutboundMailStatus>().notNull().default('queued'),
		/**
		 * До какого момента задание держит взявший его обработчик. Прошёл срок, а
		 * задание всё ещё `sending`, — процесс умер посреди отправки.
		 */
		lockedUntil: timestamp({ withTimezone: true }),
		sentCount: integer().notNull().default(0),
		failedCount: integer().notNull().default(0),
		/** Почему ушло не всем или не ушло — словами для колокольчика. */
		lastError: text(),
		finishedAt: timestamp({ withTimezone: true }),
		/** Когда отправитель увидел исход в колокольчике; пусто — ещё не видел. */
		noticeReadAt: timestamp({ withTimezone: true }),
		...timestamps
	},
	(table) => [
		check(
			'outbound_mail_jobs_status_check',
			sql.raw(`status in (${OUTBOUND_MAIL_STATUSES.map((status) => `'${status}'`).join(', ')})`)
		),
		// Обработчик выбирает ждущие, а их единицы среди тысяч законченных.
		index('outbound_mail_jobs_pending_idx')
			.on(table.createdAt)
			.where(sql`${table.status} in ('queued', 'sending')`),
		// Окно письма спрашивает, не идёт ли уже отправка по делу.
		index('outbound_mail_jobs_interaction_idx').on(table.interactionId, table.kind),
		// Колокольчик: свои исходы, свежие сверху.
		index('outbound_mail_jobs_sender_idx').on(table.senderUserId, table.createdAt)
	]
);

export const outboundMailJobsRelations = relations(outboundMailJobs, ({ one }) => ({
	interaction: one(interactions, {
		fields: [outboundMailJobs.interactionId],
		references: [interactions.id]
	}),
	sender: one(users, { fields: [outboundMailJobs.senderUserId], references: [users.id] })
}));
