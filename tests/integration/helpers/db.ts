/**
 * Настоящее окружение для интеграционных тестов.
 *
 * PostgreSQL 17, Redis 8 и MinIO поднимает глобальный сетап — один набор на
 * прогон (`../global-setup.ts`). Файл тестов берёт у них своё: базу, снятую с
 * образца, в котором миграции из `drizzle/` уже применены, свою логическую базу
 * Redis и свой бакет. Проверять схему на заглушке бессмысленно: триггеры,
 * частичные индексы, CHECK и представление — это и есть то, что проверяется; то
 * же и с Redis: счётчики попыток, лимиты и сессии живут в нём, и подделка
 * проверяла бы подделку. Хранилище файлов — `helpers/storage.ts`.
 *
 * Своё состояние на файл, а не общие службы из `docker-compose.yml`: прогон не
 * должен ни зависеть от того, что насчитал предыдущий, ни мешать соседнему.
 * Контейнер на файл покупал это же свойство впятеро дороже, чем нужно. Из
 * compose остаётся только Gotenberg (`GOTENBERG_URL`) — он тяжёлый, и поднимать
 * его прогоном ради тестов документов дороже, чем держать один на машину.
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
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { Redis } from 'ioredis';
import postgres from 'postgres';
import { inject } from 'vitest';
import type { StageSnapshot } from '$lib/contracts/interactions';
import type { AccessScope, ActorContext } from '$lib/server/actor';
import * as schema from '$lib/server/db/schema';
import { contactColumns } from '$lib/server/people/pii';
import { DEFAULT_ROLES, type PermissionKey } from '$lib/server/rbac/permissions';
import { defaultRolePermissions, seedRolesAndPermissions } from '$lib/server/rbac/seed';
import { databaseUri, redisUri, type IntegrationStack } from './stack';
import { startTestStorage, type TestStorage } from './storage';

/** Таблицы, строки которых приезжают с миграцией, а не с сидом или тестом. */
const REFERENCE_TABLES = ['workspaces', 'process_group_counterparty_kinds'] as const;

export type TestDatabase = {
	/** Тот же самый handle, что получают сервисы через `getDb()`. */
	db: PostgresJsDatabase<typeof schema>;
	/** Отдельное соединение для сырого SQL: DDL, проверки ограничений. */
	raw: postgres.Sql;
	/** Хранилище файлов этого файла тестов — взгляд на него со стороны. */
	storage: TestStorage;
	/**
	 * Возвращает окружение к началу: чистит таблицы, заново заливает каталог
	 * прав и стирает логическую базу Redis.
	 *
	 * Redis сюда входит наравне с базой. Счётчики лимитов и пачек живут окно в
	 * целую минуту и очистку таблиц переживают: без этой строки тест видел бы
	 * то, что насчитал предыдущий, и порядок тестов в файле стал бы значимым.
	 */
	reset: () => Promise<void>;
	/** Убирает за файлом: сносит его базу и бакет. Службы прогона не трогает. */
	stop: () => Promise<void>;
};

/** Соединения, открытые по ходу подготовки: их закрывает уборка после отказа. */
type OpenedConnections = { raw?: postgres.Sql; redis?: Redis };

/**
 * Служебное подключение к PostgreSQL: им заводят и сносят базы файлов.
 *
 * Открывается на один запрос и тут же закрывается. Держать его открытым всё
 * время файла незачем, а снести базу, пока к серверу висит лишнее соединение
 * этого же процесса, мешает ровно в тот момент, когда уборке уже некогда.
 */
async function withAdmin<TResult>(
	stack: IntegrationStack,
	work: (sql: postgres.Sql) => Promise<TResult>
): Promise<TResult> {
	const admin = postgres(stack.postgresUri, { max: 1 });

	try {
		return await work(admin);
	} finally {
		await admin.end();
	}
}

export async function startTestDatabase(options?: {
	/**
	 * Своё хранилище файлов на этот файл тестов вместо общего.
	 *
	 * Нужно там, где проверка гасит хранилище посреди прогона: общее унесло бы
	 * вместе с ним и соседние файлы. Цена — контейнер MinIO на такой файл.
	 */
	isolatedStorage?: boolean;
}): Promise<TestDatabase> {
	const stack = inject('integrationStack');

	// Своя база на файл тестов, снятая с образца: миграции в нём применены один
	// раз на прогон, и копия достаётся за сотню миллисекунд вместо секунды.
	const databaseName = `lct_test_${crypto.randomUUID().replaceAll('-', '')}`;
	await withAdmin(stack, (admin) =>
		admin.unsafe(`create database "${databaseName}" template "${stack.templateDatabase}"`)
	);

	const storage = await startTestStorage(
		options?.isolatedStorage === true ? undefined : { server: stack.storage }
	).catch(async (error: unknown) => {
		await dropTestDatabase(stack, databaseName);
		throw error;
	});

	// Всё, что дальше, может отказать — справочные строки, сид, — а база и бакет
	// к этому моменту уже заведены. Без этой уборки отказ уносил бы ссылку на них
	// вместе со стеком: `stop()` вызвать стало бы некому, тест получил бы
	// `undefined`, а его `afterAll` с `database?.stop()` промолчал бы — и база с
	// бакетом дожили бы до конца всего прогона, по паре на файл.
	const opened: OpenedConnections = {};

	try {
		return await prepareTestDatabase(stack, databaseName, storage, opened);
	} catch (error) {
		opened.redis?.disconnect();
		await opened.raw?.end({ timeout: 5 }).catch(() => undefined);
		await storage.stop().catch(() => undefined);
		await dropTestDatabase(stack, databaseName);
		throw error;
	}
}

