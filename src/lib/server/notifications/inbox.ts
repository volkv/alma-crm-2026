/**
 * Доставка писем по строкам колокольчика: «Вас упомянули в деле» и «Вам
 * назначено новое дело с сайта».
 *
 * Строки ставит в очередь сама причина — той же транзакцией, в которой она
 * записана: упоминание — комментарий (`mentions/index.ts`), новое дело — приём
 * заявки или оплаты (`inbox/index.ts`), со статусом «ждёт отправки» и сроком
 * «сейчас». Отправляет их этот проход фонового цикла уведомлений, под тем же
 * замком в Redis, что и наблюдатели: одно письмо уходит один раз и между
 * процессами.
 *
 * Перед каждой отправкой адресат проверяется заново тем же правилом, что при
 * постановке (`userSeesInteraction`): между постановкой и письмом его могли
 * выключить, вывести из пространства или отдать вуз другому. Тогда письма нет,
 * а строка остаётся в журнале со статусом «получатель не определён» и причиной
 * словами.
 *
 * Неудачная отправка повторяется по общему правилу (через час, до пяти
 * попыток); ушедшее, изображённое заглушкой и пропущенное больше не
 * повторяются — повод один, и второе письмо о нём ничего не скажет.
 */
import { and, eq, inArray, isNotNull, lte, sql } from 'drizzle-orm';
import {
	isStubChannel,
	type NotificationChannel,
	type NotificationDeliveryStatus
} from '$lib/contracts/notifications';
import type { ActorContext } from '../actor';
import { recordAuditEvent } from '../audit';
import { loadSessionUser } from '../auth/session';
import { getConfig } from '../config';
import { getDb } from '../db';
import { notificationDeliveries } from '../db/schema';
import { userSeesInteraction } from '../live/viewers';
import { sendThroughChannel } from './channels';
import {
	applicationNotificationMessage,
	mentionNotificationMessage,
	type NotificationMessage
} from './message';
import { MIN_REPEAT_DAYS, nextNotifyAt } from './schedule';

/** Сколько писем проход разбирает за раз. */
const BATCH = 50;

/** Виды, которые доставляет этот проход: строки колокольчика. */
export const INBOX_NOTIFICATION_KINDS = ['mention', 'site_application'] as const;

export type InboxNotificationKind = (typeof INBOX_NOTIFICATION_KINDS)[number];

/** Почему письма не будет: адресат к моменту отправки дела не видит. */
export const INBOX_ACCESS_LOST =
	'Адресат больше не видит дело: учётная запись выключена или доступ к делу пропал после постановки письма';

export type InboxDelivery = {
	id: string;
	kind: InboxNotificationKind;
	interactionId: string;
	recipientUserId: string | null;
	channel: NotificationChannel;
	attempts: number;
};

const deliveryColumns = {
	id: notificationDeliveries.id,
	kind: notificationDeliveries.kind,
	interactionId: notificationDeliveries.interactionId,
	recipientUserId: notificationDeliveries.recipientUserId,
	channel: notificationDeliveries.channel,
	attempts: notificationDeliveries.attempts
};

type DeliveryRow = {
	id: string;
	kind: string;
	interactionId: string | null;
	recipientUserId: string | null;
	channel: NotificationChannel;
	attempts: number;
};

function isInboxKind(kind: string): kind is InboxNotificationKind {
	return (INBOX_NOTIFICATION_KINDS as readonly string[]).includes(kind);
}

/**
 * Строка журнала как доставка колокольчика. Дело у таких строк заполнено
 * всегда — это держит проверка `notification_deliveries_subject_one_of`.
 */
function toInboxDelivery(row: DeliveryRow): InboxDelivery {
	if (!isInboxKind(row.kind) || row.interactionId === null) {
		throw new Error(`Строка ${row.id} — не письмо колокольчика: проверка таблицы нарушена`);
	}

	return { ...row, kind: row.kind, interactionId: row.interactionId };
}

