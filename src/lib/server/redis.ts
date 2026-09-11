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

/** Cheapest possible round-trip to Redis, used by the health endpoint. */
export async function pingRedis(): Promise<void> {
	const reply = await getRedis().ping();
	if (reply !== 'PONG') {
		throw new Error(`Unexpected PING reply from Redis: ${reply}`);
	}
}