/**
 * Сносит базу файла тестов. `force` отцепляет то, что осталось подключённым:
 * упавший тест мог не дойти до закрытия, а без этого `DROP DATABASE` откажет и
 * уборка упала бы вслед за проверкой, спрятав её причину.
 */
async function dropTestDatabase(stack: IntegrationStack, name: string): Promise<void> {
	await withAdmin(stack, (admin) =>
		admin.unsafe(`drop database if exists "${name}" with (force)`)
	).catch(() => undefined);
}

async function prepareTestDatabase(
	stack: IntegrationStack,
	databaseName: string,
	storage: TestStorage,
	opened: OpenedConnections
): Promise<TestDatabase> {
	const uri = databaseUri(stack.postgresUri, databaseName);

	// Конфигурация читается из окружения целиком, поэтому заполняем её целиком:
	// иначе `getConfig()` справедливо упадёт на первой же недостающей переменной.
	const redisUrl = redisUri(stack.redisUrl);

	process.env.NODE_ENV = 'test';
	process.env.DATABASE_URL = uri;
	process.env.REDIS_URL = redisUrl;
	process.env.GOTENBERG_URL = 'http://localhost:3001';
	process.env.ORIGIN = 'http://localhost:5173';
	process.env.DEMO_MODE = 'false';
	process.env.TRUST_PROXY = 'false';
	// Ключ шифрования контактов людей: свой на прогон, потому что и база своя.
	// Без него сервисы справочника не прочитали бы ни одного контакта.
	process.env.PII_ENCRYPTION_KEY = 'KfAA/EWod3wd+ai6b1LHC62LWho5pPp1ajJnQNdbqUs=';
	// Каталог учётных записей: сервисам он не нужен вовсе — вход проверяется
	// своим файлом, — но конфигурация читается целиком, и без этих значений
	// `getConfig()` справедливо упадёт на первой же выборке из базы.
	process.env.OIDC_ISSUER_URL = 'http://localhost:58080/realms/lct';
	process.env.OIDC_PUBLIC_URL = 'http://localhost:58080';
	process.env.OIDC_CLIENT_ID = 'lct-crm';
	process.env.OIDC_CLIENT_SECRET = 'lct-crm-dev-secret';

	// Адрес и ключи хранилища знает только `helpers/storage.ts`: контейнеру
	// достался случайный порт, а имя бакета он придумывает сам.
	for (const [name, value] of Object.entries(storage.env)) {
		process.env[name] = value;
	}

	const raw = postgres(uri, { max: 1 });
	opened.raw = raw;

	// Справочные строки продукта, которые кладёт миграция: группы процесса и
	// соответствие «вид контрагента → группа». В базу они приехали с образца.
	// TRUNCATE в `reset()` уносит их вместе со всем остальным, а повторно
	// применить миграцию нельзя — поэтому файл снимает их один раз и возвращает
	// после каждой чистки. Снимок, а не копия значений: копия разошлась бы с
	// миграцией на первой же правке.
	const reference = new Map<string, Record<string, unknown>[]>();
	for (const table of REFERENCE_TABLES) {
		reference.set(table, await raw.unsafe(`select * from "${table}"`));
	}

	// Своё соединение, а не общее `getRedis()`: тестам его отдавать незачем, а
	// закрывают они своё сами — и закрытое общее не годилось бы для уборки.
	const redis = new Redis(redisUrl);
	opened.redis = redis;

	// Динамический импорт: к этому моменту окружение уже выставлено, поэтому
	// первый же `getConfig()` внутри увидит адрес контейнера.
	const { closeDatabase, getDb } = await import('$lib/server/db');
	const { closeStorage } = await import('$lib/server/documents/storage');
	const db = getDb();

	const reset = async (): Promise<void> => {
		// `flushdb`, а не `flushall`: Redis у прогона общий, и логическая база
		// соседнего рабочего процесса — не то, что этому файлу можно чистить.
		await redis.flushdb();

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

		// Порядок тот же, что в списке: соответствие видов ссылается на группы.
		for (const table of REFERENCE_TABLES) {
			const rows = reference.get(table) ?? [];

			if (rows.length > 0) {
				await raw`insert into ${raw(table)} ${raw(rows)}`;
			}
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
					roleId: role.id
				}))
			);
		});
	};

	await reset();

	return {
		db,
		raw,
		storage,
		reset,
		stop: async () => {
			await closeDatabase();
			closeStorage();
			await raw.end();
			await redis.quit();
			await storage.stop();
			await dropTestDatabase(stack, databaseName);
		}
	};
}