/** Строка доставки колокольчика по её идентификатору; `null` — строки нет. */
export async function readInboxDelivery(deliveryId: string): Promise<InboxDelivery | null> {
	const [row] = await getDb()
		.select(deliveryColumns)
		.from(notificationDeliveries)
		.where(eq(notificationDeliveries.id, deliveryId))
		.limit(1);

	return row === undefined ? null : toInboxDelivery(row);
}

function messageFor(delivery: InboxDelivery, origin: string): NotificationMessage {
	const facts = { interactionId: delivery.interactionId };

	return delivery.kind === 'mention'
		? mentionNotificationMessage(facts, origin)
		: applicationNotificationMessage(facts, origin);
}

/**
 * Одна доставка: проверить адресата, отправить, записать исход. Возвращает
 * исход — его сводит в отчёт цикл и показывает кнопка повтора.
 */
export async function deliverInboxNotice(
	ctx: ActorContext,
	delivery: InboxDelivery,
	now: Date = new Date()
): Promise<NotificationDeliveryStatus> {
	const db = getDb();
	const recipient =
		delivery.recipientUserId === null ? null : await loadSessionUser(delivery.recipientUserId);

	if (recipient === null || !(await userSeesInteraction(recipient, delivery.interactionId))) {
		await db
			.update(notificationDeliveries)
			.set({
				status: 'skipped',
				lastError: INBOX_ACCESS_LOST,
				nextNotifyAt: null,
				updatedAt: now
			})
			.where(eq(notificationDeliveries.id, delivery.id));

		return 'skipped';
	}

	// Текст собирается заново, а не берётся из очереди: адрес установки мог
	// смениться между постановкой и отправкой.
	const message = messageFor(delivery, getConfig().ORIGIN);
	const outcome = await sendThroughChannel(
		delivery.channel,
		{ userId: recipient.id, fullName: recipient.fullName, email: recipient.email },
		message
	);
	const attempts = isStubChannel(delivery.channel) ? delivery.attempts : delivery.attempts + 1;

	await db
		.update(notificationDeliveries)
		.set({
			status: outcome.status,
			subject: message.subject,
			body: message.text,
			attempts,
			lastError: outcome.error,
			sentAt: outcome.status === 'sent' ? now : sql`${notificationDeliveries.sentAt}`,
			nextNotifyAt:
				outcome.status === 'failed'
					? nextNotifyAt({ status: outcome.status, attempts }, MIN_REPEAT_DAYS, now)
					: null,
			updatedAt: now
		})
		.where(eq(notificationDeliveries.id, delivery.id));

	if (outcome.status === 'failed') {
		await recordAuditEvent(ctx, {
			type: 'notifications.failed',
			outcome: 'failure',
			subject: { type: 'interaction', id: delivery.interactionId },
			details: { channelKey: delivery.channel, kindKey: delivery.kind }
		});
	}

	return outcome.status;
}

/**
 * Проход по созревшим письмам колокольчика для включённых каналов.
 * Строки выключенного канала ждут в очереди, пока его не включат.
 */
export async function runInboxDelivery(
	ctx: ActorContext,
	channels: readonly NotificationChannel[],
	now: Date
): Promise<NotificationDeliveryStatus[]> {
	if (channels.length === 0) {
		return [];
	}

	const due = await getDb()
		.select(deliveryColumns)
		.from(notificationDeliveries)
		.where(
			and(
				inArray(notificationDeliveries.kind, [...INBOX_NOTIFICATION_KINDS]),
				isNotNull(notificationDeliveries.nextNotifyAt),
				lte(notificationDeliveries.nextNotifyAt, now),
				inArray(notificationDeliveries.channel, [...channels])
			)
		)
		.orderBy(notificationDeliveries.nextNotifyAt)
		.limit(BATCH);

	const outcomes: NotificationDeliveryStatus[] = [];

	for (const row of due) {
		outcomes.push(await deliverInboxNotice(ctx, toInboxDelivery(row), now));
	}

	return outcomes;
}
