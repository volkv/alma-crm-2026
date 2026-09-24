import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { LiveEvent } from '$lib/contracts/live';
import type { ActorContext } from '$lib/server/actor';
import { createSession, loadSessionUser, revokeAllSessions } from '$lib/server/auth/session';
import {
	comments,
	interactionParties,
	interactions,
	organizationResponsibles,
	users,
	workspaces
} from '$lib/server/db/schema';
import { withTransaction, afterCommit } from '$lib/server/db/transaction';
import { NotFoundError } from '$lib/server/errors';
import { getInteraction } from '$lib/server/interactions/read';
import { closeLiveBus, listenInteraction, publishLive } from '$lib/server/live/bus';
import { publishAfterCommit } from '$lib/server/live/publish';
import { openInteractionStream, recordActivity } from '$lib/server/live/stream';
import { listInteractionViewers } from '$lib/server/live/viewers';
import { removeWorkspaceMember } from '$lib/server/rbac/workspaces';
import {
	insertInteractionWithStage,
	insertOrganization,
	insertUser,
	startTestDatabase,
	testActor,
	type TestDatabase
} from '../helpers/db';

vi.mock('$env/dynamic/private', () => ({ env: process.env }));

let database: TestDatabase;

beforeAll(async () => {
	database = await startTestDatabase();
}, 300_000);

afterAll(async () => {
	await closeLiveBus();
	await database?.stop();
});

beforeEach(async () => {
	await database.reset();
});

/** Действующее лицо так, как его собирает запрос: область — из базы. */
async function sessionActor(userId: string): Promise<ActorContext> {
	const user = await loadSessionUser(userId);

	if (user === null) {
		throw new Error('Пользователь не собрался');
	}

	return { ...testActor(), user, scope: user.scope };
}

async function workspaceKeyOf(interactionId: string): Promise<string> {
	const [row] = await database.db
		.select({ key: workspaces.key })
		.from(interactions)
		.innerJoin(workspaces, eq(workspaces.id, interactions.workspaceId))
		.where(eq(interactions.id, interactionId));

	return row.key;
}

type Received = { event: string; data: unknown } | 'closed';

/** Читатель потока SSE: сообщения по одному, с потолком ожидания. */
function sseReader(response: Response) {
	const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
	let buffer = '';

	async function next(timeoutMs = 5_000): Promise<Received> {
		const deadline = Date.now() + timeoutMs;

		for (;;) {
			const boundary = buffer.indexOf('\n\n');

			if (boundary !== -1) {
				const block = buffer.slice(0, boundary);
				buffer = buffer.slice(boundary + 2);

				if (block.startsWith(':')) {
					continue;
				}

				const event = /^event: (.+)$/m.exec(block)?.[1] ?? 'message';
				const data = /^data: (.*)$/m.exec(block)?.[1] ?? 'null';

				return { event, data: JSON.parse(data) };
			}

			const left = deadline - Date.now();

			if (left <= 0) {
				throw new Error('Поток молчит дольше потолка ожидания');
			}

			const chunk = await Promise.race([
				reader.read(),
				new Promise<never>((_, reject) =>
					setTimeout(() => reject(new Error('Поток молчит дольше потолка ожидания')), left)
				)
			]);

			if (chunk.done) {
				return 'closed';
			}

			buffer += chunk.value;
		}
	}

	/** Следующее сообщение, кроме состава и пересылок чужих прогонов. */
	async function nextSignificant(): Promise<Received> {
		for (;;) {
			const message = await next();

			if (message === 'closed' || !['roster', 'interaction.changed'].includes(message.event)) {
				return message;
			}
		}
	}

	return { next, nextSignificant };
}

async function openFor(
	userId: string,
	interactionId: string,
	workspaceKey?: string,
	existingSession?: string
) {
	const sessionId =
		existingSession ?? (await createSession(userId, { ip: null, userAgent: 'vitest' }));
	const abort = new AbortController();
	const opened = await openInteractionStream({
		sessionId,
		interactionId,
		workspaceKey: workspaceKey ?? (await workspaceKeyOf(interactionId)),
		signal: abort.signal
	});

	return { opened, abort };
}

const COMMENT_ID = '5b0f3c2e-8f4d-4c1a-9e7b-2d6a1f0c9e11';

