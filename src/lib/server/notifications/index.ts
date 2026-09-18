/**
 * Журнал доставок уведомлений: чтение для экрана и повтор отправки.
 *
 * Прав два. Читать журнал — `notifications.read`: руководителю он отвечает на
 * вопрос «почему мне не пришло», и его срез сужается областью — видно доставки
 * по тем взаимодействиям, которые он и так видит (`docs/access-matrix.md`,
 * раздел 1: у каждой записи есть взаимодействие, через которое она видна).
 * Повторять отправку — `notifications.manage`: повтор ходит на чужой почтовый
 * сервер, и это работа администратора, а не чтение сводки.
 */
import { and, count, desc, eq } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { PageResult } from '$lib/contracts/common';
import {
	RETRIABLE_DELIVERY_STATUSES,
	type NotificationDeliveryView,
	type NotificationQuery
} from '$lib/contracts/notifications';
import type { ActorContext } from '../actor';
import { recordAuditEvent } from '../audit';
import { getDb } from '../db';
import { interactions, notificationDeliveries, stageEntries, users } from '../db/schema';
import { ConflictError, NotFoundError } from '../errors';
import { visibleInteractionFilter } from '../interactions/access';
import { requirePermission } from '../rbac';
import { getSetting } from '../settings';
import { deliverStuckNotice, readStuckEntry } from './watch';

const recipient = alias(users, 'recipient_user');

/** Журнал доставок страницей, новые сверху. */
export async function listNotificationDeliveries(
	ctx: ActorContext,
	filter: NotificationQuery
): Promise<PageResult<NotificationDeliveryView>> {
	requirePermission(ctx, 'notifications.read');

	const db = getDb();
	const conditions = [visibleInteractionFilter(ctx, notificationDeliveries.interactionId)];

	if (filter.status !== null) {
		conditions.push(eq(notificationDeliveries.status, filter.status));
	}

	if (filter.channel !== null) {
		conditions.push(eq(notificationDeliveries.channel, filter.channel));
	}

	const where = and(...conditions);

	const [{ total }] = await db.select({ total: count() }).from(notificationDeliveries).where(where);

	const rows = await db
		.select({
			id: notificationDeliveries.id,
			kind: notificationDeliveries.kind,
			interactionId: notificationDeliveries.interactionId,
			interactionTitle: interactions.title,
			stageEntryId: notificationDeliveries.stageEntryId,
			stageName: stageEntries.stageSnapshot,
			recipientUserId: notificationDeliveries.recipientUserId,
			recipientName: recipient.fullName,
			channel: notificationDeliveries.channel,
			status: notificationDeliveries.status,
			attempts: notificationDeliveries.attempts,
			lastError: notificationDeliveries.lastError,
			sentAt: notificationDeliveries.sentAt,
			nextNotifyAt: notificationDeliveries.nextNotifyAt,
			createdAt: notificationDeliveries.createdAt,
			updatedAt: notificationDeliveries.updatedAt
		})
		.from(notificationDeliveries)
		.leftJoin(interactions, eq(interactions.id, notificationDeliveries.interactionId))
		.leftJoin(stageEntries, eq(stageEntries.id, notificationDeliveries.stageEntryId))
		.leftJoin(recipient, eq(recipient.id, notificationDeliveries.recipientUserId))
		.where(where)
		.orderBy(desc(notificationDeliveries.updatedAt))
		.limit(filter.pageSize)
		.offset((filter.page - 1) * filter.pageSize);

	return {
		items: rows.map(({ stageName, ...row }) => ({
			...row,
			stageName: stageName?.name ?? null
		})),
		total,
		page: filter.page,
		pageSize: filter.pageSize
	};
}

/**
 * Повторить отправку вручную.
 *
 * Повторяется не сохранённое письмо, а то, что система сказала бы сейчас: за
 * время, прошедшее с неудачи, запись могла уехать дальше по стадии, а
 * взаимодействие — сменить название. Письмо «по состоянию на позавчера» звало
 * бы разбираться с тем, чего уже нет.
 */
export async function retryNotificationDelivery(
	ctx: ActorContext,
	deliveryId: string
): Promise<{ ok: boolean; error: string | null }> {
	await requirePermission(ctx, 'notifications.manage', { type: 'notifications.failed' });

	const [row] = await getDb()
		.select({
			id: notificationDeliveries.id,
			stageEntryId: notificationDeliveries.stageEntryId,
			channel: notificationDeliveries.channel,
			status: notificationDeliveries.status
		})
		.from(notificationDeliveries)
		.where(eq(notificationDeliveries.id, deliveryId))
		.limit(1);

	if (row === undefined) {
		throw new NotFoundError('Доставки с таким идентификатором нет');
	}

	if (!RETRIABLE_DELIVERY_STATUSES.includes(row.status)) {
		throw new ConflictError('Повторить можно только доставку, которая не отправлена');
	}

	const thresholdDays = await getSetting('stuck_threshold_days');
	const entry = await readStuckEntry(row.stageEntryId, row.channel, thresholdDays);

	if (entry === null) {
		throw new ConflictError(
			'Взаимодействие больше не стоит на этой стадии: напоминать не о чем, строка осталась историей'
		);
	}

	const status = await deliverStuckNotice(ctx, entry, row.channel, thresholdDays);

	if (status === 'sent') {
		// Проход цикла сводит свои успехи в одну запись за проход, а нажатие —
		// действие человека над конкретной записью, и в журнале оно стоит рядом с
		// тем взаимодействием, ради которого его сделали.
		await recordAuditEvent(ctx, {
			type: 'notifications.sent',
			outcome: 'success',
			subject: { type: 'interaction', id: entry.interactionId },
			details: { stageEntryId: entry.stageEntryId, channelKey: row.channel, sentCount: 1 }
		});

		return { ok: true, error: null };
	}

	const [settled] = await getDb()
		.select({ lastError: notificationDeliveries.lastError })
		.from(notificationDeliveries)
		.where(eq(notificationDeliveries.id, row.id))
		.limit(1);

	return { ok: false, error: settled?.lastError ?? null };
}
