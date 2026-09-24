/**
 * Доставка писем «Вас упомянули в деле».
 *
 * Строки ставит в очередь сам комментарий — той же транзакцией, в которой он
 * записан (`mentions/index.ts`), со статусом «ждёт отправки» и сроком «сейчас».
 * Отправляет их этот проход фонового цикла уведомлений, под тем же замком в
 * Redis, что и наблюдатели: одно письмо уходит один раз и между процессами.
 *
 * Перед каждой отправкой адресат проверяется заново тем же правилом, что при
 * сохранении комментария (`canUserSeeInteraction`): между комментарием и
 * письмом его могли выключить, вывести из пространства или отдать вуз другому.
 * Тогда письма нет, а строка остаётся в журнале со статусом «получатель не
 * определён» и причиной словами.
 *
 * Неудачная отправка повторяется по общему правилу (через час, до пяти
 * попыток); ушедшее, изображённое заглушкой и пропущенное больше не
 * повторяются — упоминание одно, и второе письмо о нём ничего не скажет.
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
import { commentMentions, notificationDeliveries } from '../db/schema';
import { userSeesInteraction } from '../live/viewers';
import { sendThroughChannel } from './channels';
import { mentionNotificationMessage } from './message';
import { MIN_REPEAT_DAYS, nextNotifyAt } from './schedule';

/** Сколько писем об упоминаниях проход разбирает за раз. */
const BATCH = 50;

/** Почему письма не будет: адресат к моменту отправки дела не видит. */
export const MENTION_ACCESS_LOST =
	'Адресат больше не видит дело: учётная запись выключена или доступ к делу пропал после упоминания';

export type MentionDelivery = {
	id: string;
	interactionId: string;
	recipientUserId: string;
	channel: NotificationChannel;
	attempts: number;
};

/** Строка доставки упоминания по её идентификатору; `null` — не упоминание. */
export async function readMentionDelivery(deliveryId: string): Promise<MentionDelivery | null> {
	const [row] = await getDb()
		.select({
			id: notificationDeliveries.id,
			interactionId: commentMentions.interactionId,
			recipientUserId: commentMentions.userId,
			channel: notificationDeliveries.channel,
			attempts: notificationDeliveries.attempts
		})
		.from(notificationDeliveries)
		.innerJoin(commentMentions, eq(commentMentions.id, notificationDeliveries.mentionId))
		.where(eq(notificationDeliveries.id, deliveryId))
		.limit(1);

	return row ?? null;
}

/**
 * Одна доставка: проверить адресата, отправить, записать исход. Возвращает
 * исход — его сводит в отчёт цикл и показывает кнопка повтора.
 */
export async function deliverMentionNotice(
	ctx: ActorContext,
	delivery: MentionDelivery,
	now: Date = new Date()
): Promise<NotificationDeliveryStatus> {
	const db = getDb();
	const recipient = await loadSessionUser(delivery.recipientUserId);

	if (recipient === null || !(await userSeesInteraction(recipient, delivery.interactionId))) {
		await db
			.update(notificationDeliveries)
			.set({
				status: 'skipped',
				lastError: MENTION_ACCESS_LOST,
				nextNotifyAt: null,
				updatedAt: now
			})
			.where(eq(notificationDeliveries.id, delivery.id));

		return 'skipped';
	}

	// Текст собирается заново, а не берётся из очереди: адрес установки мог
	// смениться между постановкой и отправкой.
	const message = mentionNotificationMessage(
		{ interactionId: delivery.interactionId },
		getConfig().ORIGIN
	);
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
			details: { channelKey: delivery.channel, kindKey: 'mention' }
		});
	}

	return outcome.status;
}

/**
 * Проход по созревшим письмам об упоминаниях для включённых каналов.
 * Строки выключенного канала ждут в очереди, пока его не включат.
 */
export async function runMentionDelivery(
	ctx: ActorContext,
	channels: readonly NotificationChannel[],
	now: Date
): Promise<NotificationDeliveryStatus[]> {
	if (channels.length === 0) {
		return [];
	}

	const due = await getDb()
		.select({
			id: notificationDeliveries.id,
			interactionId: commentMentions.interactionId,
			recipientUserId: commentMentions.userId,
			channel: notificationDeliveries.channel,
			attempts: notificationDeliveries.attempts
		})
		.from(notificationDeliveries)
		.innerJoin(commentMentions, eq(commentMentions.id, notificationDeliveries.mentionId))
		.where(
			and(
				eq(notificationDeliveries.kind, 'mention'),
				isNotNull(notificationDeliveries.nextNotifyAt),
				lte(notificationDeliveries.nextNotifyAt, now),
				inArray(notificationDeliveries.channel, [...channels])
			)
		)
		.orderBy(notificationDeliveries.nextNotifyAt)
		.limit(BATCH);

	const outcomes: NotificationDeliveryStatus[] = [];

	for (const delivery of due) {
		outcomes.push(await deliverMentionNotice(ctx, delivery, now));
	}

	return outcomes;
}
