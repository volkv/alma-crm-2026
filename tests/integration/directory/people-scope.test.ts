/**
 * Граница области доступа на записи людей.
 *
 * Правка человека и заведение ему роли идут по идентификатору человека, поэтому
 * проверку видимости держит сам сервис: форма, API и загрузки зовут его, и
 * вход, забывший проверить сам, не должен открывать чужих людей. Сотрудник
 * вне области не видит человека чужого вуза ни в чтении, ни в записи —
 * «не найден», и запись в базе остаётся прежней.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { affiliations, people } from '$lib/server/db/schema';
import { createAffiliation, updateAffiliation, updatePerson } from '$lib/server/directory/write';
import { NotFoundError } from '$lib/server/errors';
import {
	insertOrganization,
	insertPerson,
	scopedActor,
	startTestDatabase,
	type TestDatabase
} from '../helpers/db';

// См. комментарий в `helpers/db.ts`: без этого сервисы пойдут в базу разработчика.
vi.mock('$env/dynamic/private', () => ({ env: process.env }));

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

describe('запись людей вне области доступа', () => {
	it('сотрудник не правит человека чужого вуза и не заводит ему роль', async () => {
		const ownId = await insertOrganization(database.db, { shortName: 'Свой вуз' });
		const foreignId = await insertOrganization(database.db, { shortName: 'Чужой вуз' });
		const personId = await insertPerson(database.db, { lastName: 'Чужов' });

		await database.db.insert(affiliations).values({
			personId,
			organizationId: foreignId,
			position: 'Проректор',
			roleKind: 'vice_rector',
			validFrom: '2026-01-01'
		});

		const manager = await scopedActor(database.db, {
			roleId: 'manager',
			permissions: ['organizations.read', 'people.read', 'people.write', 'people.read_pii'],
			organizationIds: [ownId]
		});

		await expect(
			updatePerson(manager, {
				id: personId,
				lastName: 'Переписан',
				firstName: 'Тест',
				middleName: null,
				email: 'hijack@example.org',
				phone: null,
				notes: null
			})
		).rejects.toBeInstanceOf(NotFoundError);

		await expect(
			createAffiliation(manager, {
				personId,
				organizationId: ownId,
				siteId: null,
				position: 'Контакт',
				roleKind: 'other',
				isPrimary: false,
				validFrom: '2026-09-01',
				validTo: null,
				channel: null
			})
		).rejects.toBeInstanceOf(NotFoundError);

		const [person] = await database.db.select().from(people).where(eq(people.id, personId));
		const roles = await database.db
			.select()
			.from(affiliations)
			.where(eq(affiliations.personId, personId));

		expect(person.lastName).toBe('Чужов');
		expect(roles.map((role) => role.organizationId)).toEqual([foreignId]);
	});

	it('правит свою роль, а роль в чужом вузе не находит', async () => {
		const ownId = await insertOrganization(database.db, { shortName: 'Свой вуз' });
		const foreignId = await insertOrganization(database.db, { shortName: 'Чужой вуз' });
		const personId = await insertPerson(database.db, { lastName: 'Двойнов' });

		const [own, foreign] = await database.db
			.insert(affiliations)
			.values([
				{
					personId,
					organizationId: ownId,
					position: 'Проретор',
					roleKind: 'vice_rector',
					validFrom: '2026-01-01'
				},
				{
					personId,
					organizationId: foreignId,
					position: 'Декан',
					roleKind: 'dean',
					validFrom: '2026-01-01'
				}
			])
			.returning();

		const manager = await scopedActor(database.db, {
			roleId: 'manager',
			permissions: ['organizations.read', 'people.read', 'people.write', 'people.read_pii'],
			organizationIds: [ownId]
		});
		const fields = {
			position: 'Проректор',
			roleKind: 'vice_rector' as const,
			isPrimary: true,
			validFrom: '2026-02-01',
			validTo: null,
			channel: 'Почта'
		};

		const updated = await updateAffiliation(manager, { id: own.id, ...fields });

		expect(updated).toMatchObject({ organizationId: ownId, ...fields });
		await expect(updateAffiliation(manager, { id: foreign.id, ...fields })).rejects.toBeInstanceOf(
			NotFoundError
		);

		const [untouched] = await database.db
			.select()
			.from(affiliations)
			.where(eq(affiliations.id, foreign.id));

		expect(untouched.position).toBe('Декан');
	});
});
