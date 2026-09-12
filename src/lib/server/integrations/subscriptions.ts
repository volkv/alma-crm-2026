/**
 * Подписки на события журнала: заведение, правка и состояние доставок.
 *
 * Подписка живёт в Redis, а не в PostgreSQL. У неё нет истории, за которую
 * кто-то отвечает, зато есть секрет, курсор и очередь повторов — всё то, что
 * меняется каждые пятнадцать секунд. Таблица притворялась бы записью
 * справочника, а миграция и резервная копия таскали бы за собой очередь
 * доставки.
 *
 * Что остаётся в базе — след: заведение и правка подписки пишутся в журнал
 * действий, и по нему видно, кто и когда открыл внешней системе поток событий.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import {
	createWebhookSchema,
	normalizeWebhookEvents,
	type CreatedWebhook,
	type CreateWebhookInput,
	type WebhookDelivery,
	type WebhookFormInput,
	type WebhookState,
	type WebhookView
} from '$lib/contracts/integrations';
import type { ActorContext } from '../actor';
import { recordAuditEvent } from '../audit';
import { NotFoundError, ValidationError } from '../errors';
import { requirePermission } from '../rbac';
import { getRedis } from '../redis';
import {
	WEBHOOK_IDS_KEY,
	webhookCursorKey,
	webhookDeliveriesKey,
	webhookKey,
	webhookPendingKey,
	webhookRetryQueueKey
} from './redis-keys';

/** Сколько попыток доставки держится в истории подписки. */
export const DELIVERY_LOG_LIMIT = 20;

/**
 * Подписка как она лежит в Redis — вместе с секретом. Наружу этот тип не
 * выходит: всё, что покидает модуль, проходит через `toView`.
 */
export type StoredWebhook = {
	id: string;
	name: string;
	url: string;
	events: string[];
	enabled: boolean;
	secret: string;
	createdAt: string;
	updatedAt: string;
};

/**
 * Место в журнале, до которого подписка дочитана. Пара «момент и
 * идентификатор»: события одной миллисекунды упорядочиваются по `id`, иначе
 * запись с границы выборки ушла бы дважды или не ушла вовсе.
 */
export type JournalCursor = { at: string; id: string };

/** Нулевой идентификатор: курсор указывает «сразу после этого момента». */
const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

/** Секрет подписки: его видят один раз, поэтому он сразу пригоден к копированию. */
function generateSecret(): string {
	return `whsec_${randomBytes(32).toString('base64url')}`;
}

function parseStored(raw: string): StoredWebhook {
	return JSON.parse(raw) as StoredWebhook;
}

/** Все подписки. Порядок — по названию: список читают глазами. */
export async function readSubscriptions(): Promise<StoredWebhook[]> {
	const redis = getRedis();
	const ids = await redis.smembers(WEBHOOK_IDS_KEY);

	if (ids.length === 0) {
		return [];
	}

	const raw = await redis.mget(ids.map(webhookKey));

	return raw
		.filter((value): value is string => value !== null)
		.map(parseStored)
		.sort((left, right) => left.name.localeCompare(right.name, 'ru'));
}

export async function readSubscription(webhookId: string): Promise<StoredWebhook | null> {
	const raw = await getRedis().get(webhookKey(webhookId));

	return raw === null ? null : parseStored(raw);
}

async function requireSubscription(webhookId: string): Promise<StoredWebhook> {
	const stored = await readSubscription(webhookId);

	if (stored === null) {
		throw new NotFoundError('Подписка не найдена');
	}

	return stored;
}

async function writeSubscription(stored: StoredWebhook): Promise<void> {
	const redis = getRedis();

	await redis.set(webhookKey(stored.id), JSON.stringify(stored));
	await redis.sadd(WEBHOOK_IDS_KEY, stored.id);
}

/* ------------------------------------------------------------------ */
/* Курсор по журналу                                                   */
/* ------------------------------------------------------------------ */

