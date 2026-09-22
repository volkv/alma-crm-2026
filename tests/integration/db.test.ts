/**
 * Миграции на пустой установке: что получает тот, кто ставит систему с нуля.
 *
 * База здесь своя и пустая, а не снятая с образца, как у остальных файлов
 * (`helpers/db.ts`): образец — это и есть результат миграций, и проверять его
 * значило бы спрашивать у ответа, верен ли он. PostgreSQL берётся общий,
 * прогонный: контейнер ради одной пустой базы не нужен.
 */
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';
import { databaseUri } from './helpers/stack';

const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));
const databaseName = `lct_migrations_${crypto.randomUUID().replaceAll('-', '')}`;

let client: postgres.Sql;

beforeAll(async () => {
	const stack = inject('integrationStack');
	const admin = postgres(stack.postgresUri, { max: 1 });

	try {
		await admin.unsafe(`create database "${databaseName}"`);
	} finally {
		await admin.end();
	}

	client = postgres(databaseUri(stack.postgresUri, databaseName), { max: 1 });

	await migrate(drizzle(client), { migrationsFolder });
});

afterAll(async () => {
	await client?.end();

	const admin = postgres(inject('integrationStack').postgresUri, { max: 1 });

	try {
		await admin.unsafe(`drop database if exists "${databaseName}" with (force)`);
	} finally {
		await admin.end();
	}
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
 * Пространства и соответствие «вид контрагента → пространство» — часть продукта,
 * а не демонстрационные данные: без них у взаимодействия нет процесса. Поэтому
 * их кладёт миграция, и на пустой установке они обязаны быть сразу.
 */
it('ships the workspaces and their counterparty kinds with the migrations', async () => {
	const rows = await client<{ key: string; position: number }[]>`
		select key, position from workspaces order by position
	`;

	expect(rows.map((row) => ({ ...row }))).toStrictEqual([
		{ key: 'b2b', position: 1 },
		{ key: 'b2c', position: 2 }
	]);

	const mapping = await client<{ kind: string; key: string }[]>`
		select kinds.kind, workspaces.key
		from process_group_counterparty_kinds kinds
		join workspaces on workspaces.id = kinds.group_id
		order by kinds.kind
	`;

	expect(mapping.map((row) => ({ ...row }))).toStrictEqual([
		{ kind: 'educational_institution', key: 'b2b' },
		{ kind: 'individual', key: 'b2c' },
		{ kind: 'legal_entity', key: 'b2c' }
	]);
});
