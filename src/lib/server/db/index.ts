import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { getConfig } from '../config';
import { trackDatabaseQuery } from '../hooks/server-timing';
import * as schema from './schema';

/** Открытый пул вместе с адресом, под который он открыт. */
interface Pool {
	url: string;
	client: postgres.Sql;
	database: PostgresJsDatabase<typeof schema> | undefined;
}

/**
 * Пул живёт на `globalThis`, а не в переменной модуля. В `vite dev` серверный
 * модуль выполняется заново — правка схемы, пересборка зависимостей, смена
 * ветки под запущенным сервером, — и переменная модуля начинается с чистого
 * листа: каждое выполнение открывало свой пул на `POOL_MAX` соединений, а
 * прежний никто не закрывал. Четыре перезагрузки съедали сотню соединений
 * PostgreSQL, и база отказывала всем, вплоть до `psql`. Под `globalThis` новое
 * выполнение модуля подхватывает уже открытый пул; в собранном приложении модуль
 * выполняется один раз, и разницы нет.
 *
 * Адрес хранится рядом, чтобы процесс, сменивший базу (тесты поднимают свою),
 * не получил пул к чужой.
 */
const POOL = Symbol.for('alma-crm.db.pool');

function heldPool(): Pool | undefined {
	return (globalThis as Record<symbol, Pool | undefined>)[POOL];
}

function holdPool(pool: Pool | undefined): void {
	(globalThis as Record<symbol, Pool | undefined>)[POOL] = pool;
}

/**
 * Connections in the pool.
 *
 * A transaction holds one connection from `begin` to `commit`, and while it is
 * open the code inside it still needs a second one: refusals of the audit log
 * and the personal-data view trace are written on their own connection by
 * design, so that a rollback cannot take them with it. A pool sized to the
 * number of simultaneous transactions therefore locks up for good — every
 * transaction holds a connection and waits for one nobody is left to release.
 *
 * Twenty four leaves room for a dozen simultaneous transactions together with
 * the writes that happen next to them. The ceiling on transactions is the
 * number of requests in flight and nothing else: adapter-node serves them from
 * a single process. On the other side PostgreSQL allows 100 connections by
 * default, so a pool this size still leaves room for migrations, a psql session
 * and a second instance of the app.
 */
const POOL_MAX = 24;

/**
 * Наблюдатель за завершением запроса. Возвращает тот же самый объект запроса:
 * вызывающий дальше делает с ним что хотел — дописывает `.values()`, ждёт его
 * или бросает.
 *
 * Подписка идёт через `Promise.prototype.then`, а не через `then` самого
 * запроса: у postgres.js `then` заодно ставит запрос в очередь на выполнение, и
 * наблюдатель решал бы за вызывающего, когда запрос уйдёт в базу, — а тот ещё
 * не успел сказать `.values()`.
 */
function watch<TQuery extends Promise<unknown>>(query: TQuery): TQuery {
	const finished = trackDatabaseQuery();

	if (finished !== null) {
		Promise.prototype.then.call(query, finished, finished);
	}

	return query;
}

/** Вход в область транзакции: `begin` и `savepoint` устроены одинаково. */
type ScopeEntry = (
	first: string | ((scoped: postgres.TransactionSql) => unknown),
	second?: (scoped: postgres.TransactionSql) => unknown
) => Promise<unknown>;

/**
 * Обёртка над `begin`/`savepoint`: внутрь транзакции вызывающий получает уже
 * измеряемое соединение. Без этого замер видел бы только чтения вне транзакций
 * — postgres.js заводит на транзакцию отдельный объект соединения, и запросы
 * идут через него.
 */
function watchScope(enter: ScopeEntry): ScopeEntry {
	return (first, second) => {
		const callback = typeof first === 'string' ? second : first;

		if (callback === undefined) {
			throw new TypeError('Транзакции нужен обработчик');
		}

		const measured = (scoped: postgres.TransactionSql): unknown => callback(measure(scoped));

		return typeof first === 'string' ? enter(first, measured) : enter(measured);
	};
}