export async function readCursor(webhookId: string): Promise<JournalCursor | null> {
	const raw = await getRedis().get(webhookCursorKey(webhookId));

	return raw === null ? null : (JSON.parse(raw) as JournalCursor);
}

export async function writeCursor(webhookId: string, cursor: JournalCursor): Promise<void> {
	await getRedis().set(webhookCursorKey(webhookId), JSON.stringify(cursor));
}

/* ------------------------------------------------------------------ */
/* История доставок                                                    */
/* ------------------------------------------------------------------ */

export async function recordDelivery(webhookId: string, delivery: WebhookDelivery): Promise<void> {
	const redis = getRedis();
	const key = webhookDeliveriesKey(webhookId);

	await redis.lpush(key, JSON.stringify(delivery));
	await redis.ltrim(key, 0, DELIVERY_LOG_LIMIT - 1);
}

export async function listDeliveries(webhookId: string): Promise<WebhookDelivery[]> {
	const raw = await getRedis().lrange(webhookDeliveriesKey(webhookId), 0, DELIVERY_LOG_LIMIT - 1);

	return raw.map((value) => JSON.parse(value) as WebhookDelivery);
}

/** Сколько событий ждут повторной попытки. */
export async function countPending(webhookId: string): Promise<number> {
	return getRedis().zcard(webhookRetryQueueKey(webhookId));
}

/**
 * Состояние подписки словами: ждут ли события повтора и не сдалась ли
 * доставка совсем. Считается по тому же, что видит сотрудник в истории, —
 * отдельного поля «состояние» нет, иначе его пришлось бы чинить руками.
 */
function stateOf(pending: number, deliveries: WebhookDelivery[]): WebhookState {
	const last = deliveries[0];

	if (last !== undefined && !last.ok && pending === 0) {
		return 'failed';
	}

	return pending > 0 ? 'delivering' : 'idle';
}

async function toView(stored: StoredWebhook): Promise<WebhookView> {
	const [pending, lastDeliveries] = await Promise.all([
		countPending(stored.id),
		listDeliveries(stored.id)
	]);

	return {
		id: stored.id,
		name: stored.name,
		url: stored.url,
		events: stored.events,
		enabled: stored.enabled,
		createdAt: stored.createdAt,
		updatedAt: stored.updatedAt,
		state: stateOf(pending, lastDeliveries),
		pending,
		lastDeliveries
	};
}

/* ------------------------------------------------------------------ */
/* Команды                                                             */
/* ------------------------------------------------------------------ */

export async function listWebhooks(ctx: ActorContext): Promise<WebhookView[]> {
	requirePermission(ctx, 'integrations.manage');

	const stored = await readSubscriptions();

	return Promise.all(stored.map(toView));
}

export async function getWebhook(ctx: ActorContext, webhookId: string): Promise<WebhookView> {
	requirePermission(ctx, 'integrations.manage');

	return toView(await requireSubscription(webhookId));
}

function parseInput(input: CreateWebhookInput): CreateWebhookInput {
	const parsed = createWebhookSchema.safeParse(input);

	if (!parsed.success) {
		throw new ValidationError(
			'Подписка не прошла проверку',
			parsed.error.issues.map((issue) => issue.message)
		);
	}

	return { ...parsed.data, events: normalizeWebhookEvents(parsed.data.events) };
}

/**
 * Заведение подписки. Курсор ставится на момент заведения: подписка — это
 * договорённость на будущее, и высыпать в чужую систему весь накопленный
 * журнал в ответ на её появление было бы неожиданностью для обеих сторон.
 */
