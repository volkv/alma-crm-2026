/**
 * Цикл интеграций: что система делает без человека.
 *
 * Фонового процесса в системе нет — есть таймер внутри самого приложения
 * (`init` в `src/hooks.server.ts`). Он просыпается, берёт замок в Redis и
 * делает два дела: дочитывает журнал в подписки и, если пришёл срок, ходит за
 * выгрузкой в систему обучения. Замок нужен потому, что приложение может
 * работать в нескольких процессах, а одно событие должно уйти получателю один
 * раз.
 *
 * Сам цикл — обычная функция, и проверки зовут её напрямую, без таймера: тест,
 * который ждёт пятнадцать секунд, проверяет не доставку, а терпение.
 *
 * Источник событий — журнал действий, и только записи с исходом `success`:
 * отказ по правам и упавший запрос — это разговор администратора с системой, а
 * не факт, о котором нужно знать чужой системе. Собственные записи о доставке
 * в подписки не уходят вовсе: доставка порождала бы событие, которое снова
 * нужно доставить, и цикл кормил бы сам себя.
 */
import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, like, notInArray, or, sql, type SQL } from 'drizzle-orm';
import {
	eventPrefix,
	webhookPayloadSchema,
	WEBHOOK_TEST_EVENT,
	type WebhookPayload
} from '$lib/contracts/integrations';
import { systemActor, type ActorContext } from '../actor';
import { recordAuditEvent } from '../audit';
import { getDb } from '../db';
import { auditEvents } from '../db/schema';
import { getRedis } from '../redis';
import {
	postWebhook,
	retryDelaySeconds,
	PENDING_TTL_SECONDS,
	type DeliveryOutcome
} from './delivery';
import { syncLms } from './lms/sync';
import { DELIVERY_SETTINGS_DEFAULT, getDeliverySettings, getLmsSettings } from './settings';
import {
	dropPending,
	readCursor,
	readSubscriptions,
	recordDelivery,
	schedulePending,
	takeDuePending,
	writeCursor,
	type JournalCursor,
	type StoredWebhook
} from './subscriptions';
import { LMS_LAST_RUN_KEY, PUMP_LOCK_KEY, webhookSentKey } from './redis-keys';

/** Сколько событий подписка забирает из журнала за один проход. */
const BATCH = 50;

/**
 * Насколько цикл отстаёт от настоящего времени, читая журнал.
 *
 * Курсор подписки идёт по паре «момент события и идентификатор», а момент — это
 * `now()` PostgreSQL, то есть время **начала** транзакции, в которой событие
 * записано. Транзакция может закоммититься позже соседней, а момент у неё
 * останется более ранним: событие появится в журнале уже позади курсора, и
 * подписка не увидит его никогда.
 *
 * Поэтому курсор не подходит к настоящему времени ближе, чем на этот срок:
 * пока транзакция короче него, её событие успевает стать видимым до того, как
 * курсор дойдёт до соответствующего момента. Цена — доставка идёт с задержкой
 * до этого срока; гарантия — событие из транзакции короче него не теряется.
 * Повторное чтение того же окна безопасно: вторую отправку гасит отметка
 * `claimEvent`.
 */
const JOURNAL_LAG_SECONDS = 30;

/**
 * Сколько живёт отметка «это событие в эту подписку уже уходило». Дольше
 * последнего повтора: отметка страхует от второй отправки, и исчезнуть она
 * должна позже, чем событие перестанут пытаться доставить.
 */
const SENT_TTL_SECONDS = 7 * 24 * 60 * 60;

/** Записи о самой доставке: в подписки не уходят, иначе цикл кормит сам себя. */
const SELF_EVENTS = ['integrations.webhook_delivered', 'integrations.webhook_failed'];

/** Что цикл сделал: числа для лога и для проверок. */
export type DeliveryReport = {
	subscriptions: number;
	delivered: number;
	failed: number;
	retried: number;
};

/** Запись журнала в том виде, в каком она уезжает получателю. */
export function toWebhookPayload(row: {
	id: string;
	occurredAt: Date;
	eventType: string;
	subjectType: string | null;
	subjectId: string | null;
	details: unknown;
}): WebhookPayload {
	return webhookPayloadSchema.parse({
		id: row.id,
		type: row.eventType,
		occurredAt: row.occurredAt.toISOString(),
		subject:
			row.subjectType === null || row.subjectId === null
				? null
				: { type: row.subjectType, id: row.subjectId },
		details: row.details ?? {}
	});
}

