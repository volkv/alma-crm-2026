/**
 * Настоящее окружение для интеграционных тестов.
 *
 * Контейнеры PostgreSQL 17 и Redis 8 поднимаются на файл тестов, к базе
 * применяются миграции из `drizzle/` и заливается каталог прав. Проверять схему
 * на заглушке бессмысленно: триггеры, частичные индексы, CHECK и представление —
 * это и есть то, что проверяется; то же и с Redis: счётчики попыток, лимиты и
 * сессии живут в нём, и подделка проверяла бы подделку.
 *
 * Своё хранилище на файл, а не общее из `docker-compose.yml`: прогон не должен
 * ни зависеть от того, что насчитал предыдущий, ни мешать соседнему. Из compose
 * остаётся только Gotenberg (`GOTENBERG_URL`) — он тяжёлый, тянуть по контейнеру
 * на файл ради тестов документов дороже, чем держать один на машину.
 *
 * Файл теста обязан объявить в самом верху
 *
 * ```ts
 * vi.mock('$env/dynamic/private', () => ({ env: process.env }));
 * ```
 *
 * — иначе `$env/dynamic/private` останется слепком `.env`, снятым при запуске
 * Vitest, и сервисы пойдут не в контейнер, а в базу разработчика.
 */
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { Redis } from 'ioredis';
import postgres from 'postgres';
import type { StageSnapshot } from '$lib/contracts/interactions';
import type { ActorContext } from '$lib/server/actor';
import * as schema from '$lib/server/db/schema';
import { DEFAULT_ROLES, type PermissionKey } from '$lib/server/rbac/permissions';
import { defaultRolePermissions, seedRolesAndPermissions } from '$lib/server/rbac/seed';

const migrationsFolder = new URL('../../../drizzle', import.meta.url).pathname;

export type TestDatabase = {
	/** Тот же самый handle, что получают сервисы через `getDb()`. */
	db: PostgresJsDatabase<typeof schema>;
	/** Отдельное соединение для сырого SQL: DDL, проверки ограничений. */
	raw: postgres.Sql;
	/**
	 * Возвращает окружение к началу: чистит таблицы, заново заливает каталог
	 * прав и стирает Redis целиком.
	 *
	 * Redis сюда входит наравне с базой. Счётчики лимитов и пачек живут окно в
	 * целую минуту и очистку таблиц переживают: без этой строки тест видел бы
	 * то, что насчитал предыдущий, и порядок тестов в файле стал бы значимым.
	 */
	reset: () => Promise<void>;
	stop: () => Promise<void>;
};

export async function startTestDatabase(): Promise<TestDatabase> {
	// Параллельно: Redis поднимается заметно быстрее PostgreSQL и на общем
	// времени файла не сказывается.
	const [container, redisContainer]: [StartedPostgreSqlContainer, StartedRedisContainer] =
		await Promise.all([
			new PostgreSqlContainer('postgres:17-alpine').start(),
			new RedisContainer('redis:8-alpine').start()
		]);

	const uri = container.getConnectionUri();

	// Конфигурация читается из окружения целиком, поэтому заполняем её целиком:
	// иначе `getConfig()` справедливо упадёт на первой же недостающей переменной.
	process.env.NODE_ENV = 'test';
	process.env.DATABASE_URL = uri;
	process.env.REDIS_URL = redisContainer.getConnectionUrl();
	process.env.GOTENBERG_URL = 'http://localhost:3001';
	process.env.SMTP_HOST = 'localhost';
	process.env.SMTP_PORT = '1025';
	process.env.ORIGIN = 'http://localhost:5173';
	process.env.DEMO_MODE = 'false';
	process.env.TRUST_PROXY = 'false';
	process.env.DATA_DIR = './.test-data';

	const raw = postgres(uri, { max: 1 });
	await migrate(drizzle(raw), { migrationsFolder });

	// Своё соединение, а не общее `getRedis()`: тестам его отдавать незачем, а
	// закрывают они своё сами — и закрытое общее не годилось бы для уборки.
	const redis = new Redis(redisContainer.getConnectionUrl());

	// Динамический импорт: к этому моменту окружение уже выставлено, поэтому
	// первый же `getConfig()` внутри увидит адрес контейнера.
	const { closeDatabase, getDb } = await import('$lib/server/db');
	const db = getDb();

	const reset = async (): Promise<void> => {
		await redis.flushall();

		const tables = await raw<{ name: string }[]>`
			select table_name as name
			from information_schema.tables
			where table_schema = 'public' and table_type = 'BASE TABLE'
		`;

		if (tables.length > 0) {
			// TRUNCATE не перехватывается строковым триггером append-only, поэтому
			// журнал чистится вместе со всем остальным.
			const list = tables.map((table) => `"${table.name}"`).join(', ');
			await raw.unsafe(`truncate table ${list} restart identity cascade`);
		}

		await db.transaction(async (tx) => {
			await seedRolesAndPermissions(tx);

			// По пользователю на роль: внешние ключи на автора действия стоят
			// почти везде, и без этих строк ни одно событие журнала не записать.
			await tx.insert(schema.users).values(
				DEFAULT_ROLES.map((role) => ({
					id: TEST_USER_IDS[role.id] ?? crypto.randomUUID(),
					email: `${role.id}@example.org`,
					fullName: `Тестовый ${role.name}`,
					roleId: role.id,
					passwordHash: 'not-a-real-hash'
				}))
			);
		});
	};

	await reset();

	return {
		db,
		raw,
		reset,
		stop: async () => {
			await closeDatabase();
			await raw.end();
			await redis.quit();
			await Promise.all([container.stop(), redisContainer.stop()]);
		}
	};
}

