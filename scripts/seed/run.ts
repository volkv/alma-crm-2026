/**
 * Заливка начальных данных: каталог прав и ролей, учётные записи стенда,
 * справочники, процессы групп, демонстрационные взаимодействия и договоры.
 *
 * Заливка идёт в два приёма. Конфигурация и справочники — одной транзакцией:
 * половина справочника без ролей и пользователей — это не «частично
 * получилось», а сломанный стенд. Взаимодействия — после её фиксации, потому
 * что их историю пишет сам движок стадий, а каждая его команда открывает
 * собственную транзакцию и незафиксированных справочников не увидит.
 *
 * Повторный запуск ничего не дублирует и ничего не затирает, поэтому сид можно
 * звать при каждом старте контейнера.
 *
 * Подключение — то же самое, что у приложения (`getDb()`): сид зовёт его
 * сервисы, и второй пул рядом означал бы вторую конфигурацию и вторую точку
 * отказа. Поэтому же вход закрывает его сам — открытые сокеты держат процесс
 * живым и после того, как работа сделана.
 */
import { count } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { closeDatabase, getDb } from '$lib/server/db';
import * as schema from '$lib/server/db/schema';
import { seedRolesAndPermissions } from '$lib/server/rbac/seed';
import { B2B_GROUP_KEY } from '$lib/server/stages/definitions';
import { seedContracts } from './contracts';
import { seedDirectory } from './directory';
import { seedInteractions } from './interactions';
import { seedProcesses } from './process';
import { seedStats } from './stats';
import { seedUsers, type SeededUsers } from './users';

/**
 * Порядок наборов: сначала права и роли, потом пользователи (у них внешний
 * ключ на роль), потом справочники (версия программы ссылается на автора),
 * данные об обучении и процессы групп, и только затем взаимодействия, которым
 * нужно всё перечисленное.
 * Отдельная функция, потому что этот же порядок проверяют тесты.
 */
export async function seedAll(): Promise<SeededUsers> {
	const users = await getDb().transaction(async (tx) => {
		await seedRolesAndPermissions(tx);
		const seededUsers = await seedUsers(tx);
		await seedDirectory(tx, { authorUserId: seededUsers.employees[0] });
		// Данные об обучении ссылаются на организации и программы, поэтому идут
		// после справочника и в той же транзакции.
		await seedStats(tx, { authorUserId: seededUsers.employees[0] });

		await seedProcesses(tx);

		return seededUsers;
	});

	await seedInteractions({ groupKey: B2B_GROUP_KEY });
	// После взаимодействий: договор ссылается на уже заведённую запись.
	await seedContracts();

	return users;
}

/**
 * Каталог прав и ролей — и ничего больше: ни учётных записей, ни справочников.
 *
 * То же самое делает `scripts/migrate.ts` на каждом применении миграций, и
 * обычно ручка не нужна вовсе. Она нужна там, где каталог разошёлся с кодом, а
 * перезапускать приложение ради этого нельзя: операция идемпотентна и данных не
 * касается, поэтому её можно выполнить на работающей установке.
 */
export async function seedRolesOnly(): Promise<void> {
	await getDb().transaction(async (tx) => {
		await seedRolesAndPermissions(tx);
	});
}

/** Флаг для контейнера: «залей данные, только если это демонстрационный стенд». */
const IF_DEMO_FLAG = '--if-demo';

/** Флаг ручного прогона: «приведи каталог прав к коду и на этом всё». */
const ROLES_ONLY_FLAG = '--roles-only';

/** Таблицы каталога прав: по ним видно, что сделал прогон с `--roles-only`. */
const ROLE_TABLES: Record<string, PgTable> = {
	permissions: schema.permissions,
	roles: schema.roles,
	role_permissions: schema.rolePermissions
};

/** Таблицы, по которым сид отчитывается: по ним видно, что он сделал. */
const REPORTED_TABLES: Record<string, PgTable> = {
	...ROLE_TABLES,
	users: schema.users,
	organizations: schema.organizations,
	sites: schema.sites,
	people: schema.people,
	affiliations: schema.affiliations,
	programs: schema.programs,
	program_versions: schema.programVersions,
	products: schema.products,
	directions: schema.directions,
	organization_responsibles: schema.organizationResponsibles,
	interactions: schema.interactions,
	contracts: schema.contracts,
	stage_entries: schema.stageEntries,
	documents: schema.documents,
	stat_snapshots: schema.statSnapshots,
	stat_rows: schema.statRows
};

/** Строка отчёта «в базе столько-то»: имя таблицы и число строк в ней. */
async function countRows(tables: Record<string, PgTable>): Promise<string> {
	const db = getDb();

	const counts = await Promise.all(
		Object.entries(tables).map(async ([name, table]) => {
			const [row] = await db.select({ value: count() }).from(table);

			return `${name} ${row.value}`;
		})
	);

	return counts.join(', ');
}

export async function main(argv: readonly string[]): Promise<void> {
	const known = [IF_DEMO_FLAG, ROLES_ONLY_FLAG];
	const unknown = argv.filter((argument) => !known.includes(argument));

	if (unknown.length > 0) {
		throw new Error(
			`Неизвестные аргументы: ${unknown.join(', ')}. Допустимы только ${known.join(', ')}`
		);
	}

	if (argv.includes(ROLES_ONLY_FLAG)) {
		if (argv.includes(IF_DEMO_FLAG)) {
			throw new Error(
				`${ROLES_ONLY_FLAG} и ${IF_DEMO_FLAG} вместе бессмысленны: каталог прав нужен любой установке, а не только демонстрационной`
			);
		}

		try {
			await seedRolesOnly();
			console.log(`seed: каталог прав приведён к коду, в базе ${await countRows(ROLE_TABLES)}`);
		} finally {
			await closeDatabase();
		}

		return;
	}

	if (argv.includes(IF_DEMO_FLAG) && process.env.DEMO_MODE !== 'true') {
		console.log('seed: DEMO_MODE не равен "true" — демонстрационные данные не заливаются');
		return;
	}

	try {
		await seedAll();

		console.log(`seed: готово, в базе ${await countRows(REPORTED_TABLES)}`);
	} finally {
		await closeDatabase();
	}
}