describe('поток живой карточки', () => {
	it('не подключается к чужому делу и к делу по чужому пространству в адресе', async () => {
		const owner = await insertUser(database.db, { roleId: 'manager' });
		const stranger = await insertUser(database.db, { roleId: 'manager' });
		const { interactionId } = await insertInteractionWithStage(database.db, {
			ownerUserId: owner
		});
		const other = await insertInteractionWithStage(database.db, { ownerUserId: owner });

		const foreign = await openFor(stranger, interactionId);
		expect(foreign.opened).toEqual({ status: 404, message: 'Взаимодействие не найдено' });

		const wrongSpace = await openFor(
			owner,
			interactionId,
			await workspaceKeyOf(other.interactionId)
		);
		expect(wrongSpace.opened).toEqual({ status: 404, message: 'Взаимодействие не найдено' });
	});

	it('после исключения из пространства прощается и больше ничего не выдаёт', async () => {
		const owner = await insertUser(database.db, { roleId: 'manager' });
		const { interactionId } = await insertInteractionWithStage(database.db, {
			ownerUserId: owner
		});
		const { opened, abort } = await openFor(owner, interactionId);

		expect(opened).toBeInstanceOf(Response);
		const stream = sseReader(opened as Response);

		expect(await stream.next()).toMatchObject({ event: 'hello' });
		expect(await stream.next()).toMatchObject({
			event: 'roster',
			data: {
				people: expect.arrayContaining([expect.objectContaining({ userId: owner, you: true })])
			}
		});

		await publishLive(interactionId, { type: 'comment.added', commentId: COMMENT_ID });
		expect(await stream.nextSignificant()).toEqual({
			event: 'comment.added',
			data: { commentId: COMMENT_ID }
		});

		await removeWorkspaceMember(testActor(), {
			key: await workspaceKeyOf(interactionId),
			userId: owner,
			confirmOwned: true
		});
		await publishLive(interactionId, { type: 'comment.added', commentId: COMMENT_ID });

		expect(await stream.nextSignificant()).toEqual({ event: 'bye', data: { reason: 'access' } });
		expect(await stream.next()).toBe('closed');
		abort.abort();
	});

	it('после отзыва сессии прощается и больше ничего не выдаёт', async () => {
		const owner = await insertUser(database.db, { roleId: 'manager' });
		const { interactionId } = await insertInteractionWithStage(database.db, {
			ownerUserId: owner
		});
		const { opened, abort } = await openFor(owner, interactionId);
		const stream = sseReader(opened as Response);

		expect(await stream.next()).toMatchObject({ event: 'hello' });

		await revokeAllSessions(owner);
		await publishLive(interactionId, { type: 'comment.added', commentId: COMMENT_ID });

		expect(await stream.nextSignificant()).toEqual({ event: 'bye', data: { reason: 'session' } });
		expect(await stream.next()).toBe('closed');
		abort.abort();
	});
});

describe('публикация после фиксации', () => {
	it('уходит после фиксации, когда запись уже видна, и не уходит при откате', async () => {
		const owner = await insertUser(database.db, { roleId: 'manager' });
		const { interactionId } = await insertInteractionWithStage(database.db, {
			ownerUserId: owner
		});
		const received: { event: LiveEvent | { type: 'resync' }; committed: boolean }[] = [];

		const unlisten = await listenInteraction(interactionId, (event) => {
			if (event.type !== 'comment.added') {
				return;
			}
			// Проверка «видна ли запись» — в момент получения: сообщение, ушедшее
			// до фиксации, застало бы комментарий ещё невидимым.
			void database.db
				.select({ id: comments.id })
				.from(comments)
				.where(eq(comments.id, event.commentId))
				.then((rows) => received.push({ event, committed: rows.length === 1 }));
		});

		const committedId = await withTransaction(testActor(), async (tx) => {
			const [row] = await tx
				.insert(comments)
				.values({ interactionId, authorId: owner, body: 'зафиксирован' })
				.returning({ id: comments.id });

			publishAfterCommit(tx, interactionId, { type: 'comment.added', commentId: row.id });

			return row.id;
		});

		let rolledBackId: string | undefined;
		await expect(
			withTransaction(testActor(), async (tx) => {
				const [row] = await tx
					.insert(comments)
					.values({ interactionId, authorId: owner, body: 'откатится' })
					.returning({ id: comments.id });

				rolledBackId = row.id;
				publishAfterCommit(tx, interactionId, { type: 'comment.added', commentId: row.id });

				throw new Error('откат');
			})
		).rejects.toThrow('откат');

		await vi.waitFor(() => expect(received).toHaveLength(1), { timeout: 5_000 });
		// Время на то, чтобы откатившееся сообщение пришло, если бы оно ушло.
		await new Promise((settle) => setTimeout(settle, 500));
		unlisten();

		expect(received).toEqual([
			{ event: { type: 'comment.added', commentId: committedId }, committed: true }
		]);
		expect(rolledBackId).toBeDefined();
	});

	it('отвергает транзакцию, открытую в обход withTransaction', async () => {
		await expect(
			database.db.transaction(async (tx) => {
				afterCommit(tx, async () => undefined);
			})
		).rejects.toThrow('afterCommit');
	});
});

