import { Redis } from 'ioredis';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import type { FullConfig } from '@playwright/test';
import { hashPassword } from '$lib/server/auth/password';
import { DEFAULT_ROLES, PERMISSIONS, PERMISSION_KEYS } from '$lib/server/rbac/permissions';

/**
 * Готовит окружение прогона: применяет миграции, заливает каталог ролей и
 * заводит учётные записи, под которыми ходят тесты.
 *
 * Делается это один раз и до старта сервера — иначе первая же страница, которой
 * нужны настройки или пользователь, упала бы на пустой базе. Сервисы приложения
 * здесь недоступны: Playwright запускает этот файл обычным Node, где нет
 * `$env/dynamic/private`, поэтому база правится напрямую. Всё, что можно взять
 * из кода приложения, берётся из него — каталог прав и хеширование пароля.
 */

/** Учётная запись для входа по паролю. Демонстрационные входят без него. */
export const E2E_USER = {
	email: 'e2e@example.org',
	fullName: 'Егорова Елена',
	password: 'Проверка-Входа1',
	roleId: 'manager'
};

type SeedUser = {
	email: string;
	full_name: string;
	role_id: string;
	password_hash: string;
	is_demo: boolean;
};

export default async function globalSetup(config: FullConfig): Promise<void> {
	const server = Array.isArray(config.webServer) ? config.webServer[0] : config.webServer;
	const databaseUrl = server?.env?.DATABASE_URL;
	const redisUrl = server?.env?.REDIS_URL;

	if (databaseUrl === undefined || redisUrl === undefined) {
		throw new Error('playwright.config.ts must set DATABASE_URL and REDIS_URL for the web server');
	}

	const sql = postgres(databaseUrl, { max: 1, connect_timeout: 10 });

	try {
		await migrate(drizzle(sql), {
			migrationsFolder: new URL('../drizzle', import.meta.url).pathname
		});

		await sql`
			insert into permissions ${sql(
				PERMISSION_KEYS.map((key) => ({ key, description: PERMISSIONS[key] }))
			)}
			on conflict (key) do update set description = excluded.description
		`;

		for (const role of DEFAULT_ROLES) {
			await sql`
				insert into roles ${sql({
					id: role.id,
					name: role.name,
					description: role.description,
					is_system: true
				})}
				on conflict (id) do update set name = excluded.name, description = excluded.description
			`;

			await sql`delete from role_permissions where role_id = ${role.id}`;
			await sql`
				insert into role_permissions ${sql(
					role.permissions.map((key) => ({ role_id: role.id, permission_key: key }))
				)}
			`;
		}

		const passwordHash = await hashPassword(E2E_USER.password);
		const demoHash = await hashPassword(`демо-${crypto.randomUUID()}`);

		const accounts: SeedUser[] = [
			{
				email: E2E_USER.email,
				full_name: E2E_USER.fullName,
				role_id: E2E_USER.roleId,
				password_hash: passwordHash,
				is_demo: false
			},
			...DEFAULT_ROLES.map((role) => ({
				email: `demo-${role.id}@example.org`,
				full_name: `Демонстрация: ${role.name}`,
				role_id: role.id,
				// Пароля у демонстрационной записи нет: в неё входят кнопкой, а
				// пустой хеш в столбце `not null` не положишь.
				password_hash: demoHash,
				is_demo: true
			}))
		];

		for (const account of accounts) {
			await sql`
				insert into users ${sql(account)}
				on conflict (lower(email)) do update
				set full_name = excluded.full_name,
					role_id = excluded.role_id,
					password_hash = excluded.password_hash,
					is_demo = excluded.is_demo,
					is_active = true,
					deactivated_at = null
			`;
		}
	} finally {
		await sql.end();
	}

	// Счётчик попыток входа с адреса общий на весь прогон: без сброса второй
	// прогон подряд упёрся бы в предел, рассчитанный на живого человека.
	const redis = new Redis(redisUrl);

	try {
		const keys = await redis.keys('login_ip:*');

		if (keys.length > 0) {
			await redis.del(...keys);
		}
	} finally {
		await redis.quit();
	}
}
