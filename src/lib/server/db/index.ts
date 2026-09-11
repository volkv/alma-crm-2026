import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { getConfig } from '../config';
import * as schema from './schema';

let client: postgres.Sql | undefined;
let database: PostgresJsDatabase<typeof schema> | undefined;

function getClient(): postgres.Sql {
	client ??= postgres(getConfig().DATABASE_URL, {
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
