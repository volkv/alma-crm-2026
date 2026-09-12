import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { Redis } from 'ioredis';
import { chromium, type FullConfig, type Page } from '@playwright/test';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { hashPassword } from '$lib/server/auth/password';
import { DEMO_EMAILS, STAFF_ADMIN_EMAIL } from '../scripts/seed/users';

/**
 * Готовит прогон: применяет миграции, заливает те же начальные данные, что и
 * стенд, и один раз входит в систему за каждую роль, которая нужна тестам.
 *
 * Данные заливает не этот файл, а `scripts/seed` — обычным дочерним процессом.
 * Сервисы приложения здесь недоступны (Playwright запускает файл обычным Node,
 * где нет `$env/dynamic/private`), а держать рядом второй набор учётных записей
 * значило бы проверять стенд, которого не существует: на демонстрации будут
 * ровно эти вузы, взаимодействия и кнопки входа.
 *
 * Вход делается здесь, а не в фикстуре, потому что POST на `/login` ограничен
 * по адресу: восемь рабочих процессов, каждый со своим входом, упирались в
 * защиту, рассчитанную на живого человека. Сессии складываются в файлы, и
 * тесты стартуют уже вошедшими.
 */

/** Пароль демонстрационных учётных записей прогона. */
const DEMO_PASSWORD = 'Проверка-Входа1';

/** Учётная запись, которой тесты входят по паролю; заводится сидом. */
export const E2E_USER = {
	email: 'manager@demo.lct-crm.local',
	fullName: 'Менеджер Демо',
	password: DEMO_PASSWORD
};

const authDirectory = new URL('../.playwright/auth/', import.meta.url).pathname;

/** Сессия менеджера: под ней идут почти все проверки. */
export const MANAGER_STATE = path.join(authDirectory, 'manager.json');

/**
 * Сессия демонстрационного администратора: журнал и настройки закрыты для
 * менеджера правами. Она демонстрационная — со всеми ограничениями стенда: без
 * управления пользователями, ключами, настройками и без выгрузки журнала.
 */
export const ADMIN_STATE = path.join(authDirectory, 'admin.json');

/**
 * Сессия штатного администратора: обычная учётная запись оператора, не
 * демонстрационная. Ею проверяется то, чего публичной демонстрации делать
 * нельзя, — заведение сотрудников, выпуск ключей, правка настроек.
 */
export const STAFF_ADMIN_STATE = path.join(authDirectory, 'staff-admin.json');

/**
 * Штатный администратор прогона. Его заводит сид — тот же, что и на стенде:
 * учётную запись оператора там нельзя ни завести, ни восстановить изнутри
 * демонстрации, поэтому её пароль приходит переменной окружения. Прогон
 * передаёт сиду свой пароль и входит им.
 */
export const STAFF_ADMIN = {
	email: STAFF_ADMIN_EMAIL,
	password: DEMO_PASSWORD
};

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
 * Заливка данных тем же входом, что и на стенде. Вывод сида показывается
 * целиком: по нему видно, сколько строк в базе и собрались ли документы.
 */
async function seedDatabase(env: ServerEnv): Promise<void> {
	const { stdout } = await run(process.execPath, ['scripts/seed/index.ts'], {
		cwd: new URL('..', import.meta.url).pathname,
		env: {
			...process.env,
			...env,
			SEED_DEMO_PASSWORD: DEMO_PASSWORD,
			// Пароль администратора стенда задаёт прогон, а не окружение машины:
			// иначе вход штатной учётной записью зависел бы от чужого `.env`.
			SEED_STAFF_ADMIN_PASSWORD: STAFF_ADMIN.password
		}
	});

	process.stdout.write(stdout);
}

/** Вход и сохранение сессии в файл; чем входить — решает `enter`. */
async function signIn(
	baseURL: string,
	file: string,
	enter: (page: Page) => Promise<void>
): Promise<void> {
	const browser = await chromium.launch();

	try {
		const context = await browser.newContext({ baseURL });
		const page = await context.newPage();

		await page.goto('/login');
		await enter(page);
		await page.waitForURL('/');

		await context.storageState({ path: file });
		await context.close();
	} finally {
		await browser.close();
	}
}

/** Вход демонстрационной кнопкой: под ней общая учётная запись стенда. */
function byDemoButton(roleName: string): (page: Page) => Promise<void> {
	return async (page) => {
		await page.getByRole('button', { name: `Войти как ${roleName}` }).click();
	};
}

/** Вход по паролю: так входит штатный сотрудник, и сессия выходит не демо. */
function byPassword(email: string, password: string): (page: Page) => Promise<void> {
	return async (page) => {
		await page.getByLabel('Рабочая почта').fill(email);
		await page.getByLabel('Пароль').fill(password);
		await page.getByRole('button', { name: 'Войти', exact: true }).click();
	};
}

export default async function globalSetup(config: FullConfig): Promise<void> {
	const env = serverEnvironment(config);
	const sql = postgres(env.DATABASE_URL, { max: 1, connect_timeout: 10 });

	try {
		await migrate(drizzle(sql), {
			migrationsFolder: new URL('../drizzle', import.meta.url).pathname
		});

		await seedDatabase(env);

		const demoEmails = Object.values(DEMO_EMAILS);

		// Кнопка «Войти как …» берёт первую демонстрационную запись роли по
		// адресу, поэтому чужая запись из общей с разработкой базы может перехватить
		// вход. Прогон идёт по данным сида — остальные демонстрационные записи в
		// нём не участвуют.
		await sql`
			update users set is_active = false, deactivated_at = now()
			where is_demo = true and email <> all(${demoEmails})
		`;

		// Пароль демонстрационных записей задаёт прогон, а не сид: сид бережёт
		// пароль уже заведённой записи — это дело администратора стенда, — и без
		// этой строки проверка входа по паролю зависела бы от того, чем базу
		// заливали в прошлый раз.
		await sql`
			update users set password_hash = ${await hashPassword(DEMO_PASSWORD)}
			where email = any(${demoEmails})
		`;
	} finally {
		await sql.end();
	}

	// Счётчик попыток входа с адреса общий на весь прогон: без сброса второй
	// прогон подряд упёрся бы в предел, рассчитанный на живого человека.
	const redis = new Redis(env.REDIS_URL);

	try {
		const keys = await redis.keys('login_ip:*');

		if (keys.length > 0) {
			await redis.del(...keys);
		}
	} finally {
		await redis.quit();
	}

	const baseURL = config.projects[0]?.use.baseURL;

	if (baseURL === undefined) {
		throw new Error('playwright.config.ts must set baseURL');
	}

	await mkdir(authDirectory, { recursive: true });
	await signIn(baseURL, MANAGER_STATE, byDemoButton('менеджер'));
	await signIn(baseURL, ADMIN_STATE, byDemoButton('администратор'));
	await signIn(baseURL, STAFF_ADMIN_STATE, byPassword(STAFF_ADMIN.email, STAFF_ADMIN.password));
}
