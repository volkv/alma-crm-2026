/**
 * Пакет документов дела с вузом и факт передачи по подписанному акту.
 *
 * Сборка идёт настоящей службой PDF (Gotenberg из compose) и настоящим
 * хранилищем: пакет — это три пары файлов, и проверяется, что они легли в
 * дело, а акт запомнил позиции договора, которые он передаёт.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInteractionSchema } from '$lib/contracts/interactions';
import {
	contractItems,
	contracts,
	documents,
	interactionContractItems,
	interactions,
	products
} from '$lib/server/db/schema';
import { generateDocumentPackage } from '$lib/server/documents/package';
import { markDocument } from '$lib/server/documents/status';
import { createInteraction } from '$lib/server/interactions/write';
import { B2B_PROCESS } from '$lib/server/stages/definitions';
import {
	insertOrganization,
	startTestDatabase,
	testActor,
	TEST_USER_IDS,
	type TestDatabase
} from '../helpers/db';
import { B2B_WORKSPACE_KEY, ensureInteractionProgram, seedProcess } from '../stages/fixture';

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

describe('пакет документов', () => {
	it('B2B собирает соглашение, сублицензию и акт; подписанный акт переводит позицию в «передан»', async () => {
		const ctx = testActor({ roleId: 'admin' });
		await seedProcess(database, B2B_WORKSPACE_KEY, B2B_PROCESS);

		const institutionId = await insertOrganization(database.db, {
			shortName: 'Технический университет',
			inn: '7701000001'
		});
		const operatorId = await insertOrganization(database.db, {
			shortName: 'Оператор обучения',
			kind: 'operator',
			inn: '7701000002'
		});
		const customerId = await insertOrganization(database.db, {
			shortName: 'Заказчик подготовки',
			kind: 'customer_company'
		});

		const interaction = await createInteraction(
			ctx,
			B2B_WORKSPACE_KEY,
			createInteractionSchema.parse({
				title: 'Подготовка разработчиков',
				ownerUserId: TEST_USER_IDS.admin,
				agreementPeriodStart: '2026-09-01',
				agreementPeriodEnd: '2027-08-31',
				parties: [
					{ organizationId: institutionId, partyRole: 'educational_institution', isPrimary: true },
					{ organizationId: customerId, partyRole: 'customer', isPrimary: false },
					{ organizationId: operatorId, partyRole: 'operator', isPrimary: false }
				]
			})
		);
		await ensureInteractionProgram(database, interaction.id);

		const [product] = await database.db
			.insert(products)
			.values({ code: 'LMS-1', name: 'Учебная платформа', status: 'active' })
			.returning({ id: products.id });
		const [contract] = await database.db
			.insert(contracts)
			.values({ organizationId: institutionId, number: 'СЛ-7', signedOn: '2026-09-10' })
			.returning({ id: contracts.id });
		const [item] = await database.db
			.insert(contractItems)
			.values({
				contractId: contract.id,
				productId: product.id,
				licenseUntil: '2027-08-31',
				transferStatus: 'ожидает передачи'
			})
			.returning({ id: contractItems.id });
		await database.db
			.update(interactions)
			.set({ contractId: contract.id })
			.where(eq(interactions.id, interaction.id));
		await database.db.insert(interactionContractItems).values({
			interactionId: interaction.id,
			contractItemId: item.id,
			contractId: contract.id
		});

		const outcomes = await generateDocumentPackage(ctx, interaction.id, {
			templates: ['agreement', 'sublicense', 'handover_act'],
			city: 'Москва',
			operatorSigner: 'директора Иванова И. И.',
			counterpartySigner: 'ректора Петрова П. П.'
		});

		expect(outcomes.map((outcome) => [outcome.templateKey, outcome.status])).toEqual([
			['agreement', 'generated'],
			['sublicense', 'generated'],
			['handover_act', 'generated']
		]);

		const files = await database.db
			.select({ id: documents.id })
			.from(documents)
			.where(eq(documents.interactionId, interaction.id));
		expect(files).toHaveLength(6);

		const act = outcomes.find((outcome) => outcome.templateKey === 'handover_act');
		if (act?.status !== 'generated') throw new Error('Акт не собран');

		// Подписанный экземпляр — отметка «Утверждён» на PDF акта.
		await markDocument(ctx, act.documentIds[1], 'approved');

		const [after] = await database.db
			.select({ transferStatus: contractItems.transferStatus })
			.from(contractItems)
			.where(eq(contractItems.id, item.id));
		expect(after.transferStatus).toBe('передан');
	}, 120_000);
});
