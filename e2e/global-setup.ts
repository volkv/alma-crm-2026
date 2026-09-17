import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { Redis } from 'ioredis';
import { chromium, type FullConfig } from '@playwright/test';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { DEMO_EMAILS, DEMO_LOGINS, STAFF_ADMIN_EMAIL } from '../scripts/seed/users';
import { ensureAccount, keycloakAdmin, type DirectoryAccount } from './helpers/keycloak-admin';
import { signInThroughDirectory } from './helpers/sign-in';

/**
 * Готовит прогон: заводит его базу, применяет миграции, заливает те же
 * начальные данные, что и стенд, приводит каталог учётных записей к тому, чем
 * прогон входит, и один раз входит за каждую роль, которая нужна тестам.
 *
 * Данные заливает не этот файл, а `scripts/seed` — обычным дочерним процессом.
 * Сервисы приложения здесь недоступны (Playwright запускает файл обычным Node,
 * где нет `$env/dynamic/private`), а держать рядом второй набор учётных записей
 * значило бы проверять стенд, которого не существует: на демонстрации будут
 * ровно эти вузы, взаимодействия и учётные записи.
 *
 * Вход делается здесь, а не в фикстуре: восемь рабочих процессов, каждый со
 * своим входом, гоняли бы через каталог восемь настоящих сессий на каждый файл.
 * Сессии складываются в файлы, и тесты стартуют уже вошедшими.
 */

/** Пароль учётных записей прогона в каталоге. */
export const E2E_PASSWORD = 'Проверка-Входа-2026!';

/**
 * Демонстрационный менеджер: под ним идут почти все проверки — и фикстура с
 * готовой сессией, и те спеки, что входят по ходу дела.
 */
export const E2E_USER = {
	login: DEMO_LOGINS.manager,
	email: DEMO_EMAILS.manager,
	fullName: 'Менеджер Демо',
	password: E2E_PASSWORD
};

/** Демонстрационный руководитель: он видит работу своих людей и назначает ответственных. */
export const DEMO_LEAD = {
	login: DEMO_LOGINS.lead,
	email: DEMO_EMAILS.lead,
	password: E2E_PASSWORD
};

/**
 * Штатный администратор стенда: обычная учётная запись оператора, не
 * демонстрационная. Ею проверяется то, чего публичной демонстрации делать
 * нельзя, — управление пользователями и выпуск ключей.
 *
 * В `keycloak/realm-lct.json` его нет: realm описывает стенд, где настоящие
 * учётные записи заводит администратор руками. Прогон заводит его себе сам —
 * так же, как заводит себе базу.
 */
export const STAFF_ADMIN = {
	login: 'staff-admin',
	email: STAFF_ADMIN_EMAIL,
	password: E2E_PASSWORD
};

/**
 * Учётная запись каталога без единой роли CRM. Нужна одному сценарию — отказу
 * во входе: «доступ не назначен» нельзя показать, не имея того, кому не
 * назначен доступ.
 */
export const NO_ROLE_ACCOUNT = {
	login: 'outsider',
	email: 'outsider@example.org',
	password: E2E_PASSWORD
};

const authDirectory = new URL('../.playwright/auth/', import.meta.url).pathname;

/** Сессия демонстрационного менеджера: под ней идут почти все проверки. */
export const MANAGER_STATE = path.join(authDirectory, 'manager.json');

/** Сессия демонстрационного руководителя. */
export const LEAD_STATE = path.join(authDirectory, 'lead.json');

/**
 * Сессия демонстрационного администратора: журнал и настройки закрыты для
 * менеджера правами. Она демонстрационная — со всеми ограничениями стенда: без
 * управления пользователями и ключами.
 */
export const ADMIN_STATE = path.join(authDirectory, 'admin.json');

/** Сессия штатного администратора стенда. */
export const STAFF_ADMIN_STATE = path.join(authDirectory, 'staff-admin.json');

const run = promisify(execFile);

type ServerEnv = Record<string, string>;

function serverEnvironment(config: FullConfig): ServerEnv {
	const server = Array.isArray(config.webServer) ? config.webServer[0] : config.webServer;
	const env = server?.env;

	if (env === undefined || env.DATABASE_URL === undefined || env.REDIS_URL === undefined) {
		throw new Error('playwright.config.ts must set DATABASE_URL and REDIS_URL for the web server');
	}

	return env as ServerEnv;
}

/**
 * Заводит базу прогона, если её ещё нет.
 *
 * База у каждого порта своя (см. `playwright.config.ts`), поэтому её нельзя ни
 * взять из `docker-compose.yml`, ни завести руками перед прогоном: имя знает
 * только конфигурация. `CREATE DATABASE` идёт через служебную базу `postgres` —
 * подключиться к той, которой ещё нет, нельзя.
 */
async function ensureDatabase(url: string): Promise<void> {
	const target = new URL(url);
	const name = decodeURIComponent(target.pathname.slice(1));

	if (name === '') {
		throw new Error(`DATABASE_URL must name a database: ${url}`);
	}

	const maintenance = new URL(url);
	maintenance.pathname = '/postgres';

	const sql = postgres(maintenance.toString(), { max: 1, connect_timeout: 10 });

	try {
		const existing = await sql<{ one: number }[]>`
			select 1 as one from pg_database where datname = ${name}
		`;

		if (existing.length === 0) {
			// Имя собирает конфигурация из номера порта, снаружи оно не приходит;
			// кавычки — чтобы оно осталось именем, а не разъехалось по регистру.
			await sql.unsafe(`create database "${name}"`);
		}
	} finally {
		await sql.end();
	}
}