/** Пользователь на каждую системную роль; создаётся в `reset()`. */
export const TEST_USER_IDS: Record<string, string> = {
	admin: '00000000-0000-4000-8000-0000000000a1',
	manager: '00000000-0000-4000-8000-0000000000a2',
	lead: '00000000-0000-4000-8000-0000000000a3',
	service: '00000000-0000-4000-8000-0000000000a4'
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
	/**
	 * Область доступа: чьи записи видны. `undefined` — полный доступ.
	 *
	 * Область считается по людям, а не по организациям: какие вузы видит
	 * человек, решают действующие назначения в базе. Поэтому актёр с сужённой
	 * областью обычно заводится через `scopedActor`, который эти назначения и
	 * расставляет.
	 */
	scopeUserIds?: readonly string[];
}): ActorContext {
	const roleId = options?.roleId ?? 'admin';
	const permissions =
		options?.permissions !== undefined
			? new Set<string>(options.permissions)
			: defaultRolePermissions(roleId);

	const scope: AccessScope =
		options?.scopeUserIds === undefined
			? { kind: 'all' }
			: { kind: 'delegated', userIds: new Set(options.scopeUserIds) };

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
			scope
		},
		apiKeyId: null,
		ip: '198.51.100.7',
		userAgent: 'vitest',
		scope
	};
}

/**
 * Действующее лицо, которое видит ровно перечисленные вузы.
 *
 * Область доступа считается подзапросом по действующим назначениям, поэтому
 * «видит эти вузы» — это не свойство контекста, а строки в
 * `organization_responsibles`. Помощник их и расставляет: иначе каждый тест
 * области начинался бы с четырёх строк подготовки, а расходились бы они на
 * первой же правке правил.
 */
export async function scopedActor(
	database: PostgresJsDatabase<typeof schema>,
	options: {
		roleId?: string;
		userId?: string;
		permissions?: readonly PermissionKey[];
		organizationIds: readonly string[];
	}
): Promise<ActorContext> {
	const roleId = options.roleId ?? 'manager';
	const userId =
		options.userId ??
		(await insertUser(database, { roleId, email: `scoped-${crypto.randomUUID()}@example.org` }));

	if (options.organizationIds.length > 0) {
		// Организация, заведённая сервисом, уже несёт назначение на своего автора:
		// иначе он завёл бы карточку и тут же потерял её из виду. Действующее
		// назначение на пару «вуз × направление» одно, поэтому прежнее сначала
		// закрывается — ровно как это делает переназначение.
		await database
			.update(schema.organizationResponsibles)
			.set({ validTo: sql`now()` })
			.where(
				and(
					inArray(schema.organizationResponsibles.organizationId, [...options.organizationIds]),
					isNull(schema.organizationResponsibles.validTo)
				)
			);

		await database.insert(schema.organizationResponsibles).values(
			options.organizationIds.map((organizationId) => ({
				organizationId,
				userId
			}))
		);
	}

	return testActor({
		roleId,
		userId,
		permissions: options.permissions,
		scopeUserIds: [userId]
	});
}

/** Пользователь в базе: нужен всюду, где стоит внешний ключ на автора действия. */
export async function insertUser(
	database: PostgresJsDatabase<typeof schema>,
	options: { id?: string; email?: string; roleId?: string; fullName?: string } = {}
): Promise<string> {
	const [row] = await database
		.insert(schema.users)
		.values({
			id: options.id,
			email: options.email ?? `user-${crypto.randomUUID()}@example.org`,
			// ФИО задаётся там, где по нему ищут: импорт каталога находит сотрудника
			// по колонке менеджера, и однофамильцы для него — отдельный случай.
			fullName: options.fullName ?? 'Тестовый Пользователь',
			roleId: options.roleId ?? 'admin'
		})
		.returning({ id: schema.users.id });

	return row.id;
}

