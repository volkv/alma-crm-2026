/**
 * Уведомление «Дело вошло на стадию».
 *
 * Администратор включает его у стадии в редакторе процесса и выбирает адресата:
 * ответственного за дело или его руководителя (`stages.on_enter_notify`).
 * Строки ставит сама команда движения — той же транзакцией, в которой открыта
 * запись стадии (`stages/commands.ts`): откатится переход — не останется и
 * уведомления о нём. Отправляет их проход фонового цикла уведомлений под тем же
 * замком в Redis, что и остальные: одно письмо уходит один раз и между
 * процессами.
 *
 * Перенос записей публикацией изменённого процесса (`migrateEntries`)
 * уведомления не даёт: дело на новую стадию переставил администратор правкой
 * структуры, а не работа по нему, и письмо «дело дошло до подписания» о таком
 * переезде было бы неправдой.
 *
 * Кому письма не будет — решается двумя проверками, и обе оставляют строку в
 * журнале со статусом «получатель не определён» и причиной словами:
 * - при постановке: адресат — тот самый сотрудник, который двигает дело (о
 *   собственном действии уведомлять незачем), у дела нет ответственного или у
 *   ответственного не указан руководитель;
 * - перед отправкой: адресат выключен или больше не видит дело — тем же
 *   правилом, по которому ему открывается карточка (`live/viewers.ts`).
 *
 * Одно уведомление на запись стадии и канал держит ключ дедупликации журнала
 * «вид × запись стадии × канал». Неудачная отправка повторяется по общему
 * правилу (через час, до пяти попыток) и кнопкой «Повторить» в журнале.
 */
import { and, eq, inArray, isNotNull, lte, sql } from 'drizzle-orm';
import type { StageEnterNotifyTarget } from '$lib/contracts/interactions';
import {
	isStubChannel,
	NOTIFICATION_CHANNELS,
	type NotificationChannel,
	type NotificationDeliveryStatus
} from '$lib/contracts/notifications';
import type { ActorContext } from '../actor';
import { recordAuditEvent } from '../audit';
import { loadSessionUser } from '../auth/session';
import { getConfig } from '../config';
import { getDb } from '../db';
import { notificationDeliveries, stageEntries, users } from '../db/schema';
import type { Tx } from '../db/transaction';
import { userSeesInteraction } from '../live/viewers';
import { getSetting } from '../settings';
import { sendThroughChannel } from './channels';
import { stageEnteredNotificationMessage } from './message';
import { MIN_REPEAT_DAYS, nextNotifyAt } from './schedule';

/** Сколько писем о входе на стадию проход разбирает за раз. */
const BATCH = 50;

/** Почему письма не будет: адресат сам перевёл дело на стадию. */
export const STAGE_ENTER_SELF =
	'Адресат сам перевёл дело на эту стадию: уведомлять человека о его собственном действии незачем';

/** Почему письма не будет: руководителя у ответственного нет. */
export const STAGE_ENTER_NO_MANAGER =
	'У ответственного за дело не указан руководитель: уведомлять некого. Назначьте руководителя в разделе «Пользователи»';

/** Почему письма не будет: у дела ещё нет ответственного. */
export const STAGE_ENTER_NO_OWNER =
	'У дела не назначен ответственный: уведомлять некого. Назначьте ответственного на карточке дела';

/** Почему письма не будет: адресат к моменту отправки дела не видит. */
export const STAGE_ENTER_ACCESS_LOST =
	'Адресат больше не видит дело: учётная запись выключена или доступ к делу пропал после перехода';

/** Что известно о входе в момент перехода: всё, что нужно строке журнала. */
export type StageEnterFacts = {
	interactionId: string;
	stageEntryId: string;
	stageName: string;
	/** Кого уведомить по настройке стадии; `null` — стадия не уведомляет. */
	target: StageEnterNotifyTarget | null;
	/** Ответственный за дело в момент входа; `null` — ещё не назначен. */
	ownerUserId: string | null;
};

/** Кому адресовано уведомление — или почему его не будет. */
async function resolveRecipient(
	tx: Tx,
	target: StageEnterNotifyTarget,
	ownerUserId: string | null
): Promise<string | null> {
	if (ownerUserId === null) {
		return null;
	}

	if (target === 'responsible') {
		return ownerUserId;
	}

	const [owner] = await tx
		.select({ managerUserId: users.managerUserId })
		.from(users)
		.where(eq(users.id, ownerUserId))
		.limit(1);

	return owner?.managerUserId ?? null;
}

/**
 * Поставить уведомление о входе на стадию — той же транзакцией, что и сам
 * вход. Письма ставятся по каналам, включённым в момент перехода; отправляет
 * их фоновый цикл после фиксации: почтовый сервер отвечает до пяти секунд, и
 * держать на нём транзакцию с блокировкой дела нельзя.
 *
 * Возвращает, сколько строк поставлено; стадия без уведомления — ноль.
 */
