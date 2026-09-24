import { count, eq } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { interactions, organizations } from '$lib/server/db/schema';
import { getRedis } from '$lib/server/redis';
import { DIRECTORY_SEED_SIZES } from '../../../scripts/seed/directory';
import { INTERACTION_SEED_SIZES } from '../../../scripts/seed/interactions';
import { seedAll } from '../../../scripts/seed/run';
import { startTestDatabase, testActor, type TestDatabase } from '../helpers/db';

// См. комментарий в `helpers/db.ts`: без этого сервисы пойдут в базу разработчика.
vi.mock('$env/dynamic/private', () => ({ env: process.env }));

/**
 * `DEMO_MODE` разбирается один раз за процесс, поэтому подменяется сама
 * функция конфигурации, а не переменная окружения.
 */
vi.mock('$lib/server/config', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/server/config')>();

	return { ...actual, getConfig: () => ({ ...actual.getConfig(), DEMO_MODE: true }) };
});

const { resetDemoData } = await import('$lib/server/demo/reset');

let database: TestDatabase;

async function countRows(table: PgTable): Promise<number> {
	const [row] = await database.db.select({ value: count() }).from(table);

	return row.value;
}

beforeAll(async () => {
	database = await startTestDatabase();
	await database.reset();
	await seedAll();
}, 300_000);

afterAll(async () => {
	await getRedis().quit();
	await database?.stop();
});

describe('сброс демонстрационных данных', () => {
	it('стирает след показа и возвращает стенд к эталону сида', async () => {
		await database.db
			.update(organizations)
			.set({ shortName: 'Переименовано на показе' })
			.where(eq(organizations.kind, 'educational_institution'));
		await database.db.delete(interactions);

		const result = await resetDemoData(testActor());

		expect(result.interactionCount).toBe(INTERACTION_SEED_SIZES.interactions);
		expect(result.organizationCount).toBe(DIRECTORY_SEED_SIZES.organizations);
		await expect(countRows(interactions)).resolves.toBe(INTERACTION_SEED_SIZES.interactions);

		const [renamed] = await database.db
			.select({ value: count() })
			.from(organizations)
			.where(eq(organizations.shortName, 'Переименовано на показе'));

		expect(renamed.value).toBe(0);
	}, 120_000);
});
