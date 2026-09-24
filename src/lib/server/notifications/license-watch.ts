/**
 * Наблюдатель сроков лицензий по позициям договоров (шаг 7 процесса).
 *
 * Правило: у позиции договора срок лицензии (`contract_items.license_until`)
 * наступает через окно продления или раньше (`license_warning_days`, по
 * умолчанию 60 дней) либо уже прошёл. Тогда:
 * - ответственному за организацию по направлению продукта уходит
 *   `license_expiring` — «пора запускать продление», со ссылкой на карточку
 *   организации, где стоит кнопка «Запустить продление»;
 * - если срок уже прошёл, руководителю этого ответственного уходит ещё и
 *   `license_expired` — эскалация.
 *
 * Окно считает то же правило, что и карточка (`$lib/contracts/license`), по
 * календарному дню Москвы: письмо зовёт к кнопке, и кнопка обязана быть на
 * экране.
 *
 * Уведомление одно на позицию и срок по каналу: ключ журнала — «вид × позиция ×
 * срок × канал», и после отправки строка больше не созревает
 * (`licenseNextNotifyAt`). Продлили лицензию, записав новый срок, — новый срок
 * напомнит в своё время заново. Договор в состоянии «закрыт» и выключенная
 * организация не напоминают: по ним больше не работают.
 *
 * Проход зовётся из `runNotificationCycle` — тем же фоновым циклом и под тем же
 * замком в Redis, что и наблюдатель зависших.
 */
