/**
 * Заливка начальных данных: каталог прав и ролей, учётные записи стенда,
 * справочники.
 *
 * Всё происходит в одной транзакции: половина справочника без ролей и
 * пользователей — это не «частично получилось», а сломанный стенд. Повторный
 * запуск ничего не дублирует и ничего не затирает, поэтому сид можно звать
 * при каждом старте контейнера.
 */
import { count } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { PgTable } from 'drizzle-orm/pg-core';
import postgres from 'postgres';
import { validatePassword } from '$lib/server/auth/password';
import * as schema from '$lib/server/db/schema';
import type { Tx } from '$lib/server/db/transaction';
import { seedRolesAndPermissions } from '$lib/server/rbac/seed';
import { SETTING_DEFAULTS } from '$lib/server/settings';
import { seedDirectory } from './directory';
import { seedUsers, type SeededUsers } from './users';

/**
 * Порядок наборов: сначала права и роли, потом пользователи (у них внешний
 * ключ на роль), потом справочники (версия программы ссылается на автора).
 * Отдельная функция, потому что этот же порядок проверяют тесты.
 */
export async function seedAll(tx: Tx, options: { demoPassword: string }): Promise<SeededUsers> {
	await seedRolesAndPermissions(tx);
	const users = await seedUsers(tx, options);
	await seedDirectory(tx, { authorUserId: users.employees[0] });

	return users;
}

/** Флаг для контейнера: «залей данные, только если это демонстрационный стенд». */
const IF_DEMO_FLAG = '--if-demo';

function requireEnv(name: string, explanation: string): string {
	const value = process.env[name];

	if (value === undefined || value === '') {
		throw new Error(`Переменная ${name} не задана: ${explanation}`);
	}

	return value;
}

/** Таблицы, по которым сид отчитывается: по ним видно, что он сделал. */
const REPORTED_TABLES: Record<string, PgTable> = {
	permissions: schema.permissions,
	roles: schema.roles,
	role_permissions: schema.rolePermissions,
	users: schema.users,
	organizations: schema.organizations,
	sites: schema.sites,
	people: schema.people,
	affiliations: schema.affiliations,
	programs: schema.programs,
	program_versions: schema.programVersions,
	products: schema.products
};

export async function main(argv: readonly string[]): Promise<void> {
	const unknown = argv.filter((argument) => argument !== IF_DEMO_FLAG);

	if (unknown.length > 0) {
		throw new Error(
			`Неизвестные аргументы: ${unknown.join(', ')}. Допустим только ${IF_DEMO_FLAG}`
		);
	}

	if (argv.includes(IF_DEMO_FLAG) && process.env.DEMO_MODE !== 'true') {
		console.log('seed: DEMO_MODE не равен "true" — демонстрационные данные не заливаются');
		return;
	}

	const databaseUrl = requireEnv('DATABASE_URL', 'сиду некуда писать');
	const demoPassword = requireEnv(
		'SEED_DEMO_PASSWORD',
		'это общий пароль демонстрационных учётных записей стенда'
	);

	const issues = validatePassword(SETTING_DEFAULTS.password_policy, demoPassword);

	if (issues.length > 0) {
		throw new Error(`SEED_DEMO_PASSWORD не отвечает политике паролей: ${issues.join('; ')}`);
	}

	// `max: 1` — сид работает одной транзакцией, второе соединение ему не нужно.
	const client = postgres(databaseUrl, { max: 1, connect_timeout: 10 });
	const db = drizzle(client, { schema, casing: 'snake_case' });

	try {
		await db.transaction(async (tx) => {
			await seedAll(tx, { demoPassword });
		});

		const counts = await Promise.all(
			Object.entries(REPORTED_TABLES).map(async ([name, table]) => {
				const [row] = await db.select({ value: count() }).from(table);

				return `${name} ${row.value}`;
			})
		);

		console.log(`seed: готово, в базе ${counts.join(', ')}`);
	} finally {
		await client.end();
	}
}
