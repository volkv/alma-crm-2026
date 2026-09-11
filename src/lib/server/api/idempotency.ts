/**
 * Идемпотентность изменяющих запросов.
 *
 * Интегратор, который не дождался ответа, обязан иметь возможность повторить
 * запрос, не создав вторую запись. Поэтому ответ на запрос с заголовком
 * `Idempotency-Key` запоминается на сутки вместе с отпечатком тела: повтор с
 * тем же телом получает тот же ответ, повтор с другим телом — отказ, потому что
 * это уже другой запрос под старым именем.
 *
 * Запись делается до выполнения, а не после: иначе два одновременных повтора
 * оба не нашли бы ничего в хранилище и оба сделали бы работу.
 */
import { createHash } from 'node:crypto';
import { getRedis } from '../redis';
import { API_REDIS_PREFIX } from './rate-limit';

/** Сутки: столько живёт память о выполненном запросе. */
export const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

/** Что лежит в хранилище: либо «выполняется», либо готовый ответ. */
type StoredRecord = {
	bodyHash: string;
	status?: number;
	body?: unknown;
};

export type IdempotencyLookup =
	/** Место занято этим запросом — можно выполнять. */
	| { state: 'reserved' }
	/** Такой запрос уже выполнен, вот его ответ. */
	| { state: 'replay'; status: number; body: unknown }
	/** Тот же ключ, другое тело. */
	| { state: 'mismatch' }
	/** Тот же ключ и то же тело, но ответа ещё нет. */
	| { state: 'in_progress' };

export function hashRequestBody(raw: string): string {
	return createHash('sha256').update(raw, 'utf8').digest('hex');
}

/** Ключ идемпотентности приходит от интегратора, поэтому в Redis едет его хеш. */
function storageKey(apiKeyId: string, idempotencyKey: string): string {
	return `${API_REDIS_PREFIX}idem:${apiKeyId}:${hashRequestBody(idempotencyKey)}`;
}

export async function reserveIdempotency(
	apiKeyId: string,
	idempotencyKey: string,
	bodyHash: string
): Promise<IdempotencyLookup> {
	const key = storageKey(apiKeyId, idempotencyKey);
	const redis = getRedis();

	const reserved = await redis.set(
		key,
		JSON.stringify({ bodyHash } satisfies StoredRecord),
		'EX',
		IDEMPOTENCY_TTL_SECONDS,
		'NX'
	);

	if (reserved === 'OK') {
		return { state: 'reserved' };
	}

	const stored = await redis.get(key);
	if (stored === null) {
		// Запись истекла между двумя командами. Гонка настолько редкая, что
		// городить блокировку ради неё дороже, чем выполнить запрос ещё раз.
		return { state: 'reserved' };
	}

	const record = JSON.parse(stored) as StoredRecord;

	if (record.bodyHash !== bodyHash) {
		return { state: 'mismatch' };
	}

	if (record.status === undefined) {
		return { state: 'in_progress' };
	}

	return { state: 'replay', status: record.status, body: record.body };
}

export async function completeIdempotency(
	apiKeyId: string,
	idempotencyKey: string,
	bodyHash: string,
	response: { status: number; body: unknown }
): Promise<void> {
	await getRedis().set(
		storageKey(apiKeyId, idempotencyKey),
		JSON.stringify({
			bodyHash,
			status: response.status,
			body: response.body
		} satisfies StoredRecord),
		'EX',
		IDEMPOTENCY_TTL_SECONDS
	);
}

/**
 * Снимает бронь, если запрос кончился ошибкой: неудача не результат, и повтор
 * должен получить возможность выполниться, а не вечно упираться в «выполняется».
 */
export async function releaseIdempotency(apiKeyId: string, idempotencyKey: string): Promise<void> {
	await getRedis().del(storageKey(apiKeyId, idempotencyKey));
}
