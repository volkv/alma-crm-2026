/**
 * Заливка начальных данных: каталог прав и ролей, учётные записи стенда,
 * справочники, маршрут стадий и демонстрационные взаимодействия.
 *
 * Заливка идёт в два приёма. Конфигурация и справочники — одной транзакцией:
 * половина справочника без ролей и пользователей — это не «частично
 * получилось», а сломанный стенд. Взаимодействия — после её фиксации, потому
 * что их историю пишет сам движок стадий, а каждая его команда открывает
 * собственную транзакцию и незафиксированных справочников не увидит.
 *
 * Повторный запуск ничего не дублирует и ничего не затирает, поэтому сид можно
 * звать при каждом старте контейнера.
 */
import { count } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { validatePassword } from '$lib/server/auth/password';
import { closeDatabase, getDb } from '$lib/server/db';
import * as schema from '$lib/server/db/schema';
import { seedRolesAndPermissions } from '$lib/server/rbac/seed';
import { SETTING_DEFAULTS } from '$lib/server/settings';
import { ensureDemoRoute } from '$lib/server/stages/routes';
import { seedDirectory } from './directory';
import { seedInteractions } from './interactions';
import { seedUsers, STAFF_ADMIN_EMAIL, type SeededUsers } from './users';

/**
 * Порядок наборов: сначала права и роли, потом пользователи (у них внешний
 * ключ на роль), потом справочники (версия программы ссылается на автора) и
 * маршрут, и только затем взаимодействия, которым нужно всё перечисленное.
 * Отдельная функция, потому что этот же порядок проверяют тесты.
 */
export async function seedAll(options: {
	demoPassword: string;
	/** Пароль администратора стенда; без него запись не заводится вовсе. */
	staffAdminPassword?: string;
}): Promise<SeededUsers> {
	// Проверка здесь, а не в `main`: пароль, положенный сидом, обязан отвечать
	// той же политике, что и заведённый руками, кто бы сид ни звал.
	checkPassword('SEED_DEMO_PASSWORD', options.demoPassword);

	if (options.staffAdminPassword !== undefined) {
		checkPassword('SEED_STAFF_ADMIN_PASSWORD', options.staffAdminPassword);
	}

	const { users, routeId } = await getDb().transaction(async (tx) => {
		await seedRolesAndPermissions(tx);
		const seededUsers = await seedUsers(tx, options);
		await seedDirectory(tx, { authorUserId: seededUsers.employees[0] });

		return { users: seededUsers, routeId: await ensureDemoRoute(tx) };
	});

	await seedInteractions({ routeId });

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

/** Необязательная переменная: пустая строка — то же самое, что незаданная. */
function optionalEnv(name: string): string | undefined {
	const value = process.env[name];

	return value === undefined || value === '' ? undefined : value;
}

function checkPassword(name: string, password: string): void {
	const issues = validatePassword(SETTING_DEFAULTS.password_policy, password);

	if (issues.length > 0) {
		throw new Error(`${name} не отвечает политике паролей: ${issues.join('; ')}`);
	}
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
	products: schema.products,
	interactions: schema.interactions,
	stage_entries: schema.stageEntries,
	documents: schema.documents
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

	const demoPassword = requireEnv(
		'SEED_DEMO_PASSWORD',
		'это общий пароль демонстрационных учётных записей стенда'
	);

	const staffAdminPassword = optionalEnv('SEED_STAFF_ADMIN_PASSWORD');

	if (staffAdminPassword === undefined) {
		console.log(
			`seed: SEED_STAFF_ADMIN_PASSWORD не задана — учётная запись ${STAFF_ADMIN_EMAIL} не заводится`
		);
	}

	// Подключение — то же самое, что у приложения: сид зовёт его сервисы, и
	// второй пул рядом означал бы вторую конфигурацию и вторую точку отказа.
	const db = getDb();

	try {
		await seedAll({ demoPassword, staffAdminPassword });

		const counts = await Promise.all(
			Object.entries(REPORTED_TABLES).map(async ([name, table]) => {
				const [row] = await db.select({ value: count() }).from(table);

				return `${name} ${row.value}`;
			})
		);

		console.log(`seed: готово, в базе ${counts.join(', ')}`);
	} finally {
		await closeDatabase();
	}
}
