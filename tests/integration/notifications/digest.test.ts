// См. комментарий в `helpers/db.ts`: без этого сервисы пойдут в базу разработчика.
import { vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({ env: process.env }));

import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { systemActor } from '$lib/server/actor';
import { interactionParties, notificationDeliveries, stageEntries } from '$lib/server/db/schema';
import { listNotificationDeliveries } from '$lib/server/notifications';
import { runNotificationCycle } from '$lib/server/notifications/watch';
import { getRedis } from '$lib/server/redis';
import { setSetting } from '$lib/server/settings';
import {
	daysFrom,
	insertInteractionWithStage,
	insertOrganization,
	insertUser,
	startTestDatabase,
	testActor,
	type TestDatabase
} from '../helpers/db';

/**
 * Утренняя сводка «Мой день».
 *
 * Канал — заглушка: проверяется, кому и сколько раз система решила сказать.
 * Час сводки — полночь, поэтому любой момент прогона уже «в час сводки или
 * позже».
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
	await setSetting(testActor(), 'notification_channels', {
		email: false,
		telegram: true,
		max: false
	});
	await setSetting(testActor(), 'daily_digest', { enabled: true, hour: 0 });
});

async function digestsOf(userId: string) {
	return database.db
		.select()
		.from(notificationDeliveries)
		.where(
			and(
				eq(notificationDeliveries.kind, 'daily_digest'),
				eq(notificationDeliveries.recipientUserId, userId)
			)
		);
}

describe('утренняя сводка', () => {
	it('два прохода в час сводки дают одну сводку КАМу с его просроченной стадией и ни одной сотруднику без дел', async () => {
		const db = database.db;
		const suffix = randomUUID().slice(0, 8);
		const kamId = await insertUser(db, { roleId: 'manager', email: `kam-${suffix}@example.org` });
		const idleId = await insertUser(db, {
			roleId: 'manager',
			email: `idle-${suffix}@example.org`
		});

		// Норматив стадии — пять дней, стоит десять: стадия просрочена.
		const { interactionId, stageId, snapshot } = await insertInteractionWithStage(db, {
			ownerUserId: kamId,
			slaDays: 5
		});
		const organizationId = await insertOrganization(db, { shortName: `Вуз ${suffix}` });
		await db.insert(interactionParties).values({
			interactionId,
			organizationId,
			partyRole: 'educational_institution',
			isPrimary: true
		});
		await db.insert(stageEntries).values({
			interactionId,
			stageId,
			stageSnapshot: snapshot,
			enteredAt: daysFrom(new Date(), -10)
		});

		await runNotificationCycle(systemActor(randomUUID()));
		const second = await runNotificationCycle(systemActor(randomUUID()));

		// Второй проход того же утра не отправляет ничего: ни сводку заново, ни
		// что-либо ещё.
		expect(second.scanned).toBe(0);

		const kam = await digestsOf(kamId);

		expect(kam).toHaveLength(1);
		expect(kam[0]).toMatchObject({ channel: 'telegram', status: 'stub', nextNotifyAt: null });
		expect(kam[0].body).toContain('Просрочены стадии (1)');
		expect(kam[0].body).toContain(`/interactions/${interactionId}`);

		expect(await digestsOf(idleId)).toHaveLength(0);
	});
});

describe('сводка в журнале доставок', () => {
	it('руководитель видит строку сводки подчинённого без текста; получатель и администратор — с текстом', async () => {
		const db = database.db;
		const suffix = randomUUID().slice(0, 8);
		const leadId = await insertUser(db, { roleId: 'lead', email: `lead-${suffix}@example.org` });
		const kamId = await insertUser(db, { roleId: 'lead', email: `kam-${suffix}@example.org` });

		// Сводку собирали в области КАМа: в ней дело пространства, где
		// руководителя нет.
		await db.insert(notificationDeliveries).values({
			kind: 'daily_digest',
			recipientUserId: kamId,
			digestDay: '2026-09-24',
			channel: 'telegram',
			status: 'stub',
			subject: 'Мой день на 24 сентября: 1 дело',
			body: '— «Чужое пространство: секретное дело» (Вуз Б): стадия просрочена.'
		});

		const query = { status: null, channel: null, page: 1, pageSize: 50 };
		const lead = testActor({
			roleId: 'lead',
			userId: leadId,
			scopeUserIds: [leadId, kamId],
			workspaceIds: []
		});
		const recipient = testActor({
			roleId: 'lead',
			userId: kamId,
			scopeUserIds: [kamId],
			workspaceIds: []
		});

		const seenByLead = await listNotificationDeliveries(lead, query);
		expect(seenByLead.items).toHaveLength(1);
		expect(seenByLead.items[0]).toMatchObject({
			recipientUserId: kamId,
			status: 'stub',
			digestDay: '2026-09-24',
			subject: null,
			body: null
		});

		const seenByRecipient = await listNotificationDeliveries(recipient, query);
		expect(seenByRecipient.items[0]?.body).toContain('секретное дело');

		const seenByAdmin = await listNotificationDeliveries(testActor(), query);
		expect(seenByAdmin.items[0]?.subject).toBe('Мой день на 24 сентября: 1 дело');
	});
});
