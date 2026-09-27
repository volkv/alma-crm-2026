/**
 * Физическое лицо, заведённое из формы дела: без основания обработки форма
 * отказывает, с ним — основание лежит записью у человека. Совпадение по почте
 * ищется только среди тех, кого автор видит: чужой клиент с той же почтой не
 * выдаётся ни отказом, ни подстановкой в дело, и назначение на него не
 * переходит к автору.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { individualCounterpartySchema } from '$lib/contracts/interactions';
import { consents, organizationResponsibles, organizations } from '$lib/server/db/schema';
import { createIndividualCounterparty } from '$lib/server/interactions/counterparty';
import { scopedActor, startTestDatabase, type TestDatabase } from '../helpers/db';

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

const PERSON = {
	lastName: 'Слушателева',
	firstName: 'Анна',
	middleName: null,
	email: 'anna@example.org',
	phone: null
};

describe('физическое лицо из формы дела', () => {
	it('без основания обработки не заводится, с ним — основание лежит у человека', async () => {
		expect(individualCounterpartySchema.safeParse(PERSON).success).toBe(false);
		expect(individualCounterpartySchema.safeParse({ ...PERSON, basis: '' }).success).toBe(false);
		expect(individualCounterpartySchema.safeParse({ ...PERSON, basis: 'legal' }).success).toBe(
			false
		);

		const author = await scopedActor(database.db, { organizationIds: [] });
		const created = await createIndividualCounterparty(author, { ...PERSON, basis: 'contract' });

		const [individual] = await database.db
			.select({ personId: organizations.personId })
			.from(organizations)
			.where(eq(organizations.id, created.option.id));

		if (individual.personId === null) throw new Error('У физлица нет человека');

		const recorded = await database.db
			.select({ basis: consents.basis, withdrawnAt: consents.withdrawnAt })
			.from(consents)
			.where(eq(consents.personId, individual.personId));

		expect(recorded).toEqual([{ basis: 'contract', withdrawnAt: null }]);
	});

	it('чужой клиент с той же почтой автору не виден: заводится новая запись', async () => {
		const owner = await scopedActor(database.db, { organizationIds: [] });
		const theirs = await createIndividualCounterparty(owner, { ...PERSON, basis: 'consent' });

		const stranger = await scopedActor(database.db, { organizationIds: [] });
		const mine = await createIndividualCounterparty(stranger, { ...PERSON, basis: 'contract' });

		expect(mine.option.id).not.toBe(theirs.option.id);

		// Назначение на чужого клиента осталось у его сотрудника.
		const responsibles = await database.db
			.select({ userId: organizationResponsibles.userId })
			.from(organizationResponsibles)
			.where(
				and(
					eq(organizationResponsibles.organizationId, theirs.option.id),
					isNull(organizationResponsibles.validTo)
				)
			);

		expect(responsibles).toEqual([{ userId: owner.user?.id }]);

		// Свой — находится, второй записи не появляется.
		const again = await createIndividualCounterparty(owner, { ...PERSON, basis: 'consent' });

		expect(again.option.id).toBe(theirs.option.id);
		expect(again.contactAffiliationId).toBe(theirs.contactAffiliationId);
	});
});
