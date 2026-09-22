/**
 * Службы интеграционных тестов: один набор на весь прогон.
 *
 * PostgreSQL 17, Redis 8 и MinIO поднимаются здесь — раз на `vitest run`, а не
 * на каждый файл тестов. Подъём и остановка тройки стоят около пяти секунд, и
 * помноженные на четыре десятка файлов они и составляли большую часть прогона,
 * не проверяя при этом ничего.
 *
 * Изоляция от этого не потерялась, а переехала: файл получает не свой
 * контейнер, а свою базу, снятую с образца `lct_template`, свой бакет и свою
 * логическую базу Redis (`helpers/db.ts`). Своя база на файл даже строже
 * прежнего — `reset()` возвращает к началу состояние, но не схему, а проверки
 * документов посреди работы вешают на таблицу собственное ограничение.
 *
 * Миграции применяются один раз, в образец: `CREATE DATABASE … TEMPLATE` копирует
 * готовую базу за сотню миллисекунд, тогда как прогон миграций занимает секунду.
 * К образцу после этого никто не подключён — иначе PostgreSQL снимать с него
 * копию отказывается.
 *
 * Прогон по-прежнему ничего не делит с соседним: контейнеры свои у каждого
 * `vitest run`, порты им раздаёт Docker, а с концом прогона они уходят вместе с
 * базами, бакетами и всем, что в них насчитали.
 */
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer } from '@testcontainers/redis';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import type { TestProject } from 'vitest/node';
import { databaseUri } from './helpers/stack';
import { startStorageServer } from './helpers/storage';

// `fileURLToPath`, а не `.pathname`: на Windows последний отдаёт
// `/C:/…/drizzle` — с ведущей косой, — и миграции по такому пути не находятся.
const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));

const TEMPLATE_DATABASE = 'lct_template';

export async function setup(project: TestProject): Promise<() => Promise<void>> {
	// Параллельно: Redis и MinIO поднимаются заметно быстрее PostgreSQL и на
	// общем времени прогона не сказываются.
	const [postgresContainer, redisContainer, storage] = await Promise.all([
		new PostgreSqlContainer('postgres:17-alpine').start(),
		new RedisContainer('redis:8-alpine').start(),
		startStorageServer()
	]);

	const stop = async (): Promise<void> => {
		await Promise.allSettled([postgresContainer.stop(), redisContainer.stop(), storage.stop()]);
	};

	try {
		const postgresUri = postgresContainer.getConnectionUri();
		const admin = postgres(postgresUri, { max: 1 });

		try {
			await admin.unsafe(`create database "${TEMPLATE_DATABASE}"`);
		} finally {
			await admin.end();
		}

		// Соединение с образцом закрывается здесь же: пока оно открыто, снять с
		// образца копию PostgreSQL не даст, и первый же файл тестов встал бы.
		const template = postgres(databaseUri(postgresUri, TEMPLATE_DATABASE), { max: 1 });

		try {
			await migrate(drizzle(template), { migrationsFolder });
		} finally {
			await template.end();
		}

		project.provide('integrationStack', {
			postgresUri,
			templateDatabase: TEMPLATE_DATABASE,
			redisUrl: redisContainer.getConnectionUrl(),
			storage: storage.server
		});
	} catch (error) {
		// Службы к этому моменту уже подняты, а `teardown` Vitest после отказа
		// сетапа не зовёт: без этой уборки они дожили бы до конца прогона.
		await stop();
		throw error;
	}

	return stop;
}
