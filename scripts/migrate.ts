/**
 * Applies the SQL migrations in `drizzle/` and exits. Run by hand with
 * `pnpm run db:migrate`, and by the container entrypoint before the app starts.
 * Kept separate from the app so a deployment can migrate without serving.
 */
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
	throw new Error('DATABASE_URL is not set; cannot run migrations.');
}

const migrationsFolder = new URL('../drizzle', import.meta.url).pathname;

// `max: 1` — migrations must run on a single connection, in order.
const client = postgres(databaseUrl, { max: 1, connect_timeout: 10 });

try {
	await migrate(drizzle(client), { migrationsFolder });
	console.log(`Migrations applied from ${migrationsFolder}`);
} finally {
	await client.end();
}