/**
 * Условие «событие подходит под фильтр подписки» на стороне базы. Фильтровать
 * уже выбранную пачку нельзя: пятьдесят чужих событий вытеснили бы из неё то
 * единственное, ради которого подписка и заведена.
 */
function filterCondition(events: readonly string[]): SQL | undefined {
	const exact = events.filter((pattern) => !pattern.endsWith('.*'));
	const prefixes = events.filter((pattern) => pattern.endsWith('.*'));

	const conditions: SQL[] = [];

	if (exact.length > 0) {
		conditions.push(inArray(auditEvents.eventType, exact));
	}

	for (const pattern of prefixes) {
		conditions.push(like(auditEvents.eventType, `${eventPrefix(pattern)}.%`));
	}

	return conditions.length === 0 ? undefined : or(...conditions);
}

/** События журнала после курсора, подходящие под фильтр подписки. */
async function readJournalAfter(
	cursor: JournalCursor,
	events: readonly string[],
	lagSeconds: number
): Promise<
	{
		id: string;
		occurredAt: Date;
		eventType: string;
		subjectType: string | null;
		subjectId: string | null;
		details: unknown;
	}[]
> {
	const filter = filterCondition(events);

	if (filter === undefined) {
		return [];
	}

	return getDb()
		.select({
			id: auditEvents.id,
			occurredAt: auditEvents.occurredAt,
			eventType: auditEvents.eventType,
			subjectType: auditEvents.subjectType,
			subjectId: auditEvents.subjectId,
			details: auditEvents.details
		})
		.from(auditEvents)
		.where(
			and(
				eq(auditEvents.outcome, 'success'),
				notInArray(auditEvents.eventType, SELF_EVENTS),
				filter,
				// Пара «момент и идентификатор»: у событий одной миллисекунды
				// порядок задаёт `id`, иначе запись с границы выборки уехала бы
				// дважды или не уехала вовсе.
				sql`(${auditEvents.occurredAt}, ${auditEvents.id}) > (${cursor.at}::timestamptz, ${cursor.id}::uuid)`,
				// Верхняя граница — по часам той же базы, что проставила момент:
				// сравнивать её собственный `now()` с часами приложения значило бы
				// добавить к сроку ещё и расхождение двух машин.
				sql`${auditEvents.occurredAt} <= now() - make_interval(secs => ${lagSeconds}::double precision)`
			)
		)
		.orderBy(asc(auditEvents.occurredAt), asc(auditEvents.id))
		.limit(BATCH);
}

async function claimEvent(webhookId: string, eventId: string): Promise<boolean> {
	const claimed = await getRedis().set(
		webhookSentKey(webhookId, eventId),
		'1',
		'EX',
		SENT_TTL_SECONDS,
		'NX'
	);

	return claimed === 'OK';
}

/** Попытка вместе с записью о ней в истории подписки. */
async function attemptDelivery(
	subscription: StoredWebhook,
	payload: WebhookPayload,
	attempt: number
): Promise<DeliveryOutcome> {
	const outcome = await postWebhook(subscription, payload);

	await recordDelivery(subscription.id, {
		eventId: payload.id,
		eventType: payload.type,
		attempt,
		status: outcome.status,
		error: outcome.error,
		at: new Date().toISOString(),
		ok: outcome.ok
	});

	return outcome;
}

/**
 * Неудача: либо назначаем повтор, либо признаём доставку несостоявшейся.
 * Возвращает `true`, если попытки кончились.
 */
async function handleFailure(
	subscription: StoredWebhook,
	payload: WebhookPayload,
	attempt: number
): Promise<boolean> {
	const delay = retryDelaySeconds(attempt);

	if (delay === null) {
		await dropPending(subscription.id, payload.id);
		return true;
	}

	await schedulePending(
		subscription.id,
		{ eventId: payload.id, attempt, payload },
		Date.now() + delay * 1000,
		PENDING_TTL_SECONDS
	);

	return false;
}

