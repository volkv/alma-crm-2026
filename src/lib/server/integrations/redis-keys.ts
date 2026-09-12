/**
 * Ключи интеграций в Redis — все в одном месте и все с общим началом
 * `lct:integrations:`, как это сделано у публичного API (`API_REDIS_PREFIX`).
 * По префиксу состояние интеграций видно в `redis-cli --scan` и вычищается
 * одной командой, а имя ключа не сочиняется заново в каждом модуле.
 */
export const INTEGRATIONS_REDIS_PREFIX = 'lct:integrations:';

/** Набор идентификаторов подписок: список, по которому идёт цикл доставки. */
export const WEBHOOK_IDS_KEY = `${INTEGRATIONS_REDIS_PREFIX}webhooks`;

/** Подписка целиком, вместе с секретом: JSON одной строкой. */
export function webhookKey(webhookId: string): string {
	return `${INTEGRATIONS_REDIS_PREFIX}webhook:${webhookId}`;
}

/**
 * Курсор по журналу: до какого события подписка уже дочитана. Отдельным
 * ключом, а не полем подписки: курсор двигается каждый цикл, а подписка
 * меняется раз в полгода — переписывать её целиком ради одного числа незачем.
 */
export function webhookCursorKey(webhookId: string): string {
	return `${INTEGRATIONS_REDIS_PREFIX}cursor:${webhookId}`;
}

/** Последние попытки доставки: список, подрезанный до `DELIVERY_LOG_LIMIT`. */
export function webhookDeliveriesKey(webhookId: string): string {
	return `${INTEGRATIONS_REDIS_PREFIX}deliveries:${webhookId}`;
}

/**
 * Отметка «это событие в эту подписку уже уходило». Ставится `SET NX`, поэтому
 * повторный проход журнала — например, после отката курсора — не шлёт второй
 * раз то же самое.
 */
export function webhookSentKey(webhookId: string, eventId: string): string {
	return `${INTEGRATIONS_REDIS_PREFIX}sent:${webhookId}:${eventId}`;
}

/** Очередь повторов: отсортированный набор, вес — момент следующей попытки. */
export function webhookRetryQueueKey(webhookId: string): string {
	return `${INTEGRATIONS_REDIS_PREFIX}retry:${webhookId}`;
}

/** Тело и счётчик попыток события, которое ещё не доставлено. */
export function webhookPendingKey(webhookId: string, eventId: string): string {
	return `${INTEGRATIONS_REDIS_PREFIX}pending:${webhookId}:${eventId}`;
}

/**
 * Замок цикла: приложение может работать в нескольких процессах, а одно и то
 * же событие должно уйти получателю один раз.
 */
export const PUMP_LOCK_KEY = `${INTEGRATIONS_REDIS_PREFIX}pump:lock`;

/** Чем кончилась последняя синхронизация с системой обучения. */
export const LMS_STATE_KEY = `${INTEGRATIONS_REDIS_PREFIX}lms:state`;

/** Когда цикл последний раз ходил в систему обучения. */
export const LMS_LAST_RUN_KEY = `${INTEGRATIONS_REDIS_PREFIX}lms:last-run`;

/**
 * Заявка на загрузку: источник, период и отпечаток содержимого. Пока ключ
 * жив, та же выгрузка за тот же период второй раз снимком не становится.
 */
export function lmsClaimKey(fingerprint: string): string {
	return `${INTEGRATIONS_REDIS_PREFIX}lms:claim:${fingerprint}`;
}