/** Организация-вуз: самый частый участник взаимодействия. */
export async function insertOrganization(
	database: PostgresJsDatabase<typeof schema>,
	options: {
		shortName?: string;
		inn?: string | null;
		/** Вид контрагента: от него зависит группа процесса взаимодействия. */
		kind?: 'educational_institution' | 'legal_entity' | 'customer_company' | 'operator';
	} = {}
): Promise<string> {
	const kind = options.kind ?? 'educational_institution';

	const [row] = await database
		.insert(schema.organizations)
		.values({
			kind,
			// Уровень образования есть только у учебного заведения: у остальных
			// видов его запрещает проверка схемы.
			educationLevel: kind === 'educational_institution' ? 'vo' : null,
			legalName: options.shortName ?? 'Федеральное государственное учреждение',
			shortName: options.shortName ?? `Вуз ${crypto.randomUUID().slice(0, 8)}`,
			inn: options.inn ?? null
		})
		.returning({ id: schema.organizations.id });

	return row.id;
}

/**
 * Человек справочника: контакты заполнены, потому что их и проверяют.
 *
 * Контакты кладутся тем же слоем, что и у формы (`people/pii.ts`): в базе они
 * лежат шифртекстом, и помощник, который пишет их открытыми, готовил бы к
 * проверке строку, какой в продукте не бывает.
 */
export async function insertPerson(
	database: PostgresJsDatabase<typeof schema>,
	options: {
		lastName?: string;
		email?: string | null;
		phone?: string | null;
		retentionUntil?: string | null;
	} = {}
): Promise<string> {
	const [row] = await database
		.insert(schema.people)
		.values({
			lastName: options.lastName ?? 'Тестов',
			firstName: 'Тест',
			...contactColumns({
				email: options.email === undefined ? 'test@example.org' : options.email,
				phone: options.phone === undefined ? '+7 900 000-00-00' : options.phone
			}),
			retentionUntil: options.retentionUntil ?? null
		})
		.returning({ id: schema.people.id });

	return row.id;
}

/**
 * Строка документа без файла на диске: тесты схемы и цепочки редакций
 * проверяют ограничения базы, а не хранилище. Всё, что идёт через хранилище
 * (загрузка, скачивание), зовёт настоящие сервисы.
 */
export async function insertDocument(
	database: PostgresJsDatabase<typeof schema>,
	options: {
		interactionId?: string | null;
		supersedesId?: string | null;
		kind?: string;
		title?: string;
		uploadedBy?: string | null;
	} = {}
): Promise<string> {
	const [row] = await database
		.insert(schema.documents)
		.values({
			interactionId: options.interactionId ?? null,
			supersedesId: options.supersedesId ?? null,
			kind: options.kind ?? 'agreement',
			title: options.title ?? 'Соглашение',
			filePath: `files/${crypto.randomUUID()}`,
			mime: 'application/pdf',
			sizeBytes: 1024,
			sha256: crypto.randomUUID().replaceAll('-', '').repeat(2),
			uploadedBy: options.uploadedBy ?? null
		})
		.returning({ id: schema.documents.id });

	return row.id;
}

/**
 * Редакция с одной стадией и взаимодействие на ней. Группа берётся своя на
 * каждый вызов: в группе действует ровно одна редакция, и два таких
 * взаимодействия в одной группе переписали бы друг другу процесс.
 */
export async function insertInteractionWithStage(
	database: PostgresJsDatabase<typeof schema>,
	options: { ownerUserId: string; slaDays?: number }
): Promise<{ interactionId: string; stageId: string; snapshot: StageSnapshot }> {
	const slaDays = options.slaDays ?? 5;
	const suffix = crypto.randomUUID().slice(0, 8);

	const [maxPosition] = await database
		.select({ value: sql<number>`coalesce(max(${schema.workspaces.position}), 0)::int` })
		.from(schema.workspaces);

	const [workspace] = await database
		.insert(schema.workspaces)
		.values({
			key: `test-${suffix}`,
			name: 'Тестовая группа процесса',
			position: maxPosition.value + 1
		})
		.returning({ id: schema.workspaces.id });

	const [revision] = await database
		.insert(schema.processRevisions)
		.values({
			groupId: workspace.id,
			version: 1,
			name: 'Тестовый процесс',
			publishedAt: new Date()
		})
		.returning({ id: schema.processRevisions.id });

	const [stage] = await database
		.insert(schema.stages)
		.values({
			revisionId: revision.id,
			position: 1,
			key: 'contact',
			name: 'Первый контакт',
			category: 'contact',
			slaDays,
			isFinal: true
		})
		.returning({ id: schema.stages.id });

	await database
		.update(schema.workspaces)
		.set({ activeRevisionId: revision.id })
		.where(eq(schema.workspaces.id, workspace.id));

	const [interaction] = await database
		.insert(schema.interactions)
		.values({
			title: 'Тестовое взаимодействие',
			workspaceId: workspace.id,
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
			requiresLmsData: false,
			requiresDocumentMark: null,
			isFinal: true,
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
