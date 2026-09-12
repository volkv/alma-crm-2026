/**
 * Учёт персональных данных на настоящей базе: согласия, срок хранения,
 * обезличивание.
 *
 * Проверяется то, ради чего это заведено: у обработки данных есть основание,
 * отозванное согласие остаётся историей, а уничтожение необратимо и не
 * оставляет ни контактов, ни имени — но и не сносит запись, на которую
 * ссылаются роли и взаимодействия.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ANONYMIZED_PERSON_LAST_NAME } from '$lib/contracts/directory';
import { auditEvents, people } from '$lib/server/db/schema';
import { listPersonOptions } from '$lib/server/directory/read';
import { updatePerson } from '$lib/server/directory/write';
import { ConflictError, ForbiddenError, NotFoundError } from '$lib/server/errors';
import { listConsents, recordConsent, withdrawConsent } from '$lib/server/people/consents';
import { anonymizePerson, setRetention } from '$lib/server/people/retention';
import { insertPerson, startTestDatabase, testActor, type TestDatabase } from '../helpers/db';

// См. комментарий в `helpers/db.ts`: без этого сервисы пойдут в базу разработчика.
vi.mock('$env/dynamic/private', () => ({ env: process.env }));

let database: TestDatabase;

beforeAll(async () => {
	database = await startTestDatabase();
}, 300_000);

afterAll(async () => {
	await database?.stop();
});

beforeEach(async () => {
	await database.reset();
});

/** События одного вида, записанные в журнал. */
async function events(type: string) {
	return database.db.select().from(auditEvents).where(eq(auditEvents.eventType, type));
}

describe('согласия', () => {
	it('фиксирует согласие, показывает его в списке и пишет событие журнала', async () => {
		const ctx = testActor();
		const personId = await insertPerson(database.db);

		const consent = await recordConsent(ctx, {
			personId,
			basis: 'contract',
			textVersion: '2026-09-01',
			givenAt: '2026-09-01'
		});

		expect(consent.basis).toBe('contract');
		expect(consent.withdrawnAt).toBeNull();
		expect(consent.recordedByName).toBe('Тестовый Администратор');

		const list = await listConsents(ctx, personId);
		expect(list).toHaveLength(1);
		expect(list[0].id).toBe(consent.id);

		const recorded = await events('people.consent_recorded');
		expect(recorded).toHaveLength(1);
		expect(recorded[0].subjectId).toBe(consent.id);
		// В журнал едут только ссылки на записи: ни версии текста, ни фамилии.
		expect(recorded[0].details).toEqual({ personId });
	});

	it('отзывает согласие один раз и оставляет его в истории', async () => {
		const ctx = testActor();
		const personId = await insertPerson(database.db);

		const consent = await recordConsent(ctx, {
			personId,
			basis: 'consent',
			textVersion: 'v1',
			givenAt: '2026-01-10'
		});

		const withdrawn = await withdrawConsent(ctx, { id: consent.id, withdrawnAt: '2026-05-20' });
		expect(withdrawn.withdrawnAt).toBe('2026-05-20');
		expect(withdrawn.withdrawnByName).toBe('Тестовый Администратор');

		await expect(
			withdrawConsent(ctx, { id: consent.id, withdrawnAt: '2026-06-01' })
		).rejects.toBeInstanceOf(ConflictError);

		// Запись никуда не делась: по ней видно, на чём держалась обработка до
		// отзыва.
		const list = await listConsents(ctx, personId);
		expect(list).toHaveLength(1);
		expect(list[0].withdrawnAt).toBe('2026-05-20');
	});

	it('не принимает отзыв раньше даты получения', async () => {
		const ctx = testActor();
		const personId = await insertPerson(database.db);

		const consent = await recordConsent(ctx, {
			personId,
			basis: 'consent',
			textVersion: 'v1',
			givenAt: '2026-05-01'
		});

		await expect(
			withdrawConsent(ctx, { id: consent.id, withdrawnAt: '2026-04-01' })
		).rejects.toBeInstanceOf(ConflictError);
	});

	it('ставит действующие согласия выше отозванных', async () => {
		const ctx = testActor();
		const personId = await insertPerson(database.db);

		const old = await recordConsent(ctx, {
			personId,
			basis: 'consent',
			textVersion: 'v1',
			givenAt: '2026-01-01'
		});
		await withdrawConsent(ctx, { id: old.id, withdrawnAt: '2026-02-01' });

		const fresh = await recordConsent(ctx, {
			personId,
			basis: 'legal',
			textVersion: 'v2',
			givenAt: '2026-02-02'
		});

		const list = await listConsents(ctx, personId);
		expect(list.map((item) => item.id)).toEqual([fresh.id, old.id]);
	});

	it('отказывает без права на учёт согласий и оставляет отказ в журнале', async () => {
		const personId = await insertPerson(database.db);
		const blind = testActor({ permissions: ['people.read', 'people.write'] });

		await expect(
			recordConsent(blind, {
				personId,
				basis: 'consent',
				textVersion: 'v1',
				givenAt: '2026-01-01'
			})
		).rejects.toBeInstanceOf(ForbiddenError);

		const denied = await events('people.consent_recorded');
		expect(denied).toHaveLength(1);
		expect(denied[0].outcome).toBe('denied');

		// И читать основания обработки такому вызывающему тоже нечего.
		await expect(listConsents(blind, personId)).rejects.toBeInstanceOf(ForbiddenError);
	});

	it('не находит согласие несуществующего человека', async () => {
		await expect(
			recordConsent(testActor(), {
				personId: '11111111-2222-4333-8444-555555555555',
				basis: 'consent',
				textVersion: 'v1',
				givenAt: '2026-01-01'
			})
		).rejects.toBeInstanceOf(NotFoundError);
	});
});