export async function createWebhook(
	ctx: ActorContext,
	input: CreateWebhookInput
): Promise<CreatedWebhook> {
	await requirePermission(ctx, 'integrations.manage', { type: 'integrations.webhook_created' });

	const definition = parseInput(input);
	const now = new Date().toISOString();
	const stored: StoredWebhook = {
		id: randomUUID(),
		name: definition.name,
		url: definition.url,
		events: definition.events,
		enabled: definition.enabled,
		secret: generateSecret(),
		createdAt: now,
		updatedAt: now
	};

	await writeSubscription(stored);
	await writeCursor(stored.id, { at: now, id: ZERO_UUID });

	await recordAuditEvent(ctx, {
		type: 'integrations.webhook_created',
		outcome: 'success',
		subject: { type: 'webhook', id: stored.id }
	});

	return { webhook: await toView(stored), secret: stored.secret };
}

/**
 * Правка подписки. Секрет не меняется и не показывается: он у получателя, и
 * смена секрета «заодно с названием» сломала бы проверку подписи на той
 * стороне посреди рабочего дня.
 */
export async function updateWebhook(
	ctx: ActorContext,
	input: WebhookFormInput & { id: string }
): Promise<WebhookView> {
	await requirePermission(ctx, 'integrations.manage', {
		type: 'integrations.webhook_updated',
		subject: { type: 'webhook', id: input.id }
	});

	const previous = await requireSubscription(input.id);
	const definition = parseInput(input);

	const changedFields = (
		[
			['name', previous.name !== definition.name],
			['url', previous.url !== definition.url],
			['events', previous.events.join(' ') !== definition.events.join(' ')],
			['enabled', previous.enabled !== definition.enabled]
		] as const
	)
		.filter(([, changed]) => changed)
		.map(([field]) => field);

	const stored: StoredWebhook = {
		...previous,
		name: definition.name,
		url: definition.url,
		events: definition.events,
		enabled: definition.enabled,
		updatedAt: new Date().toISOString()
	};

	await writeSubscription(stored);

	await recordAuditEvent(ctx, {
		type: 'integrations.webhook_updated',
		outcome: 'success',
		subject: { type: 'webhook', id: stored.id },
		details: { changedFields }
	});

	return toView(stored);
}

/* ------------------------------------------------------------------ */
/* Очередь повторов                                                    */
/* ------------------------------------------------------------------ */

/** Событие, которое ещё не доставлено: тело и сколько раз уже пробовали. */
export type PendingDelivery = {
	eventId: string;
	attempt: number;
	payload: unknown;
};

export async function schedulePending(
	webhookId: string,
	pending: PendingDelivery,
	dueAtMs: number,
	ttlSeconds: number
): Promise<void> {
	const redis = getRedis();

	await redis.set(
		webhookPendingKey(webhookId, pending.eventId),
		JSON.stringify(pending),
		'EX',
		ttlSeconds
	);
	await redis.zadd(webhookRetryQueueKey(webhookId), dueAtMs, pending.eventId);
}

export async function takeDuePending(
	webhookId: string,
	nowMs: number,
	limit: number
): Promise<PendingDelivery[]> {
	const redis = getRedis();
	const ids = await redis.zrangebyscore(
		webhookRetryQueueKey(webhookId),
		0,
		nowMs,
		'LIMIT',
		0,
		limit
	);

	if (ids.length === 0) {
		return [];
	}

	const raw = await redis.mget(ids.map((eventId) => webhookPendingKey(webhookId, eventId)));
	const pending: PendingDelivery[] = [];

	for (const [index, value] of raw.entries()) {
		if (value === null) {
			// Тело пережило свой срок: очередь больше ни на что не указывает, и
			// держать в ней имя без содержимого значит вечно возвращаться к нему.
			await redis.zrem(webhookRetryQueueKey(webhookId), ids[index]);
			continue;
		}

		pending.push(JSON.parse(value) as PendingDelivery);
	}

	return pending;
}

export async function dropPending(webhookId: string, eventId: string): Promise<void> {
	const redis = getRedis();

	await redis.zrem(webhookRetryQueueKey(webhookId), eventId);
	await redis.del(webhookPendingKey(webhookId, eventId));
}
