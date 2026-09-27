// См. комментарий в `helpers/db.ts`: без этого сервисы пойдут в базу разработчика.
import { vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({ env: process.env }));

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addDays } from '$lib/contracts/license';
import { formatIsoDay } from '$lib/format';
import { systemActor } from '$lib/server/actor';
import {
	contractItems,
	contracts,
	interactionContractItems,
	interactionProducts,
	interactions,
	notificationDeliveries,
	organizationResponsibles,
	products,
	users
} from '$lib/server/db/schema';
import { startLicenseRenewal } from '$lib/server/directory/license-renewal';
import { runNotificationCycle } from '$lib/server/notifications/watch';
import { getRedis } from '$lib/server/redis';
import { setSetting } from '$lib/server/settings';
import { B2B_PROCESS } from '$lib/server/stages/definitions';
import {
	ensureSchoolOperator,
	insertOrganization,
	insertUser,
	startTestDatabase,
	testActor,
	type TestDatabase
} from '../helpers/db';
import { B2B_WORKSPACE_KEY, seedProcess } from '../stages/fixture';

/**
 * Наблюдатель сроков лицензий и продление по позиции договора.
 *
 * Канал — заглушка: здесь проверяется, кому и сколько раз система решила
 * сказать, а доставку почтой до сервера проверяет `watch.test.ts`.
 */
let database: TestDatabase;

beforeAll(async () => {
	database = await startTestDatabase();
}, 300_000);

afterAll(async () => {
	await getRedis().quit();
	await database?.stop();
});

beforeEach(async () => {
	await database.reset();
	// Продление заводит дело, а стороной каждого дела стоит школа-оператор.
	await ensureSchoolOperator(database.db);
	await setSetting(testActor(), 'notification_channels', {
		email: false,
		telegram: true,
		max: false
	});
	// Утренняя сводка идёт тем же проходом и зависит от часов прогона: здесь
	// считаются только уведомления о лицензиях (сводка — `digest.test.ts`).
	await setSetting(testActor(), 'daily_digest', { enabled: false, hour: 8 });
});

/** Вуз с ответственным и его руководителем, договор и позиция со сроком лицензии. */
async function makeLicense(licenseUntil: string) {
	const db = database.db;
	const suffix = randomUUID().slice(0, 8);
	const leadId = await insertUser(db, { roleId: 'lead', email: `lead-${suffix}@example.org` });
	const responsibleId = await insertUser(db, {
		roleId: 'manager',
		email: `kam-${suffix}@example.org`
	});
	await db.update(users).set({ managerUserId: leadId }).where(eq(users.id, responsibleId));

	const organizationId = await insertOrganization(db, { shortName: `Вуз ${suffix}` });
	await db.insert(organizationResponsibles).values({ organizationId, userId: responsibleId });

	const [product] = await db
		.insert(products)
		.values({ code: `LIC-${suffix}`, name: 'Учебная платформа', status: 'active' })
		.returning({ id: products.id });
	const [contract] = await db
		.insert(contracts)
		.values({ organizationId, number: `СЛ-${suffix}`, status: 'active' })
		.returning({ id: contracts.id });
	const [item] = await db
		.insert(contractItems)
		.values({
			contractId: contract.id,
			productId: product.id,
			licenseUntil,
			transferStatus: 'передан вузу'
		})
		.returning({ id: contractItems.id });

	return {
		organizationId,
		responsibleId,
		leadId,
		productId: product.id,
		contractId: contract.id,
		itemId: item.id
	};
}

describe('наблюдатель сроков лицензий', () => {
	it('истекающая лицензия даёт одно уведомление ответственному за два прохода цикла', async () => {
		const scene = await makeLicense(addDays(formatIsoDay(), 10));

		await runNotificationCycle(systemActor(randomUUID()));
		await runNotificationCycle(systemActor(randomUUID()));

		const rows = await database.db
			.select()
			.from(notificationDeliveries)
			.where(eq(notificationDeliveries.contractItemId, scene.itemId));

		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			kind: 'license_expiring',
			recipientUserId: scene.responsibleId,
			channel: 'telegram',
			status: 'stub',
			nextNotifyAt: null
		});
		expect(rows[0].body).toContain(`/organizations/${scene.organizationId}`);
	});

	it('продление заводит взаимодействие с продуктом и договором позиции на ответственного', async () => {
		await seedProcess(database, B2B_WORKSPACE_KEY, B2B_PROCESS);
		const scene = await makeLicense(addDays(formatIsoDay(), 10));

		const created = await startLicenseRenewal(testActor(), scene.itemId);

		expect(created.reused).toBe(false);

		const [row] = await database.db
			.select({
				title: interactions.title,
				ownerUserId: interactions.ownerUserId,
				contractId: interactions.contractId
			})
			.from(interactions)
			.where(eq(interactions.id, created.id));

		expect(row.title).toMatch(/^Продление лицензии «Учебная платформа»/);
		expect(row.ownerUserId).toBe(scene.responsibleId);
		expect(row.contractId).toBe(scene.contractId);

		const productRows = await database.db
			.select({ productId: interactionProducts.productId })
			.from(interactionProducts)
			.where(eq(interactionProducts.interactionId, created.id));
		const itemRows = await database.db
			.select({ contractItemId: interactionContractItems.contractItemId })
			.from(interactionContractItems)
			.where(eq(interactionContractItems.interactionId, created.id));

		expect(productRows).toEqual([{ productId: scene.productId }]);
		expect(itemRows).toEqual([{ contractItemId: scene.itemId }]);

		// Второе нажатие не заводит вторую запись.
		const again = await startLicenseRenewal(testActor(), scene.itemId);
		expect(again).toMatchObject({ id: created.id, reused: true });
	});

	it('два одновременных нажатия заводят одно продление', async () => {
		await seedProcess(database, B2B_WORKSPACE_KEY, B2B_PROCESS);
		const scene = await makeLicense(addDays(formatIsoDay(), 10));

		const both = await Promise.all([
			startLicenseRenewal(testActor(), scene.itemId),
			startLicenseRenewal(testActor(), scene.itemId)
		]);

		expect(both[0].id).toBe(both[1].id);
		expect(both.map((result) => result.reused).sort()).toEqual([false, true]);
		expect(
			await database.db
				.select({ id: interactionContractItems.interactionId })
				.from(interactionContractItems)
				.where(eq(interactionContractItems.contractItemId, scene.itemId))
		).toHaveLength(1);
	});
});
