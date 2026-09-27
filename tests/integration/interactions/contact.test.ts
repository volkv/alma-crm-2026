/**
 * Смена контактного лица из карточки: новый контакт ложится в сторону и в
 * историю с причиной, а роль чужой организации или закончившаяся роль —
 * отказ, после которого ничего не записано.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { affiliations, interactionChanges } from '$lib/server/db/schema';
import { ValidationError } from '$lib/server/errors';
import { changeInteractionContact } from '$lib/server/interactions/contact';
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
