/**
 * Наблюдатель зависших взаимодействий.
 *
 * Правило одно: **взаимодействие стоит на одной стадии дольше порога**. Это не
 * «по нему давно ничего не происходило» — протухание считается отдельно и по
 * последней активности (`stages/status.ts`), а здесь речь о часах стадии, тех
 * самых, что показывает карточка и по которым строится отчёт. Часы берутся из
 * представления `stage_entry_status`, а не считаются заново: второе вычисление
 * того же срока однажды разойдётся с первым, и письмо придёт о записи, которая
 * на экране идёт в срок.
 *
 * Паузы в срок не входят, и запись **на открытой паузе не эскалируется вовсе**:
 * пауза значит «часы стоят, ждём ответа вуза», она заведена человеком с
 * причиной и видна в карточке. Напоминать о ней руководителю — значит требовать
 * действий там, где действие уже названо.
 *
 * Получатель — руководитель ответственного за взаимодействие
 * (`users.manager_user_id` владельца). Иерархия та же, на которой держится
 * область доступа руководителя: две иерархии в системе однажды разойдутся
 * (`docs/access-matrix.md`, раздел 1). Руководителя нет или он выключен —
 * письма нет, но есть строка журнала со статусом «получатель не определён» и
 * причиной словами: эскалация, пропавшая молча, хуже эскалации, которая не
 * состоялась. Выключенная запись проверяется наравне с отсутствующей: адрес
 * уволенного остаётся в базе, и письмо о зависшей работе ушло бы наружу тому,
 * кому вход в систему уже закрыт. Руководитель, не включённый в пространство
 * взаимодействия, — тот же случай «некому»: письмо рассказало бы ему о работе
 * направления, которой он в системе не видит, — это утечка через почту, а не
 * эскалация.
 *
 * Проход зовётся из `runIntegrationsCycle` под тем же замком в Redis
 * (`integrations/pump.ts`): приложение работает в нескольких процессах, а одно
 * напоминание должно уйти один раз.
 */
import { and, eq, isNotNull, isNull, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
	isStubChannel,
	NOTIFICATION_CHANNELS,
	type NotificationChannel,
	type NotificationDeliveryStatus
} from '$lib/contracts/notifications';
import type { ActorContext } from '../actor';
import { recordAuditEvent } from '../audit';
import { getConfig } from '../config';
import { getDb } from '../db';
import {
	interactionParties,
	interactions,
	notificationDeliveries,
	organizations,
	stageEntries,
	stageEntryStatus,
	users
} from '../db/schema';
import { workspaceAccessCondition } from '../rbac/workspaces';
import { getSetting } from '../settings';
import { sendThroughChannel, type ChannelOutcome, type NotificationRecipient } from './channels';
import { runLicenseWatch } from './license-watch';
import { stuckNotificationMessage, type NotificationMessage } from './message';
import { FAILURE_RETRY_MINUTES, nextNotifyAt } from './schedule';

/** Сколько записей наблюдатель разбирает за один проход одного канала. */
const BATCH = 50;

const SECONDS_PER_DAY = 24 * 60 * 60;

/** Что проход сделал: числа для лога и для проверок. */
export type NotificationReport = {
	scanned: number;
	sent: number;
	failed: number;
	skipped: number;
	stubbed: number;
};

function emptyReport(): NotificationReport {
	return { scanned: 0, sent: 0, failed: 0, skipped: 0, stubbed: 0 };
}

/** Зависшая запись стадии вместе со всем, что нужно письму и строке журнала. */
export type StuckEntry = {
	stageEntryId: string;
	interactionId: string;
	interactionTitle: string;
	stageName: string;
	organizationName: string | null;
	activeSeconds: number;
	recipientUserId: string | null;
	recipientName: string | null;
	recipientEmail: string | null;
	/**
	 * Работает ли ещё адресат. `null` — руководителя нет вовсе; `false` — он
	 * указан, но его учётная запись выключена, и письмо ушло бы тому, кого в
	 * системе больше нет.
	 */
	recipientIsActive: boolean | null;
	/**
	 * Работает ли адресат в пространстве взаимодействия. Без этого письмо
	 * уходит мимо границы доступа: взаимодействия на экране он не видит, а
	 * название, вуз и стадия приходят ему в почту.
	 */
	recipientInWorkspace: boolean | null;
};

