import { randomUUID } from 'node:crypto';
import { count, eq, isNull } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { isValidInn } from '$lib/validation/inn';
import type { ActorContext } from '$lib/server/actor';
import { login } from '$lib/server/auth/login';
import { clearLoginFailures } from '$lib/server/auth/lockout';
import { destroySession } from '$lib/server/auth/session';
import {
	affiliations,
	blockers,
	comments,
	documents,
	interactionChanges,
	interactions,
	organizations,
	people,
	products,
	programs,
	programVersions,
	sites,
	stageEntries,
	stageEntryStatus,
	users
} from '$lib/server/db/schema';
import { DEMO_ROUTE } from '$lib/server/stages/demo-route';
import { DIRECTORY_SEED_SIZES } from '../../../scripts/seed/directory';
import { INTERACTION_SEED_SIZES } from '../../../scripts/seed/interactions';
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

/** Сессии, открытые проверкой входа: их гасит `afterEach`. */
let sessions: string[] = [];

async function runSeed(): Promise<void> {
	await seedAll({ demoPassword: DEMO_PASSWORD });
}

/** Записи стадий, на которых взаимодействия стоят прямо сейчас. */
async function openEntries(): Promise<
	{ interactionId: string; isOverdue: boolean; isPaused: boolean }[]
> {
	return database.db
		.select({
			interactionId: stageEntries.interactionId,
			isOverdue: stageEntryStatus.isOverdue,
			isPaused: stageEntryStatus.isPaused
		})
		.from(stageEntries)
		.innerJoin(stageEntryStatus, eq(stageEntryStatus.stageEntryId, stageEntries.id))
		.where(isNull(stageEntries.leftAt));
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
	// убирает за собой ровно свои ключи. Гасить все сессии демонстрационных
	// записей нельзя: идентификаторы у них вычисляемые, а значит те же, что и
	// у стенда и у прогона e2e, — этот тест выбил бы их из системы.
	for (const email of Object.values(DEMO_EMAILS)) {
		await clearLoginFailures(email, ADDRESS);
	}

	for (const sessionId of sessions) {
		await destroySession(sessionId);
	}

	sessions = [];
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

	it('заводит взаимодействия на стадиях маршрута', async () => {
		await runSeed();

		await expect(countRows(interactions)).resolves.toBe(INTERACTION_SEED_SIZES.interactions);

		const open = await openEntries();
		const active = INTERACTION_SEED_SIZES.interactions - INTERACTION_SEED_SIZES.completed;

		// Открытая запись ровно одна у каждого незакрытого взаимодействия, и ни
		// одной у завершённых: закрытие выводит взаимодействие с маршрута.
		expect(open).toHaveLength(active);
		expect(new Set(open.map((entry) => entry.interactionId)).size).toBe(active);
		expect(open.filter((entry) => entry.isOverdue)).toHaveLength(INTERACTION_SEED_SIZES.overdue);
		expect(open.filter((entry) => entry.isPaused)).toHaveLength(INTERACTION_SEED_SIZES.paused);

		const completed = await database.db
			.select({ id: interactions.id })
			.from(interactions)
			.where(eq(interactions.status, 'completed'));

		expect(completed).toHaveLength(INTERACTION_SEED_SIZES.completed);

		await expect(countRows(comments)).resolves.toBe(INTERACTION_SEED_SIZES.comments);
		await expect(countRows(blockers)).resolves.toBe(INTERACTION_SEED_SIZES.blockers);
		// Смена ответственного попадает в историю плана: вкладка «Правки плана»
		// на стенде не должна быть пустой у всех до единого.
		await expect(countRows(interactionChanges)).resolves.toBe(INTERACTION_SEED_SIZES.handovers);
		// Каждое соглашение собирается сразу в двух форматах: DOCX и PDF.
		await expect(countRows(documents)).resolves.toBe(INTERACTION_SEED_SIZES.documents * 2);

		// Завершённое взаимодействие прошло маршрут целиком: по записи на каждую
		// стадию, и все они закрыты.
		const completedEntries = await database.db
			.select({ leftAt: stageEntries.leftAt })
			.from(stageEntries)
			.innerJoin(interactions, eq(interactions.id, stageEntries.interactionId))
			.where(eq(interactions.status, 'completed'));

		expect(completedEntries).toHaveLength(
			INTERACTION_SEED_SIZES.completed * DEMO_ROUTE.stages.length
		);
		expect(completedEntries.filter((entry) => entry.leftAt === null)).toStrictEqual([]);
	});

	it('заполняет срок соглашения у каждого взаимодействия', async () => {
		await runSeed();

		// Соглашение по шаблону собирается из срока в плане: запись без него —
		// тупик ровно на том пути, которым стенд и открывают.
		const rows = await database.db
			.select({
				id: interactions.id,
				start: interactions.agreementPeriodStart,
				end: interactions.agreementPeriodEnd
			})
			.from(interactions);

		expect(rows).toHaveLength(INTERACTION_SEED_SIZES.interactions);
		expect(rows.filter((row) => row.start === null || row.end === null)).toStrictEqual([]);
	});

	it('разводит события истории по времени', async () => {
		await runSeed();

		const [commentRows, blockerRows, changeRows] = await Promise.all([
			database.db
				.select({ interactionId: comments.interactionId, at: comments.createdAt })
				.from(comments),
			database.db
				.select({ interactionId: blockers.interactionId, at: blockers.raisedAt })
				.from(blockers),
			database.db
				.select({
					interactionId: interactionChanges.interactionId,
					at: interactionChanges.changedAt
				})
				.from(interactionChanges)
		]);

		const byInteraction = new Map<string, number[]>();

		for (const row of [...commentRows, ...blockerRows, ...changeRows]) {
			byInteraction.set(row.interactionId, [
				...(byInteraction.get(row.interactionId) ?? []),
				row.at.getTime()
			]);
		}

		const crowded = [...byInteraction.values()].filter((moments) => moments.length > 1);

		// Есть на чём проверять: иначе тест зелен от того, что событий нет.
		expect(crowded.length).toBeGreaterThan(0);
		// Слипшиеся в одну отметку события читаются как сбой системы, а не как
		// ход работы: у каждого события записи свой момент.
		expect(crowded.filter((moments) => new Set(moments).size !== moments.length)).toStrictEqual([]);
	});

	it('повторный сид не пересоздаёт историю взаимодействий', async () => {
		await runSeed();

		const before = await database.db
			.select({ id: stageEntries.id })
			.from(stageEntries)
			.orderBy(stageEntries.id);

		await runSeed();

		const after = await database.db
			.select({ id: stageEntries.id })
			.from(stageEntries)
			.orderBy(stageEntries.id);

		expect(after).toStrictEqual(before);
		await expect(countRows(interactions)).resolves.toBe(INTERACTION_SEED_SIZES.interactions);
		await expect(countRows(comments)).resolves.toBe(INTERACTION_SEED_SIZES.comments);

		const open = await openEntries();

		expect(open.filter((entry) => entry.isOverdue)).toHaveLength(INTERACTION_SEED_SIZES.overdue);
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

		if (outcome.ok) {
			sessions.push(outcome.sessionId);
		}

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