/** Пользователь на каждую системную роль; создаётся в `reset()`. */
export const TEST_USER_IDS: Record<string, string> = {
	admin: '00000000-0000-4000-8000-0000000000a1',
	manager: '00000000-0000-4000-8000-0000000000a2',
	viewer: '00000000-0000-4000-8000-0000000000a3'
};

/** Код ошибки PostgreSQL из того, во что её завернул Drizzle. */
function pgErrorCode(error: unknown): string | undefined {
	let current: unknown = error;

	while (current instanceof Error) {
		const code = (current as { code?: unknown }).code;
		if (typeof code === 'string') {
			return code;
		}
		current = current.cause;
	}

	return undefined;
}

/** Код ошибки, с которой упал запрос, или `undefined`, если он прошёл. */
export async function failureCode(promise: Promise<unknown>): Promise<string | undefined> {
	try {
		await promise;
		return undefined;
	} catch (error) {
		return pgErrorCode(error);
	}
}

/** Контекст действующего лица для тестов: по умолчанию — администратор со всем. */
export function testActor(options?: {
	roleId?: string;
	userId?: string;
	permissions?: readonly PermissionKey[];
	organizationIds?: readonly string[];
}): ActorContext {
	const roleId = options?.roleId ?? 'admin';
	const permissions =
		options?.permissions !== undefined
			? new Set<string>(options.permissions)
			: defaultRolePermissions(roleId);

	return {
		requestId: '00000000-0000-4000-8000-00000000fee1',
		source: 'ui',
		user: {
			id: options?.userId ?? TEST_USER_IDS[roleId] ?? TEST_USER_IDS.admin,
			email: 'tester@example.org',
			fullName: 'Тестовый Пользователь',
			roleId,
			permissions,
			isDemo: false,
			scope:
				options?.organizationIds === undefined
					? { kind: 'all' }
					: { kind: 'organizations', organizationIds: new Set(options.organizationIds) }
		},
		apiKeyId: null,
		ip: '198.51.100.7',
		userAgent: 'vitest',
		scope:
			options?.organizationIds === undefined
				? { kind: 'all' }
				: { kind: 'organizations', organizationIds: new Set(options.organizationIds) }
	};
}

/** Пользователь в базе: нужен всюду, где стоит внешний ключ на автора действия. */
export async function insertUser(
	database: PostgresJsDatabase<typeof schema>,
	options: { id?: string; email?: string; roleId?: string } = {}
): Promise<string> {
	const [row] = await database
		.insert(schema.users)
		.values({
			id: options.id,
			email: options.email ?? `user-${crypto.randomUUID()}@example.org`,
			fullName: 'Тестовый Пользователь',
			roleId: options.roleId ?? 'admin',
			passwordHash: 'not-a-real-hash'
		})
		.returning({ id: schema.users.id });

	return row.id;
}

/** Организация-вуз: самый частый участник взаимодействия. */
export async function insertOrganization(
	database: PostgresJsDatabase<typeof schema>,
	options: { shortName?: string; inn?: string | null } = {}
): Promise<string> {
	const [row] = await database
		.insert(schema.organizations)
		.values({
			kind: 'educational_institution',
			educationLevel: 'vo',
			legalName: options.shortName ?? 'Федеральное государственное учреждение',
			shortName: options.shortName ?? `Вуз ${crypto.randomUUID().slice(0, 8)}`,
			inn: options.inn ?? null
		})
		.returning({ id: schema.organizations.id });

	return row.id;
}

/** Маршрут с одной стадией и взаимодействие на нём. */
export async function insertInteractionWithStage(
	database: PostgresJsDatabase<typeof schema>,
	options: { ownerUserId: string; slaDays?: number }
): Promise<{ interactionId: string; stageId: string; snapshot: StageSnapshot }> {
	const slaDays = options.slaDays ?? 5;

	const [route] = await database
		.insert(schema.stageRoutes)
		.values({
			key: `route-${crypto.randomUUID().slice(0, 8)}`,
			version: 1,
			name: 'Тестовый маршрут',
			publishedAt: new Date()
		})
		.returning({ id: schema.stageRoutes.id });

	const [stage] = await database
		.insert(schema.stages)
		.values({
			routeId: route.id,
			position: 1,
			key: 'contact',
			name: 'Первый контакт',
			category: 'contact',
			slaDays
		})
		.returning({ id: schema.stages.id });

	const [interaction] = await database
		.insert(schema.interactions)
		.values({
			title: 'Тестовое взаимодействие',
			routeId: route.id,
			ownerUserId: options.ownerUserId
		})
		.returning({ id: schema.interactions.id });

	return {
		interactionId: interaction.id,
		stageId: stage.id,
		snapshot: {
			key: 'contact',
			name: 'Первый контакт',
			position: 1,
			category: 'contact',
			slaDays,
			staleAfterDays: null,
			requiresResult: false,
			requiresConfirmation: false,
			checklist: []
		}
	};
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Смещение в днях от заданной точки. Точка задаётся один раз на тест: два
 * вызова `Date.now()` расходятся на миллисекунды, а проверки сроков сравнивают
 * моменты времени точно.
 */
export function daysFrom(base: Date, days: number): Date {
	return new Date(base.getTime() + days * DAY_MS);
}