/** Один проход по одной подписке: сперва долги, потом новое. */
async function pumpSubscription(
	ctx: ActorContext,
	subscription: StoredWebhook,
	report: DeliveryReport,
	lagSeconds: number
): Promise<void> {
	const failedEventIds: string[] = [];
	let delivered = 0;

	for (const pending of await takeDuePending(subscription.id, Date.now(), BATCH)) {
		const payload = webhookPayloadSchema.parse(pending.payload);
		const attempt = pending.attempt + 1;
		const outcome = await attemptDelivery(subscription, payload, attempt);
		report.retried += 1;

		if (outcome.ok) {
			await dropPending(subscription.id, payload.id);
			delivered += 1;
			continue;
		}

		if (await handleFailure(subscription, payload, attempt)) {
			failedEventIds.push(payload.id);
		}
	}

	const cursor = (await readCursor(subscription.id)) ?? {
		at: subscription.createdAt,
		id: '00000000-0000-0000-0000-000000000000'
	};

	let moved = cursor;

	for (const row of await readJournalAfter(cursor, subscription.events, lagSeconds)) {
		moved = { at: row.occurredAt.toISOString(), id: row.id };

		if (!(await claimEvent(subscription.id, row.id))) {
			// Это событие уже уходило в эту подписку: курсор просто едет дальше.
			continue;
		}

		const payload = toWebhookPayload(row);
		const outcome = await attemptDelivery(subscription, payload, 1);

		if (outcome.ok) {
			delivered += 1;
			continue;
		}

		if (await handleFailure(subscription, payload, 1)) {
			failedEventIds.push(payload.id);
		}
	}

	if (moved !== cursor) {
		await writeCursor(subscription.id, moved);
	}

	// Успехи сводятся в одну запись на подписку за цикл: доставка идёт пачками,
	// и строка на каждое событие превратила бы журнал в лог обмена.
	if (delivered > 0) {
		report.delivered += delivered;

		await recordAuditEvent(ctx, {
			type: 'integrations.webhook_delivered',
			outcome: 'success',
			subject: { type: 'webhook', id: subscription.id },
			details: { webhookId: subscription.id }
		});
	}

	for (const eventId of failedEventIds) {
		report.failed += 1;

		await recordAuditEvent(ctx, {
			type: 'integrations.webhook_failed',
			outcome: 'failure',
			subject: { type: 'webhook', id: subscription.id },
			details: { webhookId: subscription.id, eventId }
		});
	}
}

/**
 * Проход по всем включённым подпискам. Зовётся таймером и проверками; своего
 * замка не берёт — им распоряжается `runIntegrationsCycle`.
 *
 * `lagSeconds` — отставание курсора от настоящего времени (`JOURNAL_LAG_SECONDS`
 * по умолчанию). Значение задаётся параметром, потому что иначе проверка этой
 * самой гарантии ждала бы полминуты вместо того, чтобы её проверять.
 */
export async function runDeliveryCycle(
	ctx: ActorContext,
	options: { lagSeconds?: number } = {}
): Promise<DeliveryReport> {
	const lagSeconds = options.lagSeconds ?? JOURNAL_LAG_SECONDS;
	const report: DeliveryReport = { subscriptions: 0, delivered: 0, failed: 0, retried: 0 };

	for (const subscription of await readSubscriptions()) {
		if (!subscription.enabled) {
			continue;
		}

		report.subscriptions += 1;
		await pumpSubscription(ctx, subscription, report, lagSeconds);
	}

	return report;
}

/**
 * Проверочная отправка: то же тело и та же подпись, что у настоящего события,
 * но с кодом `webhook.test`. Заводить ради кнопки «проверить» несуществующее
 * событие журнала нельзя — по словарю событий строят отчёты.
 */
export async function sendTestEvent(
	ctx: ActorContext,
	subscription: StoredWebhook
): Promise<DeliveryOutcome> {
	const payload: WebhookPayload = {
		id: randomUUID(),
		type: WEBHOOK_TEST_EVENT,
		occurredAt: new Date().toISOString(),
		subject: { type: 'webhook', id: subscription.id },
		details: { webhookId: subscription.id }
	};

	const outcome = await attemptDelivery(subscription, payload, 1);

	await recordAuditEvent(ctx, {
		type: outcome.ok ? 'integrations.webhook_delivered' : 'integrations.webhook_failed',
		outcome: outcome.ok ? 'success' : 'failure',
		subject: { type: 'webhook', id: subscription.id },
		details: { webhookId: subscription.id }
	});

	return outcome;
}

