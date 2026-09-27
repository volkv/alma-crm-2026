// См. комментарий в `helpers/db.ts`: без этого сервисы пойдут в базу разработчика.
import { vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({ env: process.env }));

import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mentionToken } from '$lib/contracts/mentions';
import { systemActor, type ActorContext } from '$lib/server/actor';
import { loadSessionUser } from '$lib/server/auth/session';
import {
	commentMentions,
	comments,
	interactions,
	notificationDeliveries,
	users,
	workspaces
} from '$lib/server/db/schema';
import { ValidationError } from '$lib/server/errors';
import { closeLiveBus } from '$lib/server/live/bus';
import { listInbox } from '$lib/server/inbox';
import { INBOX_ACCESS_LOST } from '$lib/server/notifications/inbox';
import { runNotificationCycle } from '$lib/server/notifications/watch';
import { removeWorkspaceMember } from '$lib/server/rbac/workspaces';
import { getRedis } from '$lib/server/redis';
import { setSetting } from '$lib/server/settings';
import { addComment } from '$lib/server/stages/commands';
import {
	insertInteractionWithStage,
	insertUser,
	startTestDatabase,
	testActor,
	type TestDatabase
} from '../helpers/db';

/**
 * Упоминание в комментарии: позвать можно только того, кто видит дело, письмо
 * уходит одно, а потерявший доступ до отправки письма не получает.
 *
 * Канал — заглушка: проверяется, кому и сколько раз система решила сказать.
 */
let database: TestDatabase;

beforeAll(async () => {
	database = await startTestDatabase();
}, 300_000);

afterAll(async () => {
	await closeLiveBus();
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
});

async function sessionActor(userId: string): Promise<ActorContext> {
	const user = await loadSessionUser(userId);

	if (user === null) {
		throw new Error('Пользователь не собрался');
	}

	return { ...testActor(), user, scope: user.scope };
}

async function mentionDeliveriesOf(userId: string) {
	return database.db
		.select()
		.from(notificationDeliveries)
		.where(
			and(
				eq(notificationDeliveries.kind, 'mention'),
				eq(notificationDeliveries.recipientUserId, userId)
			)
		);
}

describe('упоминание в комментарии', () => {
	it('видящему — одно письмо без текста и названия, невидящему — отказ, потерявшему доступ — пропуск с причиной', async () => {
		const db = database.db;
		const lead = await insertUser(db, { roleId: 'lead', fullName: 'Руководитель' });
		const owner = await insertUser(db, { roleId: 'manager', fullName: 'Ведущий' });
		const admin = await insertUser(db, { roleId: 'admin', fullName: 'Админ' });
		await db.update(users).set({ managerUserId: lead }).where(eq(users.id, owner));

		const { interactionId } = await insertInteractionWithStage(db, { ownerUserId: owner });
		// Коллега по пространству без своего вуза в деле: член пространства, но
		// дела не видит.
		const colleague = await insertUser(db, { roleId: 'manager', fullName: 'Коллега' });
		await db
			.update(interactions)
			.set({ title: 'Заявка Иванова Ивана Ивановича' })
			.where(eq(interactions.id, interactionId));

		const author = await sessionActor(owner);
		const requestKey = randomUUID();
		const body = `${mentionToken('Админ', admin)}, телефон +7 900 000-00-00 — позвоните`;

		const first = await addComment(author, { interactionId, body, requestKey });
		// Повтор той же отправки формы: тот же комментарий, без второго письма.
		const repeated = await addComment(author, { interactionId, body, requestKey });

		expect(repeated.id).toBe(first.id);
		expect(
			await db.select().from(comments).where(eq(comments.interactionId, interactionId))
		).toHaveLength(1);

		// Невидящего позвать нельзя: комментарий не записывается целиком.
		await expect(
			addComment(author, {
				interactionId,
				body: `${mentionToken('Коллега', colleague)}, глянь`
			})
		).rejects.toBeInstanceOf(ValidationError);
		expect(
			await db.select().from(commentMentions).where(eq(commentMentions.userId, colleague))
		).toHaveLength(0);

		// Руководитель видит дело при упоминании, но теряет доступ до письма.
		await addComment(author, { interactionId, body: `${mentionToken('Руководитель', lead)} ок?` });
		const [workspace] = await db
			.select({ key: workspaces.key })
			.from(interactions)
			.innerJoin(workspaces, eq(workspaces.id, interactions.workspaceId))
			.where(eq(interactions.id, interactionId));
		await removeWorkspaceMember(testActor(), {
			key: workspace.key,
			userId: lead,
			confirmOwned: false
		});

		await runNotificationCycle(systemActor(randomUUID()));
		await runNotificationCycle(systemActor(randomUUID()));

		const toAdmin = await mentionDeliveriesOf(admin);

		expect(toAdmin).toHaveLength(1);
		expect(toAdmin[0]).toMatchObject({ channel: 'telegram', status: 'stub', nextNotifyAt: null });
		expect(toAdmin[0].body).toContain(`/interactions/${interactionId}`);
		expect(`${toAdmin[0].subject}\n${toAdmin[0].body}`).not.toMatch(/Иванов|900|позвоните/);

		const toLead = await mentionDeliveriesOf(lead);

		expect(toLead).toHaveLength(1);
		expect(toLead[0]).toMatchObject({
			status: 'skipped',
			lastError: INBOX_ACCESS_LOST,
			nextNotifyAt: null
		});

		// Колокольчик: у адресата одно непрочитанное упоминание от автора.
		const inbox = await listInbox(await sessionActor(admin));

		expect(inbox.unread).toBe(1);
		expect(inbox.items[0]).toMatchObject({
			kind: 'mention',
			interactionId,
			authorName: 'Ведущий',
			readAt: null
		});
	});
});