export async function queueStageEnterNotice(
	ctx: ActorContext,
	tx: Tx,
	facts: StageEnterFacts
): Promise<number> {
	if (facts.target === null) {
		return 0;
	}

	const switches = await getSetting('notification_channels');
	const channels = NOTIFICATION_CHANNELS.filter((channel) => switches[channel]);

	if (channels.length === 0) {
		return 0;
	}

	const recipientUserId = await resolveRecipient(tx, facts.target, facts.ownerUserId);
	const moverId = ctx.user?.id ?? null;
	const refusal =
		facts.ownerUserId === null
			? STAGE_ENTER_NO_OWNER
			: recipientUserId === null
				? STAGE_ENTER_NO_MANAGER
				: recipientUserId === moverId
					? STAGE_ENTER_SELF
					: null;
	const message = stageEnteredNotificationMessage(
		{ interactionId: facts.interactionId, stageName: facts.stageName },
		getConfig().ORIGIN
	);

	const queued = await tx
		.insert(notificationDeliveries)
		.values(
			channels.map((channel) => ({
				kind: 'stage_entered' as const,
				interactionId: facts.interactionId,
				stageEntryId: facts.stageEntryId,
				recipientUserId,
				channel,
				status: refusal === null ? ('queued' as const) : ('skipped' as const),
				subject: message.subject,
				body: message.text,
				lastError: refusal,
				nextNotifyAt: refusal === null ? sql`now()` : null
			}))
		)
		.onConflictDoNothing({
			target: [
				notificationDeliveries.kind,
				notificationDeliveries.stageEntryId,
				notificationDeliveries.channel
			]
		})
		.returning({ id: notificationDeliveries.id });

	// Пропуск «руководителя нет» ждёт человека — назначения в иерархии — и
	// пишется в журнал действий поимённо, как у напоминаний о зависшем. Пропуск
	// «адресат двигал дело сам» — штатный исход, чинить в нём нечего.
	if (refusal === STAGE_ENTER_NO_MANAGER && queued.length > 0) {
		await recordAuditEvent(
			ctx,
			{
				type: 'notifications.skipped',
				outcome: 'failure',
				subject: { type: 'interaction', id: facts.interactionId },
				details: { stageEntryId: facts.stageEntryId, kindKey: 'stage_entered' }
			},
			tx
		);
	}

	return queued.length;
}

export type StageEnterDelivery = {
	id: string;
	interactionId: string;
	stageEntryId: string;
	stageName: string;
	recipientUserId: string | null;
	channel: NotificationChannel;
	attempts: number;
};

const deliveryColumns = {
	id: notificationDeliveries.id,
	interactionId: stageEntries.interactionId,
	stageEntryId: stageEntries.id,
	// Название — из слепка записи: письмо называет ту стадию, на которую дело
	// вошло, даже если процесс с тех пор переиздали.
	stageName: sql<string>`${stageEntries.stageSnapshot} ->> 'name'`,
	recipientUserId: notificationDeliveries.recipientUserId,
	channel: notificationDeliveries.channel,
	attempts: notificationDeliveries.attempts
};

/** Строка доставки уведомления о входе по её идентификатору; `null` — не такая строка. */
export async function readStageEnterDelivery(
	deliveryId: string
): Promise<StageEnterDelivery | null> {
	const [row] = await getDb()
		.select(deliveryColumns)
		.from(notificationDeliveries)
		.innerJoin(stageEntries, eq(stageEntries.id, notificationDeliveries.stageEntryId))
		.where(
			and(
				eq(notificationDeliveries.id, deliveryId),
				eq(notificationDeliveries.kind, 'stage_entered')
			)
		)
		.limit(1);

	return row ?? null;
}

/**
 * Одна доставка: проверить адресата, отправить, записать исход. Возвращает
 * исход — его сводит в отчёт цикл и показывает кнопка повтора.
 */
export async function deliverStageEnterNotice(
	ctx: ActorContext,
	delivery: StageEnterDelivery,
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
				lastError: STAGE_ENTER_ACCESS_LOST,
				nextNotifyAt: null,
				updatedAt: now
			})
			.where(eq(notificationDeliveries.id, delivery.id));

		await recordAuditEvent(ctx, {
			type: 'notifications.skipped',
			outcome: 'failure',
			subject: { type: 'interaction', id: delivery.interactionId },
			details: {
				stageEntryId: delivery.stageEntryId,
				channelKey: delivery.channel,
				kindKey: 'stage_entered'
			}
		});

		return 'skipped';
	}

	// Текст собирается заново, а не берётся из очереди: адрес установки мог
	// смениться между постановкой и отправкой.
	const message = stageEnteredNotificationMessage(
		{ interactionId: delivery.interactionId, stageName: delivery.stageName },
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
			details: {
				stageEntryId: delivery.stageEntryId,
				channelKey: delivery.channel,
				kindKey: 'stage_entered'
			}
		});
	}

	return outcome.status;
}

/**
 * Проход по созревшим уведомлениям о входе на стадию для включённых каналов.
 * Строки выключенного канала ждут в очереди, пока его не включат.
 */
export async function runStageEnterDelivery(
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
		.innerJoin(stageEntries, eq(stageEntries.id, notificationDeliveries.stageEntryId))
		.where(
			and(
				eq(notificationDeliveries.kind, 'stage_entered'),
				isNotNull(notificationDeliveries.nextNotifyAt),
				lte(notificationDeliveries.nextNotifyAt, now),
				inArray(notificationDeliveries.channel, [...channels])
			)
		)
		.orderBy(notificationDeliveries.nextNotifyAt)
		.limit(BATCH);

	const outcomes: NotificationDeliveryStatus[] = [];

	for (const delivery of due) {
		outcomes.push(await deliverStageEnterNotice(ctx, delivery, now));
	}

	return outcomes;
}
