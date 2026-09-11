import { defineConfig } from 'drizzle-kit';

const url = process.env.DATABASE_URL;

if (!url) {
	throw new Error('DATABASE_URL is not set; drizzle-kit cannot reach the database.');
}

export default defineConfig({
	schema: './src/lib/server/db/schema/index.ts',
	out: './drizzle',
	dialect: 'postgresql',
	dbCredentials: { url },
	// Identifiers are camelCase in TypeScript and snake_case in PostgreSQL.
	casing: 'snake_case',
	verbose: true,
	strict: true
});
