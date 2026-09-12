/**
 * Applies the SQL migrations in `drizzle/`, brings the permission catalogue in
 * line with the code and exits. Run by hand with `pnpm run db:migrate`, and by
 * the container entrypoint before the app starts. Kept separate from the app so
 * a deployment can migrate without serving.
 *
 * The catalogue of permissions and roles belongs to the code, not to the data:
 * a release that adds a permission must hand it to the roles that have it in
 * `$lib/server/rbac/permissions`, on every installation and without anyone
 * remembering to run anything. That is why it is applied here, next to the
 * migrations, and not by the seed — the seed also fills demo accounts and a
 * directory of invented universities, which a real installation must never get.
 */
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { installKitAliases } from './seed/aliases.ts';

// The app code below is written in build specifiers (`$lib/…`) that plain Node
// does not understand; the hooks must be in place before the first such import,
// so the modules arrive dynamically. See `scripts/seed/aliases.ts`.
installKitAliases();

const schema = await import('$lib/server/db/schema');
const { seedRolesAndPermissions } = await import('$lib/server/rbac/seed');

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
	throw new Error('DATABASE_URL is not set; cannot run migrations.');
}

const migrationsFolder = new URL('../drizzle', import.meta.url).pathname;

// Its own connection rather than `getDb()`: the app handle reads the whole
// configuration, and migrating a database must not require an SMTP host or a
// Redis address. `max: 1` — migrations must run on a single connection, in order.
const client = postgres(databaseUrl, { max: 1, connect_timeout: 10 });

try {
	const db = drizzle(client, { schema, casing: 'snake_case' });

	await migrate(db, { migrationsFolder });
	console.log(`Migrations applied from ${migrationsFolder}`);

	// One transaction: a catalogue half brought to the code would leave roles
	// without the permissions their actions are checked against.
	await db.transaction(async (tx) => {
		await seedRolesAndPermissions(tx);
	});
	console.log('Permission catalogue matches the code');
} finally {
	await client.end();
}