/** Пришёл ли срок идти за выгрузкой в систему обучения. */
async function lmsSyncIsDue(intervalMinutes: number): Promise<boolean> {
	const last = await getRedis().get(LMS_LAST_RUN_KEY);

	if (last === null) {
		return true;
	}

	return Date.now() - Number(last) >= intervalMinutes * 60 * 1000;
}

/**
 * Замок цикла. Владение подтверждается меткой: чужой замок снимать нельзя —
 * иначе затянувшийся цикл потерял бы своё место посреди работы.
 */
async function withPumpLock<TResult>(
	ttlMs: number,
	run: () => Promise<TResult>
): Promise<TResult | null> {
	const redis = getRedis();
	const token = randomUUID();
	const acquired = await redis.set(PUMP_LOCK_KEY, token, 'PX', ttlMs, 'NX');

	if (acquired !== 'OK') {
		return null;
	}

	try {
		return await run();
	} finally {
		await redis.eval(
			`if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`,
			1,
			PUMP_LOCK_KEY,
			token
		);
	}
}

/**
 * Сколько живёт замок. С запасом: неотвечающий получатель держит каждую
 * попытку до таймаута, и проход по пачке событий может занять минуты. Пока
 * замок жив, следующий тик просто уходит ни с чем — это и есть защита от
 * второй доставки того же события.
 */
const PUMP_LOCK_TTL_MS = 5 * 60 * 1000;

/**
 * Один проход цикла целиком: доставка вебхуков и, если пришёл срок, выгрузка
 * из системы обучения. Возвращает `null`, если проход занят другим процессом.
 */
export async function runIntegrationsCycle(): Promise<DeliveryReport | null> {
	return withPumpLock(PUMP_LOCK_TTL_MS, async () => {
		const ctx = systemActor(randomUUID());
		const report = await runDeliveryCycle(ctx);

		const lms = await getLmsSettings();

		if (lms.enabled && (await lmsSyncIsDue(lms.syncIntervalMinutes))) {
			// Отметка о заходе ставится до самого захода: неудачная выгрузка не
			// должна повторяться каждые пятнадцать секунд.
			await getRedis().set(LMS_LAST_RUN_KEY, String(Date.now()));

			// Сбой выгрузки доставку не роняет: он возвращается состоянием и уже
			// записан и в журнал, и в раздел интеграций.
			await syncLms(ctx);
		}

		return report;
	});
}

/**
 * Таймер цикла. Запускается один раз при старте сервера.
 *
 * Не `setInterval`, а цепочка `setTimeout`: периодичность лежит в настройках, и
 * её меняют из интерфейса — следующий срок считается после каждого прохода, а
 * не фиксируется при старте. Заодно два прохода не наезжают друг на друга,
 * даже когда получатель отвечает медленно.
 *
 * В прогоне Vitest не стартует: модуль там импортируют ради функций, а не ради
 * фоновой работы, и незакрытый таймер держал бы процесс живым после конца
 * проверок.
 */
export function startIntegrationsTimer(): void {
	if (process.env.VITEST !== undefined) {
		return;
	}

	const schedule = (delaySeconds: number): void => {
		// Таймер не должен держать процесс: остановка сервера не обязана ждать
		// следующего прохода.
		setTimeout(() => void tick(), delaySeconds * 1000).unref();
	};

	const tick = async (): Promise<void> => {
		let next = DELIVERY_SETTINGS_DEFAULT.intervalSeconds;

		try {
			next = (await getDeliverySettings()).intervalSeconds;
			await runIntegrationsCycle();
		} catch (error) {
			// У фоновой работы нет адресата, кроме лога сервера: следующий проход
			// начнётся как ни в чём не бывало, и молча пропавшая доставка так и
			// осталась бы незамеченной.
			console.error('[integrations] проход цикла не удался', error);
		}

		schedule(next);
	};

	schedule(DELIVERY_SETTINGS_DEFAULT.intervalSeconds);
}