const owner = alias(users, 'owner_user');
const manager = alias(users, 'manager_user');

/**
 * Выборка «запись стоит дольше порога» вместе с адресатом и названием стороны.
 *
 * Название стадии берётся из слепка записи (`stage_snapshot`), а не из таблицы
 * стадий: маршрут могли переиздать, а письмо обязано называть ту стадию, на
 * которой запись стоит. Адресат приезжает тем же запросом — иначе выбранные
 * записи пришлось бы разбирать по одной, спрашивая базу про каждого владельца.
 */
async function readStuck(options: {
	channel: NotificationChannel;
	thresholdDays: number;
	/** `true` — только те, которым пришёл срок напомнить. */
	dueOnly: boolean;
	/** Одна запись вместо выборки: её читает повтор из журнала. */
	stageEntryId?: string;
	limit: number;
}): Promise<StuckEntry[]> {
	const conditions = [
		isNull(stageEntries.leftAt),
		eq(interactions.status, 'active'),
		// Пауза останавливает часы стадии — значит, и напоминание: ждать ответа
		// вуза и стоять без движения система различает.
		eq(stageEntryStatus.isPaused, false),
		sql`${stageEntryStatus.activeSeconds} > ${options.thresholdDays * SECONDS_PER_DAY}`
	];

	if (options.stageEntryId !== undefined) {
		conditions.push(eq(stageEntries.id, options.stageEntryId));
	}

	if (options.dueOnly) {
		conditions.push(
			or(
				isNull(notificationDeliveries.id),
				and(
					isNotNull(notificationDeliveries.nextNotifyAt),
					sql`${notificationDeliveries.nextNotifyAt} <= now()`
				)
			) as SQL
		);
	}

	return (
		getDb()
			.select({
				stageEntryId: stageEntries.id,
				interactionId: interactions.id,
				interactionTitle: interactions.title,
				stageName: sql<string>`coalesce(${stageEntries.stageSnapshot} ->> 'name', 'стадия')`,
				organizationName: organizations.shortName,
				activeSeconds: stageEntryStatus.activeSeconds,
				recipientUserId: manager.id,
				recipientName: manager.fullName,
				recipientEmail: manager.email,
				recipientIsActive: manager.isActive,
				recipientInWorkspace: sql<
					boolean | null
				>`case when ${manager.id} is null then null else ${workspaceAccessCondition(
					{ id: manager.id, roleId: manager.roleId },
					interactions.workspaceId
				)} end`
			})
			.from(stageEntries)
			.innerJoin(interactions, eq(interactions.id, stageEntries.interactionId))
			.innerJoin(stageEntryStatus, eq(stageEntryStatus.stageEntryId, stageEntries.id))
			.innerJoin(owner, eq(owner.id, interactions.ownerUserId))
			.leftJoin(manager, eq(manager.id, owner.managerUserId))
			.leftJoin(
				interactionParties,
				and(
					eq(interactionParties.interactionId, interactions.id),
					eq(interactionParties.isPrimary, true)
				)
			)
			.leftJoin(organizations, eq(organizations.id, interactionParties.organizationId))
			.leftJoin(
				notificationDeliveries,
				and(
					eq(notificationDeliveries.stageEntryId, stageEntries.id),
					eq(notificationDeliveries.kind, 'stage_stuck'),
					eq(notificationDeliveries.channel, options.channel)
				)
			)
			.where(and(...conditions))
			// Первыми — те, что стоят дольше всех: пачка кончается на самых свежих, а
			// не на случайных.
			.orderBy(sql`${stageEntryStatus.activeSeconds} desc`)
			.limit(options.limit)
	);
}

/** Та же запись по идентификатору: её читает повтор из журнала. */
export async function readStuckEntry(
	stageEntryId: string,
	channel: NotificationChannel,
	thresholdDays: number
): Promise<StuckEntry | null> {
	const [row] = await readStuck({
		channel,
		thresholdDays,
		dueOnly: false,
		stageEntryId,
		limit: 1
	});

	return row ?? null;
}

