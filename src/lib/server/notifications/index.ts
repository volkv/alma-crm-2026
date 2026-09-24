/**
 * Журнал доставок уведомлений: чтение для экрана и повтор отправки.
 *
 * Прав два. Читать журнал — `notifications.read`: руководителю он отвечает на
 * вопрос «почему мне не пришло», и его срез сужается областью — видно доставки
 * по тем взаимодействиям, которые он и так видит (`docs/access-matrix.md`,
 * раздел 1: у каждой записи есть взаимодействие, через которое она видна), а
 * уведомления о лицензиях — по организациям, которые он видит: у них предмет —
 * позиция договора, а договор живёт у организации; утренние сводки — по
 * получателям в его области (свои и подчинённых): у сводки предмет — сам
 * получатель.
 * Повторять отправку — `notifications.manage`: повтор ходит на чужой почтовый
 * сервер, и это работа администратора, а не чтение сводки.
 */
import { and, count, desc, eq, isNotNull, or, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { PageResult } from '$lib/contracts/common';
import {
	isLicenseKind,
	RETRIABLE_DELIVERY_STATUSES,
	type LicenseNotificationKind,
	type NotificationChannel,
	type NotificationDeliveryStatus,
	type NotificationDeliveryView,
	type NotificationQuery
} from '$lib/contracts/notifications';
import { formatIsoDay } from '$lib/format';
import type { ActorContext } from '../actor';
import { recordAuditEvent } from '../audit';
import { getDb } from '../db';
import {
	contractItems,
	contracts,
	interactions,
	notificationDeliveries,
	organizations,
	products,
	stageEntries,
	users
} from '../db/schema';
import { ConflictError, NotFoundError } from '../errors';
import { visibleInteractionFilter, visibleOrganizationFilter } from '../interactions/access';
import { actorScopeFilter, requirePermission } from '../rbac';
import { getSetting } from '../settings';
import { deliverDigest } from './digest';
import { deliverLicenseNotice, readLicenseEntry } from './license-watch';
import { deliverMentionNotice, readMentionDelivery } from './mention';
import { deliverStuckNotice, readStuckEntry } from './watch';

const recipient = alias(users, 'recipient_user');

/** Журнал доставок страницей, новые сверху. */
export async function listNotificationDeliveries(
	ctx: ActorContext,
	filter: NotificationQuery
): Promise<PageResult<NotificationDeliveryView>> {
	requirePermission(ctx, 'notifications.read');

	const db = getDb();
	const conditions: SQL[] = [
		or(
			and(
				isNotNull(notificationDeliveries.interactionId),
				visibleInteractionFilter(ctx, notificationDeliveries.interactionId)
			),
			and(
				isNotNull(notificationDeliveries.contractItemId),
				visibleOrganizationFilter(ctx, contracts.organizationId)
			),
			and(
				isNotNull(notificationDeliveries.digestDay),
				actorScopeFilter(ctx, notificationDeliveries.recipientUserId)
			)
		) as SQL
	];

	if (filter.status !== null) {
		conditions.push(eq(notificationDeliveries.status, filter.status));
	}

	if (filter.channel !== null) {
		conditions.push(eq(notificationDeliveries.channel, filter.channel));
	}

	const where = and(...conditions);

	const [{ total }] = await db
		.select({ total: count() })
		.from(notificationDeliveries)
		.leftJoin(contractItems, eq(contractItems.id, notificationDeliveries.contractItemId))
		.leftJoin(contracts, eq(contracts.id, contractItems.contractId))
		.where(where);

	const rows = await db
		.select({
			id: notificationDeliveries.id,
			kind: notificationDeliveries.kind,
			interactionId: notificationDeliveries.interactionId,
			interactionTitle: interactions.title,
			stageEntryId: notificationDeliveries.stageEntryId,
			stageName: stageEntries.stageSnapshot,
			contractItemId: notificationDeliveries.contractItemId,
			organizationId: organizations.id,
			organizationName: organizations.shortName,
			productName: products.name,
			licenseUntil: notificationDeliveries.licenseUntil,
			digestDay: notificationDeliveries.digestDay,
			recipientUserId: notificationDeliveries.recipientUserId,
			recipientName: recipient.fullName,
			channel: notificationDeliveries.channel,
			status: notificationDeliveries.status,
			subject: notificationDeliveries.subject,
			body: notificationDeliveries.body,
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
		.leftJoin(contractItems, eq(contractItems.id, notificationDeliveries.contractItemId))
		.leftJoin(contracts, eq(contracts.id, contractItems.contractId))
		.leftJoin(organizations, eq(organizations.id, contracts.organizationId))
		.leftJoin(products, eq(products.id, contractItems.productId))
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
			kind: notificationDeliveries.kind,
			stageEntryId: notificationDeliveries.stageEntryId,
			contractItemId: notificationDeliveries.contractItemId,
			licenseUntil: notificationDeliveries.licenseUntil,
			digestDay: notificationDeliveries.digestDay,
			recipientUserId: notificationDeliveries.recipientUserId,
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

	const status =
		row.kind === 'mention'
			? await retryMention(ctx, row.id)
			: row.kind === 'daily_digest'
				? await retryDigest(ctx, row.recipientUserId, row.digestDay, row.channel)
				: isLicenseKind(row.kind)
					? await retryLicense(ctx, row.kind, row.contractItemId, row.licenseUntil, row.channel)
					: await retryStuck(ctx, row.stageEntryId, row.channel);

	if (status === 'sent') {
		return { ok: true, error: null };
	}

	const [settled] = await getDb()
		.select({ lastError: notificationDeliveries.lastError })
		.from(notificationDeliveries)
		.where(eq(notificationDeliveries.id, row.id))
		.limit(1);

	return { ok: false, error: settled?.lastError ?? null };
}

/**
 * Повтор напоминания о зависшем. Проход цикла сводит свои успехи в одну запись
 * за проход, а нажатие — действие человека над конкретной записью, и в журнале
 * оно стоит рядом с тем взаимодействием, ради которого его сделали.
 */
async function retryStuck(
	ctx: ActorContext,
	stageEntryId: string | null,
	channel: NotificationChannel
): Promise<NotificationDeliveryStatus> {
	if (stageEntryId === null) {
		throw new Error('Строка напоминания о зависшем без записи стадии: проверка таблицы нарушена');
	}

	const thresholdDays = await getSetting('stuck_threshold_days');
	const entry = await readStuckEntry(stageEntryId, channel, thresholdDays);

	if (entry === null) {
		throw new ConflictError(
			'Взаимодействие больше не стоит на этой стадии: напоминать не о чем, строка осталась историей'
		);
	}

	const status = await deliverStuckNotice(ctx, entry, channel, thresholdDays);

	if (status === 'sent') {
		await recordAuditEvent(ctx, {
			type: 'notifications.sent',
			outcome: 'success',
			subject: { type: 'interaction', id: entry.interactionId },
			details: { stageEntryId: entry.stageEntryId, channelKey: channel, sentCount: 1 }
		});
	}

	return status;
}

/**
 * Повтор уведомления о лицензии. Позиция читается заново: срок могли продлить
 * или договор закрыть — тогда говорить не о чем.
 */
async function retryLicense(
	ctx: ActorContext,
	kind: LicenseNotificationKind,
	contractItemId: string | null,
	licenseUntil: string | null,
	channel: NotificationChannel
): Promise<NotificationDeliveryStatus> {
	if (contractItemId === null || licenseUntil === null) {
		throw new Error(
			'Строка уведомления о лицензии без позиции договора: проверка таблицы нарушена'
		);
	}

	const entry = await readLicenseEntry(contractItemId, kind, channel);

	if (entry === null || entry.licenseUntil !== licenseUntil) {
		throw new ConflictError(
			'Срок лицензии по позиции изменился или договор закрыт: напоминать не о чем, строка осталась историей'
		);
	}

	const status = await deliverLicenseNotice(ctx, entry, kind, channel);

	if (status === 'sent') {
		await recordAuditEvent(ctx, {
			type: 'notifications.sent',
			outcome: 'success',
			subject: { type: 'contract_item', id: contractItemId },
			details: { organizationId: entry.organizationId, channelKey: channel, sentCount: 1 }
		});
	}

	return status;
}

/**
 * Повтор утренней сводки. Сводка собирается заново на сейчас и только за
 * сегодня: вчерашний список дел сегодня уже неправда.
 */
async function retryDigest(
	ctx: ActorContext,
	recipientUserId: string | null,
	digestDay: string | null,
	channel: NotificationChannel
): Promise<NotificationDeliveryStatus> {
	if (digestDay === null) {
		throw new Error('Строка утренней сводки без дня: проверка таблицы нарушена');
	}

	if (recipientUserId === null) {
		throw new ConflictError('Получателя сводки больше нет: повторять некому');
	}

	if (digestDay !== formatIsoDay()) {
		throw new ConflictError('Сводка за прошедший день: повторять нечего, строка осталась историей');
	}

	const [status] = await deliverDigest(ctx, recipientUserId, [channel]);

	if (status === undefined) {
		throw new ConflictError(
			'У получателя больше нет дел на сегодня или его учётная запись выключена: сводке не о чем сказать'
		);
	}

	if (status === 'sent') {
		await recordAuditEvent(ctx, {
			type: 'notifications.sent',
			outcome: 'success',
			subject: { type: 'user', id: recipientUserId },
			details: { channelKey: channel, kindKey: 'daily_digest', sentCount: 1 }
		});
	}

	return status;
}

/**
 * Повтор письма об упоминании. Адресат проверяется заново, как и в цикле:
 * потерял доступ к делу — письма нет, строка получает причину.
 */
async function retryMention(
	ctx: ActorContext,
	deliveryId: string
): Promise<NotificationDeliveryStatus> {
	const delivery = await readMentionDelivery(deliveryId);

	if (delivery === null) {
		throw new Error('Строка письма об упоминании без упоминания: проверка таблицы нарушена');
	}

	const status = await deliverMentionNotice(ctx, delivery);

	if (status === 'sent') {
		await recordAuditEvent(ctx, {
			type: 'notifications.sent',
			outcome: 'success',
			subject: { type: 'interaction', id: delivery.interactionId },
			details: { channelKey: delivery.channel, kindKey: 'mention', sentCount: 1 }
		});
	}

	return status;
}
