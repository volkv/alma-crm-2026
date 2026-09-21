import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, beforeAll, expect, it } from 'vitest';

const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));

let container: StartedPostgreSqlContainer;
let client: postgres.Sql;

beforeAll(async () => {
	container = await new PostgreSqlContainer('postgres:17-alpine').start();
	client = postgres(container.getConnectionUri(), { max: 1 });

	await migrate(drizzle(client), { migrationsFolder });
});

afterAll(async () => {
	await client?.end();
	await container?.stop();
});

it('talks to the database', async () => {
	const rows = await client<{ value: number }[]>`select 1 as value`;

	expect(rows[0]?.value).toBe(1);
});

it('runs on PostgreSQL 17', async () => {
	const rows = await client<
		{ version: string }[]
	>`select current_setting('server_version') as version`;

	expect(rows[0]?.version).toMatch(/^17\./);
});

it('records applied migrations in the drizzle bookkeeping table', async () => {
	const rows = await client<{ name: string | null }[]>`
		select to_regclass('drizzle.__drizzle_migrations')::text as name
	`;

	expect(rows[0]?.name).toBe('drizzle.__drizzle_migrations');
});

/**
 * Группы процесса и соответствие «вид контрагента → группа» — часть продукта, а
 * не демонстрационные данные: без них у взаимодействия нет процесса. Поэтому их
 * кладёт миграция, и на пустой установке они обязаны быть сразу.
 */
it('ships the process groups and their counterparty kinds with the migrations', async () => {
	const groups = await client<{ key: string; position: number }[]>`
		select key, position from process_groups order by position
	`;

	expect(groups.map((group) => ({ ...group }))).toStrictEqual([
		{ key: 'b2b', position: 1 },
		{ key: 'b2c', position: 2 }
	]);

	const mapping = await client<{ kind: string; key: string }[]>`
		select kinds.kind, groups.key
		from process_group_counterparty_kinds kinds
		join process_groups groups on groups.id = kinds.group_id
		order by kinds.kind
	`;

	expect(mapping.map((row) => ({ ...row }))).toStrictEqual([
		{ kind: 'educational_institution', key: 'b2b' },
		{ kind: 'individual', key: 'b2c' },
		{ kind: 'legal_entity', key: 'b2c' }
	]);
});
