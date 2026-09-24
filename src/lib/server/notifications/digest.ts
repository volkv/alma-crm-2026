/**
 * Утренняя сводка «Мой день» (шаг 14 процесса: сотрудник начинает день с
 * того, что требует внимания).
 *
 * Правило: раз в сутки, первым проходом фонового цикла в час сводки по Москве
 * или позже (настройка `daily_digest`, по умолчанию 08:00), каждому
 * действующему сотруднику с непустым «Моим днём» уходит одна сводка по каждому
 * включённому каналу. Список — тот же, что на главной (`getMyDay`), и считается
 * в области доступа самого получателя: сводка не расскажет о том, чего он не
 * видит на экране.
 *
 * Дедупликация — ключ журнала «вид × получатель × день × канал»
 * (`notification_deliveries_digest_key`): второй проход того же утра строку не
 * заводит. Пустой день строки не даёт вовсе — «сводки нет, потому что дел нет»
 * не событие доставки, — поэтому, чтобы каждый проход до конца суток не
 * пересчитывал «Мой день» всем сотрудникам без дел, обход отмечается в Redis
 * ключом дня. Это кэш, а не состояние: пропадёт отметка — следующий проход
 * обойдёт всех заново, и ключ журнала не даст отправить второй раз.
 *
 * Неудачная отправка повторяется в тот же день по общему правилу (через час,
 * до пяти попыток); вчерашняя сводка не повторяется — она уже неправда.
 *
 * Проход зовётся из `runNotificationCycle` — тем же фоновым циклом и под тем же
 * замком в Redis, что и наблюдатели.
 */
import { and, eq, isNotNull, lte, ne, sql } from 'drizzle-orm';
import {
	isStubChannel,
	type NotificationChannel,
	type NotificationDeliveryStatus
} from '$lib/contracts/notifications';
import { formatDate, formatIsoDay } from '$lib/format';
import type { ActorContext } from '../actor';
import { recordAuditEvent } from '../audit';
import { loadSessionUser } from '../auth/session';
import { getConfig } from '../config';
import { getDb } from '../db';
import { notificationDeliveries, users } from '../db/schema';
import { getMyDay } from '../interactions/my-day';
import { getRedis } from '../redis';
import { getSetting } from '../settings';
import { sendThroughChannel } from './channels';
import { digestNotificationMessage, type NotificationMessage } from './message';
import { digestIsDue, digestNextNotifyAt, FAILURE_RETRY_MINUTES } from './schedule';

/** Отметка «обход дня сделан»: живёт дольше суток, чтобы пережить полночь. */
const DONE_KEY_PREFIX = 'notifications:digest:done:';
const DONE_TTL_SECONDS = 36 * 60 * 60;

/** Причина, по которой неудачную сводку больше не повторяют. */
const GONE_ERROR =
	'Повторять нечего: у получателя больше нет дел на сегодня или его учётная запись выключена';

async function claim(
	recipientUserId: string,
	day: string,
	channel: NotificationChannel,
	message: NotificationMessage,
	now: Date
): Promise<{ id: string; attempts: number }> {
	const retryAt = new Date(now.getTime() + FAILURE_RETRY_MINUTES * 60 * 1000);

	const [row] = await getDb()
		.insert(notificationDeliveries)
		.values({
			kind: 'daily_digest',
			recipientUserId,
			digestDay: day,
			channel,
			status: 'queued',
			subject: message.subject,
			body: message.text,
			nextNotifyAt: retryAt
		})
		.onConflictDoUpdate({
			target: [
				notificationDeliveries.kind,
				notificationDeliveries.recipientUserId,
				notificationDeliveries.digestDay,
				notificationDeliveries.channel
			],
			targetWhere: sql`${notificationDeliveries.digestDay} is not null`,
			set: {
				status: 'queued',
				subject: message.subject,
				body: message.text,
				nextNotifyAt: retryAt,
				updatedAt: now
			}
		})
		.returning({ id: notificationDeliveries.id, attempts: notificationDeliveries.attempts });

	return row;
}

/**
 * Сводка одному сотруднику по перечисленным каналам: собрать «Мой день» в его
 * области, и по каждому каналу занять строку, отправить, записать исход.
 * Пустой ответ — сводки нет: сотрудник выключен, без права на взаимодействия
 * или дел у него сегодня нет.
 */