describe('кто видит дело', () => {
	it('совпадает с условием видимости карточки для каждого сотрудника', async () => {
		const university = await insertOrganization(database.db, { shortName: 'Свой вуз' });
		const lead = await insertUser(database.db, { roleId: 'lead', fullName: 'Руководитель' });
		const outsideLead = await insertUser(database.db, {
			roleId: 'lead',
			fullName: 'Руководитель вне пространства',
			workspaces: 'none'
		});
		const owner = await insertUser(database.db, { roleId: 'manager', fullName: 'Ведущий' });
		const responsible = await insertUser(database.db, {
			roleId: 'manager',
			fullName: 'Ответственный за вуз'
		});
		const colleague = await insertUser(database.db, {
			roleId: 'manager',
			fullName: 'Менеджер чужого вуза'
		});
		const outsider = await insertUser(database.db, {
			roleId: 'manager',
			fullName: 'Не член пространства',
			workspaces: 'none'
		});
		const admin = await insertUser(database.db, { roleId: 'admin', fullName: 'Админ' });

		await database.db.update(users).set({ managerUserId: lead }).where(eq(users.id, owner));
		await database.db
			.update(users)
			.set({ managerUserId: outsideLead })
			.where(eq(users.id, responsible));

		const { interactionId } = await insertInteractionWithStage(database.db, {
			ownerUserId: owner
		});
		await database.db.insert(interactionParties).values({
			interactionId,
			organizationId: university,
			partyRole: 'educational_institution',
			isPrimary: true
		});
		await database.db
			.insert(organizationResponsibles)
			.values({ organizationId: university, userId: responsible });
		const foreignUniversity = await insertOrganization(database.db, { shortName: 'Чужой вуз' });
		await database.db
			.insert(organizationResponsibles)
			.values({ organizationId: foreignUniversity, userId: colleague });

		const everyone = await database.db.select({ id: users.id, roleId: users.roleId }).from(users);
		const expected: string[] = [];

		for (const person of everyone) {
			if (person.roleId === 'service') {
				continue;
			}

			const seen = await getInteraction(await sessionActor(person.id), interactionId).then(
				() => true,
				(failure: unknown) => {
					if (failure instanceof NotFoundError) {
						return false;
					}
					throw failure;
				}
			);

			if (seen) {
				expected.push(person.id);
			}
		}

		const viewers = await listInteractionViewers(interactionId);

		expect(viewers.map((viewer) => viewer.userId).sort()).toEqual(expected.sort());
		// Набор действительно различает случаи, а не совпадает на пустом.
		expect(expected).toEqual(expect.arrayContaining([owner, responsible, lead, admin]));
		expect(expected).not.toContain(colleague);
		expect(expected).not.toContain(outsider);
		expect(expected).not.toContain(outsideLead);
		expect(viewers.find((viewer) => viewer.userId === owner)?.relation).toBe('responsible');
		expect(viewers.find((viewer) => viewer.userId === lead)?.relation).toBe('lead');
	});
});

describe('кто печатает', () => {
	it('доходит коллеге, не возвращается своей сессии и не принимается без доступа к делу', async () => {
		const owner = await insertUser(database.db, { roleId: 'manager' });
		const admin = await insertUser(database.db, { roleId: 'admin' });
		const stranger = await insertUser(database.db, { roleId: 'manager' });
		const { interactionId } = await insertInteractionWithStage(database.db, {
			ownerUserId: owner
		});
		const workspaceKey = await workspaceKeyOf(interactionId);
		const ownerSession = await createSession(owner, { ip: null, userAgent: 'vitest' });

		const colleague = await openFor(admin, interactionId);
		const self = await openFor(owner, interactionId, workspaceKey, ownerSession);
		const colleagueStream = sseReader(colleague.opened as Response);
		const selfStream = sseReader(self.opened as Response);

		expect(await colleagueStream.next()).toMatchObject({ event: 'hello' });
		expect(await selfStream.next()).toMatchObject({ event: 'hello' });

		const signal = async (userId: string, sessionId: string) =>
			recordActivity({
				sessionId,
				user: (await loadSessionUser(userId))!,
				interactionId,
				workspaceKey,
				signal: { kind: 'typing', active: true }
			});

		expect(
			await signal(stranger, await createSession(stranger, { ip: null, userAgent: 'vitest' }))
		).toBe(false);
		expect(await signal(owner, ownerSession)).toBe(true);

		expect(await colleagueStream.nextSignificant()).toEqual({
			event: 'typing',
			data: { userIds: [owner] }
		});

		// Своей сессии «печатает» не приходит: следующим она видит комментарий.
		await publishLive(interactionId, { type: 'comment.added', commentId: COMMENT_ID });
		expect(await selfStream.nextSignificant()).toEqual({
			event: 'comment.added',
			data: { commentId: COMMENT_ID }
		});

		colleague.abort.abort();
		self.abort.abort();
	});
});