describe('срок хранения', () => {
	it('назначает срок и пишет изменение в журнал именами полей', async () => {
		const ctx = testActor();
		const personId = await insertPerson(database.db);

		const view = await setRetention(ctx, { personId, retentionUntil: '2030-01-01' });
		expect(view.retentionUntil).toBe('2030-01-01');

		const changed = await events('people.retention_changed');
		expect(changed).toHaveLength(1);
		expect(changed[0].details).toEqual({ changedFields: ['retentionUntil'] });
	});

	it('снимает срок и отвергает повторную запись того же значения', async () => {
		const ctx = testActor();
		const personId = await insertPerson(database.db, { retentionUntil: '2030-01-01' });

		const cleared = await setRetention(ctx, { personId, retentionUntil: null });
		expect(cleared.retentionUntil).toBeNull();

		await expect(setRetention(ctx, { personId, retentionUntil: null })).rejects.toBeInstanceOf(
			ConflictError
		);
	});

	it('отказывает без права и оставляет отказ в журнале', async () => {
		const personId = await insertPerson(database.db);
		const blind = testActor({ permissions: ['people.read', 'people.write'] });

		await expect(
			setRetention(blind, { personId, retentionUntil: '2030-01-01' })
		).rejects.toBeInstanceOf(ForbiddenError);

		const denied = await events('people.retention_changed');
		expect(denied).toHaveLength(1);
		expect(denied[0].outcome).toBe('denied');
	});
});

describe('обезличивание', () => {
	it('стирает имя и контакты, оставляя запись на месте', async () => {
		const ctx = testActor();
		const personId = await insertPerson(database.db, {
			lastName: 'Петров',
			email: 'petrov@vuz.ru',
			phone: '+7 900 000-00-01',
			retentionUntil: '2020-01-01'
		});

		const view = await anonymizePerson(ctx, personId);

		expect(view.lastName).toBe(ANONYMIZED_PERSON_LAST_NAME);
		expect(view.firstName).toBe('');
		expect(view.email).toBeNull();
		expect(view.phone).toBeNull();
		expect(view.anonymizedAt).not.toBeNull();

		const [row] = await database.db.select().from(people).where(eq(people.id, personId));
		expect(row.middleName).toBeNull();
		expect(row.notes).toBeNull();

		const anonymized = await events('people.anonymized');
		expect(anonymized).toHaveLength(1);
		expect(anonymized[0].details).toEqual({ personId });
	});

	it('второй раз отказывает: обезличивание случается один раз', async () => {
		const ctx = testActor();
		const personId = await insertPerson(database.db);

		await anonymizePerson(ctx, personId);

		await expect(anonymizePerson(ctx, personId)).rejects.toBeInstanceOf(ConflictError);
	});

	it('не даёт вернуть стёртые данные правкой карточки', async () => {
		const ctx = testActor();
		const personId = await insertPerson(database.db);

		await anonymizePerson(ctx, personId);

		await expect(
			updatePerson(ctx, {
				id: personId,
				lastName: 'Петров',
				firstName: 'Пётр',
				middleName: null,
				email: 'petrov@vuz.ru',
				phone: null,
				notes: null
			})
		).rejects.toBeInstanceOf(ConflictError);

		const [row] = await database.db.select().from(people).where(eq(people.id, personId));
		expect(row.lastName).toBe(ANONYMIZED_PERSON_LAST_NAME);
		expect(row.email).toBeNull();
	});

	it('убирает человека из подбора контактов, но не из базы', async () => {
		const ctx = testActor();
		const personId = await insertPerson(database.db, { lastName: 'Сидоров' });
		const otherId = await insertPerson(database.db, { lastName: 'Кузнецов' });

		await anonymizePerson(ctx, personId);

		const options = await listPersonOptions(ctx);
		expect(options.map((option) => option.id)).toEqual([otherId]);

		const rows = await database.db.select({ id: people.id }).from(people);
		expect(rows).toHaveLength(2);
	});

	it('отказывает без права и оставляет отказ в журнале', async () => {
		const personId = await insertPerson(database.db);
		const blind = testActor({ permissions: ['people.read', 'people.write'] });

		await expect(anonymizePerson(blind, personId)).rejects.toBeInstanceOf(ForbiddenError);

		const denied = await events('people.anonymized');
		expect(denied).toHaveLength(1);
		expect(denied[0].outcome).toBe('denied');
	});

	it('не идёт по праву на учёт согласий: уничтожение — отдельное полномочие', async () => {
		const personId = await insertPerson(database.db, { retentionUntil: '2020-01-01' });
		const keeper = testActor({
			permissions: ['people.read', 'people.write', 'people.manage_consents']
		});

		// Тот, кто ведёт основания обработки, распоряжается отменяемым: срок
		// хранения переназначают, согласие отзывают. Уничтожение не переигрывают
		// никак, поэтому оно за своим правом.
		await expect(
			setRetention(keeper, { personId, retentionUntil: '2030-01-01' })
		).resolves.toMatchObject({ retentionUntil: '2030-01-01' });

		await expect(anonymizePerson(keeper, personId)).rejects.toBeInstanceOf(ForbiddenError);

		const denied = await events('people.anonymized');
		expect(denied).toHaveLength(1);
		expect(denied[0].outcome).toBe('denied');

		// Данные на месте: отказ не должен стирать половину.
		const [row] = await database.db.select().from(people).where(eq(people.id, personId));
		expect(row.anonymizedAt).toBeNull();
	});
});
