/**
 * Пакет документов дела с вузом и факт передачи по подписанному акту.
 *
 * Сборка идёт настоящей службой PDF (Gotenberg из compose) и настоящим
 * хранилищем: пакет — это три пары файлов, и проверяется, что они легли в
 * дело, а акт запомнил позиции договора, которые он передаёт.
 */
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInteractionSchema } from '$lib/contracts/interactions';
import {
	contractItems,
	contracts,
	documents,
	interactionContractItems,
	interactionParties,
	interactions,
	products
} from '$lib/server/db/schema';
import { readDocumentMark } from '$lib/server/documents/evidence';
import { generateDocumentPackage, readPackageDefaults } from '$lib/server/documents/package';
import { listDocumentRevisions } from '$lib/server/documents/read';
import { markDocument } from '$lib/server/documents/status';
import { uploadDocument, uploadDocumentRevision } from '$lib/server/documents/upload';
import { createInteraction } from '$lib/server/interactions/write';
import { B2B_PROCESS } from '$lib/server/stages/definitions';
import {
	ensureSchoolOperator,
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
			replaceApproved: [],
			city: 'Москва',
			operatorSigner: 'директор Школы Иванов И. И.',
			counterpartySigner: 'ректор Петров П. П.'
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

		// Следующая сборка подставит город и подписантов этой.
		expect(await readPackageDefaults(ctx, interaction.id)).toEqual({
			city: 'Москва',
			operatorSigner: 'директор Школы Иванов И. И.',
			counterpartySigner: 'ректор Петров П. П.'
		});

		// Акт, загруженный руками, стадию не закрывает даже с «Утверждён»: он не
		// собран по шаблону. Скан — новая редакция собранного акта — закрывает.
		const scan = { mime: 'application/pdf', bytes: new TextEncoder().encode('%PDF-1.4\n%scan') };
		const manual = await uploadDocument(ctx, {
			interactionId: interaction.id,
			kind: 'act',
			title: 'Акт, подписанный вузом',
			file: scan
		});
		await markDocument(ctx, manual.id, 'approved');
		const countedBefore = await readDocumentMark(
			database.db,
			interaction.id,
			'approved',
			'handover_act'
		);
		expect(countedBefore?.documentId).toBe(act.documentIds[1]);

		const signed = await uploadDocumentRevision(ctx, {
			supersedesId: act.documentIds[1],
			file: scan,
			note: 'Подписанный сторонами скан'
		});
		expect(signed.revisionNote).toBe('Подписанный сторонами скан');
		await markDocument(ctx, signed.id, 'approved');
		expect(
			(await readDocumentMark(database.db, interaction.id, 'approved', 'handover_act'))?.documentId
		).toBe(signed.id);
		expect(
			(await listDocumentRevisions(ctx, signed.id)).map((revision) => revision.revisionNote)
		).toEqual([null, 'Подписанный сторонами скан']);

		// Подписанная сублицензия — это подписанный договор: черновик договора
		// дела становится действующим.
		const sublicense = outcomes.find((outcome) => outcome.templateKey === 'sublicense');
		if (sublicense?.status !== 'generated') throw new Error('Сублицензия не собрана');
		await markDocument(ctx, sublicense.documentIds[1], 'approved');
		const [activated] = await database.db
			.select({ status: contracts.status })
			.from(contracts)
			.where(eq(contracts.id, contract.id));
		expect(activated.status).toBe('active');

		const actRevisions = async () =>
			database.db
				.select({ id: documents.id, supersedesId: documents.supersedesId })
				.from(documents)
				.where(
					and(
						eq(documents.interactionId, interaction.id),
						eq(documents.templateKey, 'handover_act')
					)
				);

		// Пакет по умолчанию подписанный акт не трогает: новая редакция поверх
		// утверждённой была бы уже неподписанной.
		const [kept] = await generateDocumentPackage(ctx, interaction.id, {
			templates: ['handover_act'],
			replaceApproved: [],
			city: 'Москва',
			operatorSigner: 'директор Школы Иванов И. И.',
			counterpartySigner: 'ректор Петров П. П.'
		});
		expect(kept.status).toBe('refused');
		expect(await actRevisions()).toHaveLength(3);

		// Пересборка с явным согласием — новая редакция цепочки, а не третий акт
		// рядом: подписанный скан уходит в историю, засчитанная стадией отметка
		// остаётся.
		const [rebuilt] = await generateDocumentPackage(ctx, interaction.id, {
			templates: ['handover_act'],
			replaceApproved: ['handover_act'],
			city: 'Москва',
			operatorSigner: 'директор Школы Иванов И. И.',
			counterpartySigner: 'ректор Петров П. П.'
		});
		if (rebuilt.status !== 'generated') throw new Error('Акт не пересобран');
		const acts = await actRevisions();
		expect(acts).toHaveLength(5);
		expect(acts.find((row) => row.id === rebuilt.documentIds[0])?.supersedesId).toBe(
			act.documentIds[0]
		);
		expect(acts.find((row) => row.id === rebuilt.documentIds[1])?.supersedesId).toBe(signed.id);
		expect(
			(await readDocumentMark(database.db, interaction.id, 'approved', 'handover_act'))?.documentId
		).toBe(signed.id);
	}, 120_000);

	it('отказ сборки называет сначала состав дела и ведёт к сторонам, потом поля формы', async () => {
		const ctx = testActor({ roleId: 'admin' });
		await seedProcess(database, B2B_WORKSPACE_KEY, B2B_PROCESS);

		const institutionId = await insertOrganization(database.db, {
			shortName: 'Технический университет',
			inn: '7701000001'
		});
		await ensureSchoolOperator(database.db);
		const interaction = await createInteraction(
			ctx,
			B2B_WORKSPACE_KEY,
			createInteractionSchema.parse({
				title: 'Без оператора',
				ownerUserId: TEST_USER_IDS.admin,
				agreementPeriodStart: '2026-09-01',
				agreementPeriodEnd: '2027-08-31',
				parties: [
					{ organizationId: institutionId, partyRole: 'educational_institution', isPrimary: true }
				]
			})
		);
		await ensureInteractionProgram(database, interaction.id);
		// Оператора из состава убрали — так выглядят и дела, заведённые до того,
		// как заведение дела стало ставить школу стороной само.
		await database.db
			.delete(interactionParties)
			.where(
				and(
					eq(interactionParties.interactionId, interaction.id),
					eq(interactionParties.partyRole, 'operator')
				)
			);

		const [outcome] = await generateDocumentPackage(ctx, interaction.id, {
			templates: ['agreement'],
			replaceApproved: [],
			city: null,
			operatorSigner: null,
			counterpartySigner: null
		});

		if (outcome.status !== 'refused') throw new Error('Соглашение без оператора собралось');
		expect(outcome.fixes).toEqual(['parties']);
		// Данные дела — раньше полей формы.
		const firstFormIssue = outcome.issues.findIndex((issue) => issue.includes('в форме сборки'));
		const operatorIssue = outcome.issues.findIndex((issue) => issue.includes('оператора стороной'));
		expect(operatorIssue).toBeGreaterThanOrEqual(0);
		expect(firstFormIssue).toBeGreaterThan(operatorIssue);
	}, 60_000);
});