import { and, asc, eq, isNotNull, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import { addDays } from '$lib/contracts/license';
import {
	isStubChannel,
	type LicenseNotificationKind,
	type NotificationChannel,
	type NotificationDeliveryStatus
} from '$lib/contracts/notifications';
import { formatDate, formatIsoDay } from '$lib/format';
import type { ActorContext } from '../actor';
import { recordAuditEvent } from '../audit';
import { getConfig } from '../config';
import { getDb } from '../db';
import {
	contractItems,
	contracts,
	notificationDeliveries,
	organizations,
	products,
	users
} from '../db/schema';
import { licenseResponsible } from '../directory/license-renewal';
import { getSetting } from '../settings';
import { sendThroughChannel, type NotificationRecipient } from './channels';
import { licenseNotificationMessage, type NotificationMessage } from './message';
import { FAILURE_RETRY_MINUTES, licenseNextNotifyAt } from './schedule';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Позиция договора, о лицензии которой пора сказать. */
export type LicenseEntry = {
	contractItemId: string;
	productId: string;
	productName: string;
	licenseUntil: string;
	contractNumber: string;
	organizationId: string;
	organizationName: string;
	organizationKind: string;
};

/**
 * Позиции, о которых пора напомнить этим видом по этому каналу.
 *
 * `license_expiring` берёт всё, что в окне или уже истекло; `license_expired` —
 * только истёкшее. Строка журнала ищется по сроку позиции **сейчас**: срок
 * поправили — прежняя строка к позиции больше не относится.
 */
async function readLicenses(options: {
	kind: LicenseNotificationKind;
	channel: NotificationChannel;
	today: string;
	windowDays: number;
	dueOnly: boolean;
	contractItemId?: string;
	limit: number;
}): Promise<LicenseEntry[]> {
	const edge =
		options.kind === 'license_expired'
			? sql`${contractItems.licenseUntil} < ${options.today}::date`
			: sql`${contractItems.licenseUntil} <= ${addDays(options.today, options.windowDays)}::date`;

	const conditions: SQL[] = [
		isNotNull(contractItems.licenseUntil),
		edge,
		ne(contracts.status, 'closed'),
		eq(organizations.isActive, true)
	];

	if (options.contractItemId !== undefined) {
		conditions.push(eq(contractItems.id, options.contractItemId));
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

	const rows = await getDb()
		.select({
			contractItemId: contractItems.id,
			productId: contractItems.productId,
			productName: products.name,
			licenseUntil: contractItems.licenseUntil,
			contractNumber: contracts.number,
			organizationId: organizations.id,
			organizationName: organizations.shortName,
			organizationKind: organizations.kind
		})
		.from(contractItems)
		.innerJoin(contracts, eq(contracts.id, contractItems.contractId))
		.innerJoin(organizations, eq(organizations.id, contracts.organizationId))
		.innerJoin(products, eq(products.id, contractItems.productId))
		.leftJoin(
			notificationDeliveries,
			and(
				eq(notificationDeliveries.kind, options.kind),
				eq(notificationDeliveries.contractItemId, contractItems.id),
				eq(notificationDeliveries.licenseUntil, contractItems.licenseUntil),
				eq(notificationDeliveries.channel, options.channel)
			)
		)
		.where(and(...conditions))
		// Первыми — самые ранние сроки: пачка кончается на дальних, а не на
		// случайных.
		.orderBy(asc(contractItems.licenseUntil))
		.limit(options.limit);

	return rows.map((row) => ({ ...row, licenseUntil: row.licenseUntil as string }));
}

/** Та же позиция по идентификатору — её читает повтор из журнала. */
export async function readLicenseEntry(
	contractItemId: string,
	kind: LicenseNotificationKind,
	channel: NotificationChannel
): Promise<LicenseEntry | null> {
	const [row] = await readLicenses({
		kind,
		channel,
		today: formatIsoDay(),
		windowDays: await licenseWindowDays(),
		dueOnly: false,
		contractItemId,
		limit: 1
	});

	return row ?? null;
}

function licenseWindowDays(): Promise<number> {
	return getSetting('license_warning_days');
}

type Addressee = { ok: true; recipient: NotificationRecipient } | { ok: false; error: string };

async function readUser(userId: string) {
	const [row] = await getDb()
		.select({
			id: users.id,
			fullName: users.fullName,
			email: users.email,
			isActive: users.isActive,
			managerUserId: users.managerUserId
		})
		.from(users)
		.where(eq(users.id, userId))
		.limit(1);

	return row ?? null;
}

/**
 * Кому слать — или почему некому. Как и у наблюдателя зависших, разные
 * причины «некому» названы разными словами: чинятся они разными действиями.
 */
async function resolveAddressee(
	entry: LicenseEntry,
	kind: LicenseNotificationKind
): Promise<Addressee> {
	const responsibleId = await licenseResponsible(getDb(), entry.organizationId, entry.productId);

	if (responsibleId === null) {
		return {
			ok: false,
			error:
				'У организации нет действующего ответственного по направлению продукта: сказать о сроке лицензии некому. Назначьте ответственного в блоке «Ответственные» карточки организации'
		};
	}

	const responsible = await readUser(responsibleId);

	if (responsible === null) {
		throw new Error(`Ответственный ${responsibleId} пропал между двумя запросами`);
	}

	if (kind === 'license_expiring') {
		return {
			ok: true,
			recipient: {
				userId: responsible.id,
				fullName: responsible.fullName,
				email: responsible.email
			}
		};
	}

	if (responsible.managerUserId === null) {
		return {
			ok: false,
			error:
				'У ответственного за организацию не указан руководитель: эскалировать истёкшую лицензию некому. Назначьте руководителя в разделе «Пользователи»'
		};
	}

	const manager = await readUser(responsible.managerUserId);

	if (manager === null || !manager.isActive) {
		return {
			ok: false,
			error:
				'Руководитель ответственного за организацию выключен: письмо ушло бы тому, кому доступ в систему уже закрыт. Назначьте действующего руководителя в разделе «Пользователи»'
		};
	}

	return {
		ok: true,
		recipient: { userId: manager.id, fullName: manager.fullName, email: manager.email }
	};
}

/** Строка журнала до отправки — по той же причине, что у зависших (`watch.ts`). */
async function claim(
	entry: LicenseEntry,
	kind: LicenseNotificationKind,
	channel: NotificationChannel,
	recipientUserId: string | null,
	message: NotificationMessage,
	now: Date
): Promise<{ id: string; attempts: number }> {
	const retryAt = new Date(now.getTime() + FAILURE_RETRY_MINUTES * 60 * 1000);

	const [row] = await getDb()
		.insert(notificationDeliveries)
		.values({
			kind,
			contractItemId: entry.contractItemId,
			licenseUntil: entry.licenseUntil,
			recipientUserId,
			channel,
			status: 'queued',
			subject: message.subject,
			body: message.text,
			nextNotifyAt: retryAt
		})
		.onConflictDoUpdate({
			target: [
				notificationDeliveries.kind,
				notificationDeliveries.contractItemId,
				notificationDeliveries.licenseUntil,
				notificationDeliveries.channel
			],
			targetWhere: sql`${notificationDeliveries.contractItemId} is not null`,
			set: {
				status: 'queued',
				recipientUserId,
				subject: message.subject,
				body: message.text,
				nextNotifyAt: retryAt,
				updatedAt: now
			}
		})
		.returning({ id: notificationDeliveries.id, attempts: notificationDeliveries.attempts });

	return row;
}

async function settle(
	deliveryId: string,
	outcome: { status: NotificationDeliveryStatus; error: string | null; attempts: number },
	now: Date
): Promise<void> {
	await getDb()
		.update(notificationDeliveries)
		.set({
			status: outcome.status,
			attempts: outcome.attempts,
			lastError: outcome.error,
			sentAt: outcome.status === 'sent' ? now : sql`${notificationDeliveries.sentAt}`,
			nextNotifyAt: licenseNextNotifyAt(outcome, now),
			updatedAt: now
		})
		.where(eq(notificationDeliveries.id, deliveryId));
}

/** Одна попытка по одной позиции, одному виду и одному каналу. */
export async function deliverLicenseNotice(
	ctx: ActorContext,
	entry: LicenseEntry,
	kind: LicenseNotificationKind,
	channel: NotificationChannel,
	now: Date = new Date()
): Promise<NotificationDeliveryStatus> {
	const today = formatIsoDay(now);
	const daysLeft = Math.round(
		(Date.parse(`${entry.licenseUntil}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS
	);

	const message = licenseNotificationMessage(
		{
			organizationId: entry.organizationId,
			// Название физического лица — его ФИО: наружу в письме оно не уходит.
			organizationName: entry.organizationKind === 'individual' ? null : entry.organizationName,
			productName: entry.productName,
			contractNumber: entry.contractNumber,
			licenseUntilLabel: formatDate(entry.licenseUntil),
			daysLeft,
			escalation: kind === 'license_expired'
		},
		getConfig().ORIGIN
	);

	const addressee = await resolveAddressee(entry, kind);
	const claimed = await claim(
		entry,
		kind,
		channel,
		addressee.ok ? addressee.recipient.userId : null,
		message,
		now
	);
	const subject = { type: 'contract_item', id: entry.contractItemId };

	if (!addressee.ok) {
		await settle(
			claimed.id,
			{ status: 'skipped', error: addressee.error, attempts: claimed.attempts },
			now
		);

		await recordAuditEvent(ctx, {
			type: 'notifications.skipped',
			outcome: 'failure',
			subject,
			details: { organizationId: entry.organizationId, channelKey: channel, kindKey: kind }
		});

		return 'skipped';
	}

	const outcome = await sendThroughChannel(channel, addressee.recipient, message);
	const attempts = isStubChannel(channel) ? claimed.attempts : claimed.attempts + 1;

	await settle(claimed.id, { status: outcome.status, error: outcome.error, attempts }, now);

	if (outcome.status === 'failed') {
		await recordAuditEvent(ctx, {
			type: 'notifications.failed',
			outcome: 'failure',
			subject,
			details: { organizationId: entry.organizationId, channelKey: channel, kindKey: kind }
		});
	}

	return outcome.status;
}

/** Сколько позиций проход разбирает за раз на один вид и канал. */
const BATCH = 50;

/**
 * Проход по лицензиям для включённых каналов. Возвращает исходы попыток —
 * их сводит в отчёт `runNotificationCycle`.
 */
export async function runLicenseWatch(
	ctx: ActorContext,
	channels: readonly NotificationChannel[],
	now: Date
): Promise<NotificationDeliveryStatus[]> {
	const windowDays = await licenseWindowDays();
	const today = formatIsoDay(now);
	const outcomes: NotificationDeliveryStatus[] = [];

	for (const kind of ['license_expiring', 'license_expired'] as const) {
		for (const channel of channels) {
			const due = await readLicenses({
				kind,
				channel,
				today,
				windowDays,
				dueOnly: true,
				limit: BATCH
			});

			for (const entry of due) {
				outcomes.push(await deliverLicenseNotice(ctx, entry, kind, channel, now));
			}
		}
	}

	return outcomes;
}