/**
 * Занять строку доставки до отправки.
 *
 * Сначала строка, потом письмо — и никогда наоборот. Упади процесс между двумя
 * шагами при обратном порядке, письмо ушло бы, а следа не осталось, и следующий
 * проход отправил бы его снова. Так строка остаётся в состоянии «ждёт отправки»
 * с ближайшим сроком повтора: и видно её в журнале, и повторится она сама.
 */
async function claim(
	entry: StuckEntry,
	channel: NotificationChannel,
	message: NotificationMessage,
	now: Date
): Promise<{ id: string; attempts: number }> {
	const retryAt = new Date(now.getTime() + FAILURE_RETRY_MINUTES * 60 * 1000);

	const [row] = await getDb()
		.insert(notificationDeliveries)
		.values({
			kind: 'stage_stuck',
			interactionId: entry.interactionId,
			stageEntryId: entry.stageEntryId,
			recipientUserId: entry.recipientUserId,
			channel,
			status: 'queued',
			subject: message.subject,
			body: message.text,
			nextNotifyAt: retryAt
		})
		.onConflictDoUpdate({
			target: [
				notificationDeliveries.kind,
				notificationDeliveries.stageEntryId,
				notificationDeliveries.channel
			],
			set: {
				status: 'queued',
				recipientUserId: entry.recipientUserId,
				// Текст переписывается вместе с попыткой: повтор шлёт не сохранённое
				// письмо, а то, что система говорит сейчас, — и строка журнала обязана
				// показывать именно его.
				subject: message.subject,
				body: message.text,
				nextNotifyAt: retryAt,
				updatedAt: now
			}
		})
		.returning({ id: notificationDeliveries.id, attempts: notificationDeliveries.attempts });

	return row;
}

/** Записать исход попытки в ту же строку. */
async function settle(
	deliveryId: string,
	outcome: { status: NotificationDeliveryStatus; error: string | null; attempts: number },
	thresholdDays: number,
	now: Date
): Promise<void> {
	await getDb()
		.update(notificationDeliveries)
		.set({
			status: outcome.status,
			attempts: outcome.attempts,
			lastError: outcome.error,
			sentAt: outcome.status === 'sent' ? now : sql`${notificationDeliveries.sentAt}`,
			nextNotifyAt: nextNotifyAt(outcome, thresholdDays, now),
			updatedAt: now
		})
		.where(eq(notificationDeliveries.id, deliveryId));
}

/**
 * Кому слать — или почему слать некому.
 *
 * Все исходы «некому» дают одно состояние доставки (`skipped`) и разные слова в
 * причине: незаполненная иерархия чинится назначением руководителя,
 * выключенная запись — заменой его на действующего, а руководитель вне
 * пространства — включением в него. Одинаковая фраза на разные дела заставила
 * бы администратора искать вслепую.
 */
function checkRecipient(
	entry: StuckEntry
): { ok: true; recipient: NotificationRecipient } | { ok: false; error: string } {
	if (entry.recipientUserId === null || entry.recipientName === null) {
		return {
			ok: false,
			error:
				'У ответственного за взаимодействие не указан руководитель: эскалировать некому. Назначьте руководителя в разделе «Пользователи»'
		};
	}

	if (entry.recipientIsActive !== true) {
		return {
			ok: false,
			error:
				'Руководитель ответственного выключен: письмо ушло бы тому, кому доступ в систему уже закрыт. Назначьте действующего руководителя в разделе «Пользователи»'
		};
	}

	if (entry.recipientInWorkspace !== true) {
		return {
			ok: false,
			error:
				'Руководитель ответственного не включён в пространство взаимодействия: письмо рассказало бы ему о работе, которой он не видит. Включите его в пространство в разделе «Настройки → Пространства»'
		};
	}

	return {
		ok: true,
		recipient: {
			userId: entry.recipientUserId,
			fullName: entry.recipientName,
			email: entry.recipientEmail
		}
	};
}

/**
 * Одна попытка по одной записи и одному каналу: занять строку, отправить,
 * записать исход. Возвращает исход — его считает вызывающий.
 */
