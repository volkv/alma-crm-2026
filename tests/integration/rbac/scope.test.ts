import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import type { PartyRole } from '$lib/contracts/interactions';
import {
	interactionParties,
	interactions,
	organizationResponsibles,
	organizations
} from '$lib/server/db/schema';
import { interactionScopeFilter } from '$lib/server/interactions/access';
import { scopeFilter } from '$lib/server/rbac';
import {
	insertInteractionWithStage,
	insertOrganization,
	insertUser,
	startTestDatabase,
	testActor,
	type TestDatabase
} from '../helpers/db';

// См. комментарий в `helpers/db.ts`: без этого сервисы пойдут в базу разработчика.
vi.mock('$env/dynamic/private', () => ({ env: process.env }));

/**
 * Условие видимости — то самое место, где написано, кто что видит. Здесь оно
 * проверяется в лоб, отдельным запросом: остальные тесты области смотрят на него
 * через списки и карточки, и там расхождение выглядит как «пропал раздел», а не
 * как «условие собрано неверно».
 *
 * Утверждения, ради которых тест существует (`docs/access-matrix.md`, раздел 1):
 * видимость считается по **основной** стороне, назначение организации-оператора
 * не открывает чужих записей, а владелец видит свою запись и после того, как вуз
 * у него забрали.
 */
let database: TestDatabase;

beforeAll(async () => {
	database = await startTestDatabase();
}, 300_000);

afterAll(async () => {
	await database.stop();
});

beforeEach(async () => {
	await database.reset();
});

/** Сколько взаимодействий видит вызывающий по общему условию видимости. */
async function visibleInteractionIds(userIds: readonly string[]): Promise<string[]> {
	const ctx = testActor({ roleId: 'manager', scopeUserIds: userIds });

	const rows = await database.db
		.select({ id: interactions.id })
		.from(interactions)
		.where(interactionScopeFilter(ctx));

	return rows.map((row) => row.id).sort();
}

/** Сколько организаций видит вызывающий по условию области. */
async function visibleOrganizationIds(userIds: readonly string[]): Promise<string[]> {
	const ctx = testActor({ roleId: 'manager', scopeUserIds: userIds });

	const rows = await database.db
		.select({ id: organizations.id })
		.from(organizations)
		.where(scopeFilter(ctx, organizations.id));

	return rows.map((row) => row.id).sort();
}

async function addParty(
	interactionId: string,
	organizationId: string,
	options: { isPrimary: boolean; partyRole?: PartyRole }
): Promise<void> {
	await database.db.insert(interactionParties).values({
		interactionId,
		organizationId,
		partyRole: options.partyRole ?? (options.isPrimary ? 'educational_institution' : 'customer'),
		isPrimary: options.isPrimary
	});
}

describe('область по назначениям', () => {
	it('открывает только те вузы, на которые есть действующее назначение', async () => {
		const mine = await insertOrganization(database.db, { shortName: 'Мой вуз' });
		const foreign = await insertOrganization(database.db, { shortName: 'Чужой вуз' });
		const me = await insertUser(database.db, { roleId: 'manager' });

		await database.db.insert(organizationResponsibles).values({ organizationId: mine, userId: me });

		expect(await visibleOrganizationIds([me])).toEqual([mine]);
		expect(foreign).not.toBe(mine);
	});

	it('закрывает вуз в ту же секунду, когда назначение закрыли', async () => {
		const organizationId = await insertOrganization(database.db, { shortName: 'Вуз' });
		const me = await insertUser(database.db, { roleId: 'manager' });

		const [row] = await database.db
			.insert(organizationResponsibles)
			.values({ organizationId, userId: me })
			.returning({ id: organizationResponsibles.id });

		expect(await visibleOrganizationIds([me])).toEqual([organizationId]);

		await database.db
			.update(organizationResponsibles)
			.set({ validTo: sql`now()` })
			.where(eq(organizationResponsibles.id, row.id));

		// Область читается подзапросом в момент выборки, а не списком, собранным
		// при входе: иначе до следующего входа человек видел бы чужое.
		expect(await visibleOrganizationIds([me])).toEqual([]);
	});

	it('пустая область не видит ничего', async () => {
		await insertOrganization(database.db, { shortName: 'Вуз' });

		expect(await visibleOrganizationIds([])).toEqual([]);
	});
});

