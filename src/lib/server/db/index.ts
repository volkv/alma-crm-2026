import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { getConfig } from '../config';
import * as schema from './schema';

let client: postgres.Sql | undefined;
let database: PostgresJsDatabase<typeof schema> | undefined;

/**
 * Connections in the pool.
 *
 * A transaction holds one connection from `begin` to `commit`, and while it is
 * open the code inside it still needs a second one: refusals of the audit log
 * and the personal-data view trace are written on their own connection by
 * design, so that a rollback cannot take them with it. A pool sized to the
 * number of simultaneous transactions therefore locks up for good — every
 * transaction holds a connection and waits for one nobody is left to release.
 *
 * Twenty four leaves room for a dozen simultaneous transactions together with
 * the writes that happen next to them. The ceiling on transactions is the
 * number of requests in flight and nothing else: adapter-node serves them from
 * a single process. On the other side PostgreSQL allows 100 connections by
 * default, so a pool this size still leaves room for migrations, a psql session
 * and a second instance of the app.
 */
const POOL_MAX = 24;

function getClient(): postgres.Sql {
	client ??= postgres(getConfig().DATABASE_URL, {
		max: POOL_MAX,
		// Fail a stuck connection attempt instead of hanging a request forever.
		connect_timeout: 10
	});
	return client;
}

/**
 * The Drizzle handle for the primary database.
 *
 * Built on first use, not on import: SvelteKit loads every server module while
 * it builds the app, and a connection opened there would run without a real
 * environment and outlive the build.
 */
export function getDb(): PostgresJsDatabase<typeof schema> {
	database ??= drizzle(getClient(), { schema, casing: 'snake_case' });
	return database;
}

/** Cheapest possible round-trip to the database, used by the health endpoint. */
export async function pingDatabase(): Promise<void> {
	await getClient()`select 1`;
}

/**
 * Closes the pool and forgets the handle. Needed wherever the process has to
 * end on its own — a test run, a one-off script — because open sockets keep
 * Node alive long after the work is done.
 */
export async function closeDatabase(): Promise<void> {
	const open = client;
	client = undefined;
	database = undefined;

	if (open !== undefined) {
		await open.end();
	}
}
