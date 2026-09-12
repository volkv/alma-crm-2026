import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { Redis } from 'ioredis';
import { chromium, type FullConfig } from '@playwright/test';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { hashPassword } from '$lib/server/auth/password';
import { DEMO_EMAILS } from '../scripts/seed/users';

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

/** Сессия администратора: журнал и настройки закрыты для менеджера правами. */
export const ADMIN_STATE = path.join(authDirectory, 'admin.json');

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
		env: { ...process.env, ...env, SEED_DEMO_PASSWORD: DEMO_PASSWORD }
	});

	process.stdout.write(stdout);
}

/** Вход демонстрационной кнопкой и сохранение сессии в файл. */
async function signIn(baseURL: string, roleName: string, file: string): Promise<void> {
	const browser = await chromium.launch();

	try {
		const context = await browser.newContext({ baseURL });
		const page = await context.newPage();

		await page.goto('/login');
		await page.getByRole('button', { name: `Войти как ${roleName}` }).click();
		await page.waitForURL('/');

		await context.storageState({ path: file });
		await context.close();
	} finally {
		await browser.close();
	}
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
	await signIn(baseURL, 'менеджер', MANAGER_STATE);
	await signIn(baseURL, 'администратор', ADMIN_STATE);
}
