import { randomUUID } from 'node:crypto';
import { count, eq } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { isValidInn } from '$lib/validation/inn';
import type { ActorContext } from '$lib/server/actor';
import { login } from '$lib/server/auth/login';
import { clearLoginFailures } from '$lib/server/auth/lockout';
import { revokeAllSessions } from '$lib/server/auth/session';
import {
	affiliations,
	organizations,
	people,
	products,
	programs,
	programVersions,
	sites,
	users
} from '$lib/server/db/schema';
import { DIRECTORY_SEED_SIZES } from '../../../scripts/seed/directory';
import { seedAll } from '../../../scripts/seed/run';
import { DEMO_EMAILS } from '../../../scripts/seed/users';
import { startTestDatabase, type TestDatabase } from '../helpers/db';

// См. комментарий в `helpers/db.ts`: без этого сервисы пойдут в базу разработчика.
vi.mock('$env/dynamic/private', () => ({ env: process.env }));

let database: TestDatabase;

/** Пароль демонстрационных записей прогона; на стенде он приходит из окружения. */
const DEMO_PASSWORD = 'Проверка-Сидов-2026';

/** Адрес, с которого тест ходит на вход: счётчики блокировки живут по адресу. */
const ADDRESS = '198.51.100.31';

async function runSeed(): Promise<void> {
	await database.db.transaction(async (tx) => {
		await seedAll(tx, { demoPassword: DEMO_PASSWORD });
	});
}

async function countRows(table: PgTable): Promise<number> {
	const [row] = await database.db.select({ value: count() }).from(table);

	return row.value;
}

/** Контекст анонимного посетителя: именно он приходит на форму входа. */
function anonymous(): ActorContext {
	return {
		requestId: randomUUID(),
		source: 'ui',
		user: null,
		apiKeyId: null,
		ip: ADDRESS,
		userAgent: 'vitest',
		scope: { kind: 'organizations', organizationIds: new Set() }
	};
}

beforeAll(async () => {
	database = await startTestDatabase();
}, 300_000);

afterAll(async () => {
	await database.stop();
});

beforeEach(async () => {
	await database.reset();
});

afterEach(async () => {
	// Счётчики попыток и сессии живут в Redis, общем с разработчиком: прогон
	// убирает за собой ровно свои ключи.
	for (const email of Object.values(DEMO_EMAILS)) {
		await clearLoginFailures(email, ADDRESS);
	}

	const accounts = await database.db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.isDemo, true));

	for (const account of accounts) {
		await revokeAllSessions(account.id);
	}
});

describe('сид', () => {
	it('заполняет справочники на пустой базе', async () => {
		await runSeed();

		await expect(countRows(organizations)).resolves.toBe(DIRECTORY_SEED_SIZES.organizations);
		await expect(countRows(sites)).resolves.toBe(DIRECTORY_SEED_SIZES.sites);
		await expect(countRows(people)).resolves.toBe(DIRECTORY_SEED_SIZES.people);
		await expect(countRows(affiliations)).resolves.toBe(DIRECTORY_SEED_SIZES.affiliations);
		await expect(countRows(programs)).resolves.toBe(DIRECTORY_SEED_SIZES.programs);
		await expect(countRows(programVersions)).resolves.toBe(DIRECTORY_SEED_SIZES.programVersions);
		await expect(countRows(products)).resolves.toBe(DIRECTORY_SEED_SIZES.products);

		const demo = await database.db
			.select({ email: users.email, roleId: users.roleId })
			.from(users)
			.where(eq(users.isDemo, true))
			.orderBy(users.email);

		expect(demo.map((account) => account.email)).toStrictEqual([
			DEMO_EMAILS.admin,
			DEMO_EMAILS.manager,
			DEMO_EMAILS.viewer
		]);
		expect(demo.map((account) => account.roleId)).toStrictEqual(['admin', 'manager', 'viewer']);
	});

	it('на повторном запуске не плодит строк и не меняет идентификаторов', async () => {
		await runSeed();

		const organizationsBefore = await database.db
			.select({ id: organizations.id })
			.from(organizations)
			.orderBy(organizations.id);
		const peopleBefore = await database.db
			.select({ id: people.id })
			.from(people)
			.orderBy(people.id);

		await runSeed();

		const organizationsAfter = await database.db
			.select({ id: organizations.id })
			.from(organizations)
			.orderBy(organizations.id);
		const peopleAfter = await database.db.select({ id: people.id }).from(people).orderBy(people.id);

		expect(organizationsAfter).toStrictEqual(organizationsBefore);
		expect(peopleAfter).toStrictEqual(peopleBefore);
		await expect(countRows(affiliations)).resolves.toBe(DIRECTORY_SEED_SIZES.affiliations);
		await expect(countRows(programVersions)).resolves.toBe(DIRECTORY_SEED_SIZES.programVersions);
		await expect(countRows(users)).resolves.toBe(8);
	});

	it('не затирает правку, сделанную на стенде', async () => {
		await runSeed();

		const [target] = await database.db
			.select({ id: organizations.id })
			.from(organizations)
			.orderBy(organizations.id)
			.limit(1);

		await database.db
			.update(organizations)
			.set({ shortName: 'Переименовано руками', notes: null })
			.where(eq(organizations.id, target.id));

		await runSeed();

		const [after] = await database.db
			.select({ shortName: organizations.shortName, notes: organizations.notes })
			.from(organizations)
			.where(eq(organizations.id, target.id));

		expect(after.shortName).toBe('Переименовано руками');
		expect(after.notes).toBeNull();
	});

	it('заводит демонстрационные записи, под которыми можно войти паролем из окружения', async () => {
		await runSeed();

		const outcome = await login(anonymous(), {
			email: DEMO_EMAILS.admin,
			password: DEMO_PASSWORD
		});

		expect(outcome.ok).toBe(true);

		const refused = await login(anonymous(), {
			email: DEMO_EMAILS.viewer,
			password: `${DEMO_PASSWORD}-нет`
		});

		expect(refused.ok).toBe(false);
	});

	it('кладёт в базу только ИНН, проходящие контрольную сумму', async () => {
		await runSeed();

		const rows = await database.db.select({ inn: organizations.inn }).from(organizations);
		const filled = rows.map((row) => row.inn).filter((inn): inn is string => inn !== null);

		expect(filled).toHaveLength(DIRECTORY_SEED_SIZES.organizations);
		expect(filled.filter((inn) => !isValidInn(inn))).toStrictEqual([]);
		expect(new Set(filled).size).toBe(filled.length);
	});
});