/**
 * Соединение, которое докладывает о времени ожидания базы счётчику запроса
 * (`hooks/server-timing.ts`).
 *
 * Меряется ровно одна точка — `unsafe`, — и этого хватает на всё приложение:
 * Drizzle отправляет каждый свой запрос именно через неё (`select`, `insert`,
 * `execute`, курсоры выгрузки). Тегированные шаблоны postgres.js остаются вне
 * замера; в приложении такой один — проба здоровья ниже.
 *
 * Методы подменяются на самом объекте соединения, а не через `Proxy`: объект
 * postgres.js — вызываемая функция со своими свойствами, и посредник вокруг неё
 * стоил бы перехвата на каждое обращение к каждому свойству, на каждом запросе.
 */
function measure<TSql extends postgres.Sql | postgres.TransactionSql>(sql: TSql): TSql {
	const unsafe = sql.unsafe.bind(sql);

	sql.unsafe = ((...args: Parameters<typeof unsafe>) =>
		watch(unsafe(...args))) as typeof sql.unsafe;

	if ('begin' in sql) {
		sql.begin = watchScope(sql.begin.bind(sql) as ScopeEntry) as typeof sql.begin;
	}

	if ('savepoint' in sql) {
		sql.savepoint = watchScope(sql.savepoint.bind(sql) as ScopeEntry) as typeof sql.savepoint;
	}

	return sql;
}

/**
 * Параметры сеанса, с которыми открывается каждое соединение пула.
 *
 * `jit: off` — JIT-компиляция выражений PostgreSQL включается по оценке
 * стоимости плана (`jit_above_cost`), а не по его настоящей цене. Запросы
 * приложения выбирают десятки и сотни строк, но оценка у запросов с подзапросами
 * области и у запросов отчёта перешагивает порог, и тогда на компиляцию уходит
 * 20–70 мс на запрос, который без неё выполняется за 1–5 мс. Нагрузочный замер
 * 2026-09-24 (`docs/performance.md`): у отчёта это была почти вся цена ответа.
 * Выгода JIT — многосекундные аналитические запросы по миллионам строк, а их
 * у приложения нет.
 */
const SESSION = { jit: 'off' } as const;

function getPool(): Pool {
	const url = getConfig().DATABASE_URL;
	const held = heldPool();

	if (held !== undefined && held.url === url) {
		return held;
	}

	if (held !== undefined) {
		// Пул к прежнему адресу больше никому не нужен; запросы, уже ушедшие
		// в него, `end` дожидается.
		void held.client.end();
	}

	const pool: Pool = {
		url,
		client: measure(
			postgres(url, {
				max: POOL_MAX,
				// Fail a stuck connection attempt instead of hanging a request forever.
				connect_timeout: 10,
				connection: SESSION
			})
		),
		database: undefined
	};
	holdPool(pool);
	return pool;
}

function getClient(): postgres.Sql {
	return getPool().client;
}

/**
 * The Drizzle handle for the primary database.
 *
 * Built on first use, not on import: SvelteKit loads every server module while
 * it builds the app, and a connection opened there would run without a real
 * environment and outlive the build.
 */
export function getDb(): PostgresJsDatabase<typeof schema> {
	const pool = getPool();
	pool.database ??= drizzle(pool.client, { schema, casing: 'snake_case' });
	return pool.database;
}

/** Cheapest possible round-trip to the database, used by the health endpoint. */
export async function pingDatabase(): Promise<void> {
	await getClient()`select 1`;
}

/**
 * Closes the pool and forgets the handle. Needed wherever the process has to
 * end on its own — a test run, a one-off script — because open sockets keep
 * Node alive long after the work is done.
 */
export async function closeDatabase(): Promise<void> {
	const open = heldPool();
	holdPool(undefined);

	if (open !== undefined) {
		await open.client.end();
	}
}