export async function deliverDigest(
	ctx: ActorContext,
	recipientUserId: string,
	channels: readonly NotificationChannel[],
	now: Date = new Date()
): Promise<NotificationDeliveryStatus[]> {
	const recipient = await loadSessionUser(recipientUserId);

	if (recipient === null || !recipient.permissions.has('interactions.read')) {
		return [];
	}

	// Список считается в области получателя, а не фонового цикла: у цикла
	// область полная, и сводка рассказала бы о чужой работе.
	const day = await getMyDay({ ...ctx, user: recipient, scope: recipient.scope }, now);

	if (day.sections.length === 0) {
		return [];
	}

	const isoDay = formatIsoDay(now);
	const message = digestNotificationMessage({ day, dayLabel: formatDate(now) }, getConfig().ORIGIN);
	const outcomes: NotificationDeliveryStatus[] = [];

	for (const channel of channels) {
		const claimed = await claim(recipient.id, isoDay, channel, message, now);
		const outcome = await sendThroughChannel(
			channel,
			{ userId: recipient.id, fullName: recipient.fullName, email: recipient.email },
			message
		);
		const attempts = isStubChannel(channel) ? claimed.attempts : claimed.attempts + 1;

		await getDb()
			.update(notificationDeliveries)
			.set({
				status: outcome.status,
				attempts,
				lastError: outcome.error,
				sentAt: outcome.status === 'sent' ? now : sql`${notificationDeliveries.sentAt}`,
				nextNotifyAt: digestNextNotifyAt({ status: outcome.status, attempts }, now),
				updatedAt: now
			})
			.where(eq(notificationDeliveries.id, claimed.id));

		if (outcome.status === 'failed') {
			await recordAuditEvent(ctx, {
				type: 'notifications.failed',
				outcome: 'failure',
				subject: { type: 'user', id: recipient.id },
				details: { channelKey: channel, kindKey: 'daily_digest' }
			});
		}

		outcomes.push(outcome.status);
	}

	return outcomes;
}

/**
 * Проход сводки для включённых каналов. Возвращает исходы попыток — их сводит
 * в отчёт `runNotificationCycle`.
 */
export async function runDailyDigest(
	ctx: ActorContext,
	channels: readonly NotificationChannel[],
	now: Date
): Promise<NotificationDeliveryStatus[]> {
	if (channels.length === 0 || !digestIsDue(await getSetting('daily_digest'), now)) {
		return [];
	}

	const day = formatIsoDay(now);
	const db = getDb();
	const outcomes: NotificationDeliveryStatus[] = [];

	// Сначала — неудачные сегодняшние, чей срок повтора пришёл.
	const retries = await db
		.select({
			id: notificationDeliveries.id,
			recipientUserId: notificationDeliveries.recipientUserId,
			channel: notificationDeliveries.channel
		})
		.from(notificationDeliveries)
		.where(
			and(
				eq(notificationDeliveries.kind, 'daily_digest'),
				eq(notificationDeliveries.digestDay, day),
				isNotNull(notificationDeliveries.recipientUserId),
				lte(notificationDeliveries.nextNotifyAt, now)
			)
		);

	for (const row of retries) {
		if (row.recipientUserId === null || !channels.includes(row.channel)) {
			continue;
		}

		const statuses = await deliverDigest(ctx, row.recipientUserId, [row.channel], now);

		if (statuses.length === 0) {
			// Дела кончились раньше, чем почта починилась, или получателя
			// выключили: повторять нечего, а строка остаётся историей с причиной.
			await db
				.update(notificationDeliveries)
				.set({ nextNotifyAt: null, lastError: GONE_ERROR, updatedAt: now })
				.where(eq(notificationDeliveries.id, row.id));
		}

		outcomes.push(...statuses);
	}

	const redis = getRedis();
	const doneKey = `${DONE_KEY_PREFIX}${day}`;

	if ((await redis.get(doneKey)) !== null) {
		return outcomes;
	}

	const [staff, sent] = await Promise.all([
		db
			.select({ id: users.id })
			.from(users)
			// Машинный субъект не читает почту и входа не имеет.
			.where(and(eq(users.isActive, true), ne(users.roleId, 'service'))),
		db
			.select({
				recipientUserId: notificationDeliveries.recipientUserId,
				channel: notificationDeliveries.channel
			})
			.from(notificationDeliveries)
			.where(
				and(
					eq(notificationDeliveries.kind, 'daily_digest'),
					eq(notificationDeliveries.digestDay, day)
				)
			)
	]);

	const already = new Set(sent.map((row) => `${row.recipientUserId}:${row.channel}`));

	for (const person of staff) {
		const missing = channels.filter((channel) => !already.has(`${person.id}:${channel}`));

		if (missing.length > 0) {
			outcomes.push(...(await deliverDigest(ctx, person.id, missing, now)));
		}
	}

	await redis.set(doneKey, '1', 'EX', DONE_TTL_SECONDS);

	return outcomes;
}