describe('видимость взаимодействия', () => {
	it('считается по основной стороне и не считается по плательщику', async () => {
		const institution = await insertOrganization(database.db, { shortName: 'Вуз' });
		const payer = await insertOrganization(database.db, {
			shortName: 'Плательщик',
			kind: 'customer_company'
		});
		const owner = await insertUser(database.db, { roleId: 'manager' });
		const me = await insertUser(database.db, { roleId: 'manager' });

		const { interactionId } = await insertInteractionWithStage(database.db, {
			ownerUserId: owner
		});
		await addParty(interactionId, institution, { isPrimary: true });
		await addParty(interactionId, payer, { isPrimary: false });

		// Назначение на вуз — запись видна.
		await database.db
			.insert(organizationResponsibles)
			.values({ organizationId: institution, userId: me });

		expect(await visibleInteractionIds([me])).toEqual([interactionId]);

		// Назначение только на плательщика — не видна: иначе достаточно было бы
		// получить одного плательщика, чтобы увидеть чужую работу.
		const payerManager = await insertUser(database.db, { roleId: 'manager' });
		await database.db
			.insert(organizationResponsibles)
			.values({ organizationId: payer, userId: payerManager });

		expect(await visibleInteractionIds([payerManager])).toEqual([]);
	});

	it('назначение организации-оператора не открывает чужих взаимодействий', async () => {
		const institution = await insertOrganization(database.db, { shortName: 'Вуз' });
		const operator = await insertOrganization(database.db, {
			shortName: 'Оператор',
			kind: 'operator'
		});
		const owner = await insertUser(database.db, { roleId: 'manager' });
		const outsider = await insertUser(database.db, { roleId: 'manager' });

		const { interactionId } = await insertInteractionWithStage(database.db, {
			ownerUserId: owner
		});
		await addParty(interactionId, institution, { isPrimary: true });
		await addParty(interactionId, operator, { isPrimary: false, partyRole: 'operator' });

		await database.db
			.insert(organizationResponsibles)
			.values({ organizationId: operator, userId: outsider });

		// Оператор стоит стороной почти везде: считай видимость по любой стороне —
		// и одно назначение отдало бы все взаимодействия продукта разом.
		expect(await visibleInteractionIds([outsider])).toEqual([]);
	});

	it('оставляет запись владельцу после того, как вуз у него забрали', async () => {
		const institution = await insertOrganization(database.db, { shortName: 'Вуз' });
		const owner = await insertUser(database.db, { roleId: 'manager' });

		const { interactionId } = await insertInteractionWithStage(database.db, {
			ownerUserId: owner
		});
		await addParty(interactionId, institution, { isPrimary: true });

		const [assignment] = await database.db
			.insert(organizationResponsibles)
			.values({ organizationId: institution, userId: owner })
			.returning({ id: organizationResponsibles.id });

		expect(await visibleInteractionIds([owner])).toEqual([interactionId]);

		await database.db
			.update(organizationResponsibles)
			.set({ validTo: sql`now()` })
			.where(eq(organizationResponsibles.id, assignment.id));

		// Вуз ушёл другому, а незавершённая работа осталась: обрывать её на
		// полуслове смена ответственного не должна.
		expect(await visibleInteractionIds([owner])).toEqual([interactionId]);
		expect(await visibleOrganizationIds([owner])).toEqual([]);
	});

	it('не показывает запись тому, кто ни владелец, ни ответственный', async () => {
		const institution = await insertOrganization(database.db, { shortName: 'Вуз' });
		const owner = await insertUser(database.db, { roleId: 'manager' });
		const stranger = await insertUser(database.db, { roleId: 'manager' });

		const { interactionId } = await insertInteractionWithStage(database.db, {
			ownerUserId: owner
		});
		await addParty(interactionId, institution, { isPrimary: true });

		expect(await visibleInteractionIds([stranger])).toEqual([]);

		// А тот, кто ведёт запись, видит её и без назначения на вуз.
		expect(await visibleInteractionIds([owner])).toEqual([interactionId]);
	});

	it('полный доступ видит и запись, у которой сторон ещё нет', async () => {
		const owner = await insertUser(database.db, { roleId: 'manager' });
		const { interactionId } = await insertInteractionWithStage(database.db, {
			ownerUserId: owner
		});

		const rows = await database.db
			.select({ id: interactions.id })
			.from(interactions)
			.where(and(interactionScopeFilter(testActor()), eq(interactions.id, interactionId)));

		expect(rows).toHaveLength(1);
	});
});
