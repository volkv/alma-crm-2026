import { Redis } from 'ioredis';
import { getConfig } from './config';

let client: Redis | undefined;

/**
 * The shared Redis connection.
 *
 * Built on first use for the same reason as the database handle, and with
 * `lazyConnect` so that constructing it does not open a socket either.
 */
export function getRedis(): Redis {
	client ??= new Redis(getConfig().REDIS_URL, {
		lazyConnect: true,
		// A request must not wait on a dead Redis: surface the failure instead.
		maxRetriesPerRequest: 2,
		commandTimeout: 5_000
	});
	return client;
}

/**
 * Соединение-подписчик живых событий: одно на процесс.
 *
 * Отдельное от {@link getRedis}, и иначе нельзя: после `SUBSCRIBE` соединение
 * Redis принимает только команды подписки, и общий клиент, на котором
 * держатся сессии и кэш, перестал бы отвечать на `GET` первого же запроса.
 * Одно на процесс, а не на вкладку: подписки всех открытых карточек процесса
 * раздаёт `live/bus.ts`, и число соединений с Redis не растёт вместе с числом
 * зрителей.
 *
 * Ограничения общего клиента ему не подходят. `commandTimeout` оборвал бы
 * подписку, которая по смыслу ждёт бесконечно, а `maxRetriesPerRequest` здесь
 * не о чем повторять. Переподключается ioredis сам и сам же возобновляет
 * подписки (`autoResubscribe`); что за время разрыва события могли пропасть,
 * шина сообщает подписчикам отдельно.
 */
export function createRedisSubscriber(): Redis {
	return new Redis(getConfig().REDIS_URL, {
		lazyConnect: true,
		maxRetriesPerRequest: null
	});
}

/** Cheapest possible round-trip to Redis, used by the health endpoint. */
export async function pingRedis(): Promise<void> {
	const reply = await getRedis().ping();
	if (reply !== 'PONG') {
		throw new Error(`Unexpected PING reply from Redis: ${reply}`);
	}
}
