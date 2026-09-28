import { Redis } from 'ioredis';
import { getConfig } from './config';

/**
 * Общее соединение живёт на `globalThis` по той же причине, что и пул базы
 * (`db/index.ts`): в `vite dev` модуль выполняется заново, и каждое выполнение
 * открывало бы ещё одно соединение, не закрыв прежнее.
 */
const CLIENT = Symbol.for('alma-crm.redis.client');

interface Held {
	url: string;
	client: Redis;
}

function held(): Held | undefined {
	return (globalThis as Record<symbol, Held | undefined>)[CLIENT];
}

function hold(value: Held | undefined): void {
	(globalThis as Record<symbol, Held | undefined>)[CLIENT] = value;
}

/**
 * The shared Redis connection.
 *
 * Built on first use for the same reason as the database handle, and with
 * `lazyConnect` so that constructing it does not open a socket either.
 */
export function getRedis(): Redis {
	const url = getConfig().REDIS_URL;
	const current = held();

	if (current !== undefined && current.url === url) {
		return current.client;
	}

	current?.client.disconnect();

	const client = new Redis(url, {
		lazyConnect: true,
		// A request must not wait on a dead Redis: surface the failure instead.
		maxRetriesPerRequest: 2,
		commandTimeout: 5_000
	});
	hold({ url, client });
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

/**
 * Закрывает общее соединение, если оно было открыто.
 *
 * Приложению не нужна: его соединение живёт, пока жив процесс. Нужна скриптам,
 * которые зовут команды приложения и должны завершиться сами, — открытый сокет
 * Redis держит процесс Node живым и после того, как работа сделана.
 */
export async function closeRedis(): Promise<void> {
	const open = held()?.client;
	hold(undefined);

	if (open === undefined) {
		return;
	}

	// Клиент создан, но ни одной команды не отправил (`lazyConnect`): сокета
	// нет, а `QUIT` сначала открыл бы его ради того, чтобы закрыть.
	if (open.status === 'wait') {
		open.disconnect();
		return;
	}

	await open.quit();
}

/** Cheapest possible round-trip to Redis, used by the health endpoint. */
export async function pingRedis(): Promise<void> {
	const reply = await getRedis().ping();
	if (reply !== 'PONG') {
		throw new Error(`Unexpected PING reply from Redis: ${reply}`);
	}
}
