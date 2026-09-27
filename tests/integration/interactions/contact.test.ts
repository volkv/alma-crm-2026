/**
 * Смена контактного лица из карточки: новый контакт ложится в сторону и в
 * историю с причиной, а роль чужой организации или закончившаяся роль —
 * отказ, после которого ничего не записано. Человек, заведённый в карточке,
 * становится ролью вуза стороны и сразу её контактом; без права заводить
 * людей — отказ.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { affiliations, interactionChanges, people } from '$lib/server/db/schema';
import { ForbiddenError, ValidationError } from '$lib/server/errors';
import { defaultRolePermissions } from '$lib/server/rbac/seed';
import type { PermissionKey } from '$lib/server/rbac/permissions';
import {
	changeInteractionContact,
	createInteractionContact
} from '$lib/server/interactions/contact';
import { getInteraction } from '$lib/server/interactions/read';
import {
	insertOrganization,
	insertPerson,
	startTestDatabase,
	testActor,
	type TestDatabase
} from '../helpers/db';
import {
	B2B_PROCESS,
	B2B_WORKSPACE_KEY,
	createInteractionOn,
	seedProcess
} from '../stages/fixture';

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

async function insertAffiliation(
	organizationId: string,
	lastName: string,
	validTo: string | null = null
): Promise<string> {
	const personId = await insertPerson(database.db, { lastName });
	const [row] = await database.db
		.insert(affiliations)
		.values({
			personId,
			organizationId,
			position: 'Проректор',
			roleKind: 'vice_rector',
			validFrom: '2026-01-01',
			validTo
		})
		.returning({ id: affiliations.id });

	return row.id;
}

describe('смена контактного лица', () => {
	it('сохраняет действующую роль своей организации и отвергает чужую и прежнюю', async () => {
		const ctx = testActor({ roleId: 'admin' });
		await seedProcess(database, B2B_WORKSPACE_KEY, B2B_PROCESS);
		const { interactionId, organizationId } = await createInteractionOn(ctx, database);
		const foreignId = await insertOrganization(database.db, { shortName: 'Чужой вуз' });

		const own = await insertAffiliation(organizationId, 'Контактов');
		const ended = await insertAffiliation(organizationId, 'Прежний', '2026-03-01');
		const foreign = await insertAffiliation(foreignId, 'Чужов');

		const before = await getInteraction(ctx, interactionId);
		const party = before.parties.find((row) => row.isPrimary);

		if (party === undefined) throw new Error('У записи нет основной стороны');

		await changeInteractionContact(ctx, {
			interactionId,
			partyId: party.id,
			contactAffiliationId: own,
			editVersion: before.editVersion,
			reason: 'Прежний контакт ушёл'
		});

		const after = await getInteraction(ctx, interactionId);

		expect(after.parties.find((row) => row.id === party.id)?.contactAffiliationId).toBe(own);
		expect(after.editVersion).toBe(before.editVersion + 1);

		const history = await database.db
			.select()
			.from(interactionChanges)
			.where(eq(interactionChanges.interactionId, interactionId));

		expect(history).toMatchObject([
			{ field: 'contact', oldValue: null, newValue: own, reason: 'Прежний контакт ушёл' }
		]);

		for (const rejected of [foreign, ended]) {
			await expect(
				changeInteractionContact(ctx, {
					interactionId,
					partyId: party.id,
					contactAffiliationId: rejected,
					editVersion: after.editVersion,
					reason: null
				})
			).rejects.toBeInstanceOf(ValidationError);
		}

		const unchanged = await getInteraction(ctx, interactionId);

		expect(unchanged.parties.find((row) => row.id === party.id)?.contactAffiliationId).toBe(own);
		expect(unchanged.editVersion).toBe(after.editVersion);
	});
});

describe('новый контакт из карточки', () => {
	it('заводит роль вуза стороны с периодом и делает её контактом, без права — отказ', async () => {
		const ctx = testActor({ roleId: 'manager' });
		await seedProcess(database, B2B_WORKSPACE_KEY, B2B_PROCESS);
		const { interactionId, organizationId } = await createInteractionOn(
			testActor({ roleId: 'admin' }),
			database
		);

		const before = await getInteraction(ctx, interactionId);
		const party = before.parties.find((row) => row.isPrimary);

		if (party === undefined) throw new Error('У записи нет основной стороны');

		const command = {
			interactionId,
			partyId: party.id,
			editVersion: before.editVersion,
			reason: 'Нашли ответственного',
			source: {
				kind: 'manual' as const,
				contact: {
					lastName: 'Новикова',
					firstName: 'Анна',
					middleName: null,
					email: 'a.novikova@vuz.example',
					phone: '+7 900 000-00-00',
					position: 'Проректор по учебной работе',
					roleKind: 'vice_rector' as const,
					validFrom: '2026-01-01',
					validTo: '2099-12-31'
				}
			}
		};

		const withoutPeople = testActor({
			roleId: 'manager',
			permissions: [...defaultRolePermissions('manager')].filter(
				(key) => key !== 'people.write'
			) as PermissionKey[]
		});

		await expect(createInteractionContact(withoutPeople, command)).rejects.toBeInstanceOf(
			ForbiddenError
		);
		expect(await database.db.select().from(people)).toHaveLength(0);

		const { affiliationId } = await createInteractionContact(ctx, command);

		const [role] = await database.db
			.select()
			.from(affiliations)
			.where(eq(affiliations.id, affiliationId));

		expect(role).toMatchObject({
			organizationId,
			position: 'Проректор по учебной работе',
			roleKind: 'vice_rector',
			validFrom: '2026-01-01',
			validTo: '2099-12-31'
		});

		const after = await getInteraction(ctx, interactionId);
		const updated = after.parties.find((row) => row.id === party.id);

		expect(updated?.contactAffiliationId).toBe(affiliationId);
		expect(updated?.contact).toMatchObject({
			lastName: 'Новикова',
			email: 'a.novikova@vuz.example'
		});
		expect(after.editVersion).toBe(before.editVersion + 1);

		const history = await database.db
			.select()
			.from(interactionChanges)
			.where(eq(interactionChanges.interactionId, interactionId));

		expect(history).toMatchObject([
			{ field: 'contact', oldValue: null, newValue: affiliationId, reason: 'Нашли ответственного' }
		]);
	});
});