/**
 * Заливка данных тем же входом, что и на стенде. Вывод сида показывается
 * целиком: по нему видно, сколько строк в базе и собрались ли документы.
 */
async function seedDatabase(env: ServerEnv): Promise<void> {
	const { stdout } = await run(process.execPath, ['scripts/seed/index.ts'], {
		cwd: new URL('..', import.meta.url).pathname,
		env: { ...process.env, ...env }
	});

	process.stdout.write(stdout);
}

/** Учётные записи каталога, которые нужны прогону, и их роли realm. */
const DIRECTORY_ACCOUNTS: readonly DirectoryAccount[] = [
	{
		username: DEMO_LOGINS.admin,
		email: DEMO_EMAILS.admin,
		firstName: 'Администратор',
		lastName: 'Демо',
		realmRole: 'crm-admin'
	},
	{
		username: DEMO_LOGINS.lead,
		email: DEMO_EMAILS.lead,
		firstName: 'Руководитель',
		lastName: 'Демо',
		realmRole: 'crm-lead'
	},
	{
		username: DEMO_LOGINS.manager,
		email: DEMO_EMAILS.manager,
		firstName: 'Менеджер',
		lastName: 'Демо',
		realmRole: 'crm-user'
	},
	{
		username: STAFF_ADMIN.login,
		email: STAFF_ADMIN.email,
		firstName: 'Администратор',
		lastName: 'стенда',
		realmRole: 'crm-admin'
	},
	{
		username: NO_ROLE_ACCOUNT.login,
		email: NO_ROLE_ACCOUNT.email,
		firstName: 'Посторонний',
		lastName: 'Человек',
		realmRole: null
	}
];

/** Вход и сохранение сессии в файл. */
async function storeSession(
	baseURL: string,
	file: string,
	credentials: { login: string; password: string }
): Promise<void> {
	const browser = await chromium.launch();

	try {
		const context = await browser.newContext({ baseURL });
		const page = await context.newPage();

		await signInThroughDirectory(page, credentials);
		await page.waitForURL('/');

		await context.storageState({ path: file });
		await context.close();
	} finally {
		await browser.close();
	}
}

export default async function globalSetup(config: FullConfig): Promise<void> {
	const env = serverEnvironment(config);

	await ensureDatabase(env.DATABASE_URL);

	const sql = postgres(env.DATABASE_URL, { max: 1, connect_timeout: 10 });

	try {
		await migrate(drizzle(sql), {
			migrationsFolder: new URL('../drizzle', import.meta.url).pathname
		});

		await seedDatabase(env);

		// Демонстрационная запись роли, оставшаяся от прошлых прогонов или от
		// общей с разработкой базы, перехватила бы связывание по почте: почта
		// уникальна, и вошедший достался бы не той строке. Прогон идёт по данным
		// сида — остальные демонстрационные записи в нём не участвуют.
		await sql`
			update users set is_active = false, deactivated_at = now()
			where is_demo = true and email <> all(${Object.values(DEMO_EMAILS)})
		`;

		// Связь с каталогом сбрасывается перед каждым прогоном.
		//
		// Контейнер каталога держит realm в памяти — тома у него нет, — поэтому
		// пересозданный контейнер импортирует realm заново, и `sub` у тех же
		// людей становится другим. База прогона при этом переживает прогон: в
		// ней остаётся `external_subject` прежнего экземпляра, вход по новому
		// субъекту запись не узнаёт, а связаться по почте не может — связывание
		// принимает только запись без субъекта. Это то же самое, что на стенде
		// делает администратор кнопкой «Отвязать»: продуктовое правило остаётся
		// нетронутым, а прогон приводит свою базу в соответствие со своим
		// каталогом — обоими он и распоряжается.
		await sql`update users set external_subject = null where external_subject is not null`;
	} finally {
		await sql.end();
	}

	// Счётчик заходов с адреса общий на весь прогон: без сброса второй прогон
	// подряд упёрся бы в предел, рассчитанный на живого человека.
	const redis = new Redis(env.REDIS_URL);

	try {
		const keys = await redis.keys('login_ip:*');

		if (keys.length > 0) {
			await redis.del(...keys);
		}
	} finally {
		await redis.quit();
	}

	// Пароли демонстрационных записей в realm приходят из окружения той машины,
	// на которой подняли контейнер, — прогон не может на них рассчитывать и
	// ставит свои. Заодно заводятся те записи, которых в realm нет вовсе.
	const admin = await keycloakAdmin(env.OIDC_PUBLIC_URL);

	for (const account of DIRECTORY_ACCOUNTS) {
		await ensureAccount(admin, account, E2E_PASSWORD);
	}

	const baseURL = config.projects[0]?.use.baseURL;

	if (baseURL === undefined) {
		throw new Error('playwright.config.ts must set baseURL');
	}

	await mkdir(authDirectory, { recursive: true });
	await storeSession(baseURL, MANAGER_STATE, E2E_USER);
	await storeSession(baseURL, LEAD_STATE, DEMO_LEAD);
	await storeSession(baseURL, ADMIN_STATE, {
		login: DEMO_LOGINS.admin,
		password: E2E_PASSWORD
	});
	await storeSession(baseURL, STAFF_ADMIN_STATE, STAFF_ADMIN);
}