export async function deliverStuckNotice(
	ctx: ActorContext,
	entry: StuckEntry,
	channel: NotificationChannel,
	thresholdDays: number,
	now: Date = new Date()
): Promise<NotificationDeliveryStatus> {
	// Текст собирается до того, как занята строка: он ни от чего внешнего не
	// зависит, а строка обязана унести его с собой — и когда письмо ушло, и
	// когда отправлять оказалось некому.
	const message = stuckNotificationMessage(
		{
			interactionId: entry.interactionId,
			interactionTitle: entry.interactionTitle,
			organizationName: entry.organizationName,
			stageName: entry.stageName,
			standingDays: Math.floor(entry.activeSeconds / SECONDS_PER_DAY),
			thresholdDays
		},
		getConfig().ORIGIN
	);

	const claimed = await claim(entry, channel, message, now);
	const addressee = checkRecipient(entry);

	if (!addressee.ok) {
		await settle(
			claimed.id,
			{ status: 'skipped', error: addressee.error, attempts: claimed.attempts },
			thresholdDays,
			now
		);

		await recordAuditEvent(ctx, {
			type: 'notifications.skipped',
			outcome: 'failure',
			subject: { type: 'interaction', id: entry.interactionId },
			details: { stageEntryId: entry.stageEntryId, channelKey: channel }
		});

		return 'skipped';
	}

	const outcome: ChannelOutcome = await sendThroughChannel(channel, addressee.recipient, message);

	// Заглушка попыткой не считается: считать её значило бы показывать растущий
	// счётчик отправок там, где отправки нет вовсе.
	const attempts = isStubChannel(channel) ? claimed.attempts : claimed.attempts + 1;

	await settle(
		claimed.id,
		{ status: outcome.status, error: outcome.error, attempts },
		thresholdDays,
		now
	);

	if (outcome.status === 'failed') {
		await recordAuditEvent(ctx, {
			type: 'notifications.failed',
			outcome: 'failure',
			subject: { type: 'interaction', id: entry.interactionId },
			details: { stageEntryId: entry.stageEntryId, channelKey: channel }
		});
	}

	return outcome.status;
}

function count(report: NotificationReport, status: NotificationDeliveryStatus): void {
	report.scanned += 1;

	if (status === 'sent') {
		report.sent += 1;
	} else if (status === 'failed') {
		report.failed += 1;
	} else if (status === 'skipped') {
		report.skipped += 1;
	} else if (status === 'stub') {
		report.stubbed += 1;
	}
}

/**
 * Проход наблюдателей по всем включённым каналам: сначала зависшие
 * взаимодействия, затем сроки лицензий (`license-watch.ts`). Отчёт у них общий.
 *
 * Своего замка не берёт — им распоряжается `runIntegrationsCycle`. Порог и
 * набор каналов читаются на каждый проход: правку настройки видно со следующего
 * прохода, а не со следующего перезапуска.
 */
export async function runNotificationCycle(ctx: ActorContext): Promise<NotificationReport> {
	const [thresholdDays, channels] = await Promise.all([
		getSetting('stuck_threshold_days'),
		getSetting('notification_channels')
	]);

	const report = emptyReport();
	const now = new Date();

	for (const channel of NOTIFICATION_CHANNELS) {
		if (!channels[channel]) {
			continue;
		}

		const due = await readStuck({ channel, thresholdDays, dueOnly: true, limit: BATCH });

		for (const entry of due) {
			count(report, await deliverStuckNotice(ctx, entry, channel, thresholdDays, now));
		}
	}

	const enabled = NOTIFICATION_CHANNELS.filter((channel) => channels[channel]);

	for (const status of await runLicenseWatch(ctx, enabled, now)) {
		count(report, status);
	}

	// Успехи сводятся в одну запись за проход: напоминания уходят пачками, и
	// строка на каждое превратила бы журнал действий в лог рассылки. Отказы и
	// пропуски, наоборот, пишутся поимённо — каждый из них ждёт человека.
	if (report.sent > 0) {
		await recordAuditEvent(ctx, {
			type: 'notifications.sent',
			outcome: 'success',
			details: { sentCount: report.sent }
		});
	}

	return report;
}
