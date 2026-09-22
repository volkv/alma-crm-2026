/**
 * Службы, поднятые на весь прогон интеграционных тестов.
 *
 * PostgreSQL, Redis и MinIO поднимает `tests/integration/global-setup.ts` —
 * один раз на `vitest run`, а не на файл тестов. Файл берёт у них своё: базу,
 * снятую с образца, логическую базу Redis и свой бакет. Изоляция от этого не
 * слабеет — она перешла с уровня процесса контейнера на уровень состояния, —
 * а пять секунд на подъём и остановку тройки перестали умножаться на число
 * файлов.
 *
 * Здесь же объявлено, чем эти службы доходят до тестов: `provide`/`inject`
 * Vitest. Окружение процесса для этого не годится — рабочие процессы получают
 * его слепком при запуске, и адрес, выставленный в глобальном сетапе, до них
 * дошёл бы случайно.
 */
import type { StorageServer } from './storage';

/** Что глобальный сетап передаёт файлам тестов. */
export type IntegrationStack = {
	/**
	 * Адрес служебной базы PostgreSQL. Из неё файл заводит свою базу и в неё же
	 * возвращается, чтобы её снести: подключение к сносимой базе этого не даёт.
	 */
	postgresUri: string;
	/** База-образец: миграции в ней уже применены, строки — только справочные. */
	templateDatabase: string;
	/** Адрес Redis без логической базы: её выбирает файл тестов. */
	redisUrl: string;
	storage: StorageServer;
};

declare module 'vitest' {
	interface ProvidedContext {
		integrationStack: IntegrationStack;
	}
}

/** Логических баз у Redis по умолчанию шестнадцать. */
const REDIS_DATABASES = 16;

/** Тот же адрес, но другая база: так заводится и база файла, и база-образец. */
export function databaseUri(base: string, name: string): string {
	const url = new URL(base);
	url.pathname = `/${name}`;

	return url.toString();
}

/**
 * Адрес Redis с логической базой рабочего процесса.
 *
 * Номер берётся у Vitest (`VITEST_POOL_ID`, от единицы до числа процессов), а
 * не у файла: файлов больше, чем логических баз, а процессов — нет. Пока файлы
 * идут по одному, номер всегда один и тот же; когда пойдут разом, соседние
 * счётчики лимитов не встретятся.
 */
export function redisUri(base: string): string {
	const pool = Number(process.env.VITEST_POOL_ID ?? '1');
	const url = new URL(base);
	url.pathname = `/${(Number.isFinite(pool) ? pool : 1) % REDIS_DATABASES}`;

	return url.toString();
}
