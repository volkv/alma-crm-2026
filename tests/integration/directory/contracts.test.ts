/**
 * Договоры контрагента: от файла каталога до карточки взаимодействия.
 *
 * Дорога проверяется целиком, потому что на ней три владельца: импорт заводит
 * договор и его позиции, справочник их ведёт и отдаёт с областью доступа, а
 * взаимодействие выбирает договор и подмножество позиций. Расходятся такие
 * дороги не внутри модуля, а на стыке — там же, где стоит составной внешний
 * ключ «позиция принадлежит своему договору».
 */
import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { contractListQuerySchema, saveContractSchema } from '$lib/contracts/directory';
import { createInteractionSchema, updateInteractionSchema } from '$lib/contracts/interactions';
import type { ActorContext } from '$lib/server/actor';
import { auditEvents, organizations, products } from '$lib/server/db/schema';
import {
	getContract,
	listContracts,
	listOrganizationContracts,
	saveContract,
	saveContractItem
} from '$lib/server/directory/contracts';
import {
	applyCatalogMapping,
	confirmCatalogImport,
	createCatalogImport,
	getCatalogImportPreview,
	suggestCatalogMapping
} from '$lib/server/directory/import';
import { NotFoundError, ValidationError } from '$lib/server/errors';
import { getInteraction, listInteractionChanges } from '$lib/server/interactions/read';
import { createInteraction, updateInteraction } from '$lib/server/interactions/write';
import { B2B_GROUP_KEY, B2B_PROCESS } from '$lib/server/stages/definitions';
import { ensureProcess } from '$lib/server/stages/process';
import {
	insertOrganization,
	scopedActor,
	startTestDatabase,
	testActor,
	TEST_USER_IDS,
	type TestDatabase
} from '../helpers/db';

// См. комментарий в `helpers/db.ts`: без этого сервисы пойдут в базу разработчика.
vi.mock('$env/dynamic/private', () => ({ env: process.env }));

let database: TestDatabase;

const admin = (): ActorContext => testActor({ roleId: 'admin' });

beforeAll(async () => {
	database = await startTestDatabase();
}, 300_000);

afterAll(async () => {
	await database?.stop();
});

beforeEach(async () => {
	await database.reset();
});

/** Процесс учебных заведений: без него взаимодействие не завести. */
async function demoProcess(): Promise<string> {
	return database.db.transaction((tx) => ensureProcess(tx, B2B_GROUP_KEY, B2B_PROCESS));
}

/**
 * Загрузка рабочей таблицы заказчика теми же сервисами, что и мастер импорта:
 * файл, предложенное сопоставление, подтверждение.
 */
async function importCatalog(ctx: ActorContext): Promise<void> {
	const bytes = readFileSync(new URL('../../fixtures/catalog-sample.csv', import.meta.url));
	const created = await createCatalogImport(ctx, { file: { name: 'каталог.csv', bytes } });
	const shown = await getCatalogImportPreview(ctx, created.id);

	await applyCatalogMapping(ctx, created.id, suggestCatalogMapping(shown.headers));
	await confirmCatalogImport(ctx, created.id);
}

async function organizationId(shortName: string): Promise<string> {
	const [row] = await database.db
		.select({ id: organizations.id })
		.from(organizations)
		.where(eq(organizations.shortName, shortName))
		.limit(1);

	if (row === undefined) {
		throw new Error(`Организация «${shortName}» не завелась импортом`);
	}

	return row.id;
}

describe('импорт каталога заводит договоры', () => {
	it('кладёт договор с позицией и отдаёт их карточке контрагента', async () => {
		const ctx = admin();
		await importCatalog(ctx);

		const tgui = await organizationId('ТГУИ');
		const contracts = await listOrganizationContracts(ctx, tgui);

		expect(contracts).toHaveLength(1);
		expect(contracts[0].number).toBe('ДГ-2026-001');
		expect(contracts[0].signedOn).toBe('2026-09-10');
		// Подписанный договор действует: состояние импорт выводит из даты, потому
		// что о самом состоянии файл молчит.
		expect(contracts[0].status).toBe('active');
		expect(contracts[0].items).toHaveLength(1);
		expect(contracts[0].items[0].productName).toBe('Тренажёр сетевых лабораторий «Полигон»');
		expect(contracts[0].items[0].transferStatus).toBe('transferred');
	});
});

describe('взаимодействие по договору', () => {
	it('везёт договор и его позиции в карточку', async () => {
		const ctx = admin();
		await demoProcess();
		await importCatalog(ctx);

		const tgui = await organizationId('ТГУИ');
		const [contract] = await listOrganizationContracts(ctx, tgui);
		const item = contract.items[0];

		const created = await createInteraction(
			ctx,
			createInteractionSchema.parse({
				title: 'Поставка тренажёра сетевых лабораторий',
				ownerUserId: TEST_USER_IDS.admin,
				parties: [{ organizationId: tgui, partyRole: 'educational_institution', isPrimary: true }],
				productIds: [item.productId],
				contractId: contract.id,
				contractItemIds: [item.id]
			})
		);

		const view = await getInteraction(ctx, created.id);

		expect(view.contract?.number).toBe('ДГ-2026-001');
		expect(view.contract?.items).toHaveLength(1);
		// Коммерческие условия карточка берёт у позиции, а не у продукта: продукт
		// один и тот же у всех вузов, условия — свои у каждого договора.
		expect(view.contract?.items[0].transferStatus).toBe('transferred');
		expect(view.contract?.items[0].productId).toBe(item.productId);
	});

	it('отказывается брать позицию чужого договора', async () => {
		const ctx = admin();
		await demoProcess();
		await importCatalog(ctx);

		const tgui = await organizationId('ТГУИ');
		const ngtua = await organizationId('НГТУА');
		const [own] = await listOrganizationContracts(ctx, tgui);
		const [foreign] = await listOrganizationContracts(ctx, ngtua);

		await expect(
			createInteraction(
				ctx,
				createInteractionSchema.parse({
					title: 'Работа по чужой позиции',
					ownerUserId: TEST_USER_IDS.admin,
					parties: [
						{ organizationId: tgui, partyRole: 'educational_institution', isPrimary: true }
					],
					productIds: [foreign.items[0].productId],
					contractId: own.id,
					contractItemIds: [foreign.items[0].id]
				})
			)
		).rejects.toThrow('Позиция не принадлежит выбранному договору');
	});

	it('отказывается брать договор другого контрагента', async () => {
		const ctx = admin();
		await demoProcess();
		await importCatalog(ctx);

		const tgui = await organizationId('ТГУИ');
		const ngtua = await organizationId('НГТУА');
		const [foreign] = await listOrganizationContracts(ctx, ngtua);

		await expect(
			createInteraction(
				ctx,
				createInteractionSchema.parse({
					title: 'Работа по договору соседнего вуза',
					ownerUserId: TEST_USER_IDS.admin,
					parties: [
						{ organizationId: tgui, partyRole: 'educational_institution', isPrimary: true }
					],
					productIds: [foreign.items[0].productId],
					contractId: foreign.id,
					contractItemIds: []
				})
			)
		).rejects.toThrow('Договор заключён с другим контрагентом');
	});

	it('отказывается от позиции по продукту вне состава взаимодействия', async () => {
		const ctx = admin();
		await demoProcess();
		await importCatalog(ctx);

		const tgui = await organizationId('ТГУИ');
		const [contract] = await listOrganizationContracts(ctx, tgui);

		// Источник истины о составе — продукты взаимодействия; позиция добавляет к
		// продукту условия и состав не задаёт, поэтому такая пара — отказ словами,
		// а не тихо добавленный продукт.
		await expect(
			createInteraction(
				ctx,
				createInteractionSchema.parse({
					title: 'Позиция без продукта',
					ownerUserId: TEST_USER_IDS.admin,
					parties: [
						{ organizationId: tgui, partyRole: 'educational_institution', isPrimary: true }
					],
					productIds: [],
					contractId: contract.id,
					contractItemIds: [contract.items[0].id]
				})
			)
		).rejects.toThrow('Позиция договора описывает продукт вне состава взаимодействия');
	});
});

describe('правка договора у взаимодействия', () => {
	it('меняет выбор, пишет его в историю плана и умеет снять договор', async () => {
		const ctx = admin();
		await demoProcess();
		await importCatalog(ctx);

		const tgui = await organizationId('ТГУИ');
		const [contract] = await listOrganizationContracts(ctx, tgui);
		const item = contract.items[0];

		const created = await createInteraction(
			ctx,
			createInteractionSchema.parse({
				title: 'Правка договора',
				ownerUserId: TEST_USER_IDS.admin,
				parties: [{ organizationId: tgui, partyRole: 'educational_institution', isPrimary: true }],
				productIds: [item.productId]
			})
		);

		expect((await getInteraction(ctx, created.id)).contract).toBeNull();

		const base = {
			id: created.id,
			title: created.title,
			ownerUserId: created.ownerUserId,
			parties: [{ organizationId: tgui, partyRole: 'educational_institution', isPrimary: true }],
			productIds: [item.productId]
		};

		await updateInteraction(
			ctx,
			updateInteractionSchema.parse({
				...base,
				contractId: contract.id,
				contractItemIds: [item.id],
				reason: 'Подписали договор'
			})
		);

		const chosen = await getInteraction(ctx, created.id);

		expect(chosen.contract?.id).toBe(contract.id);
		expect(chosen.contract?.items.map((row) => row.id)).toEqual([item.id]);

		// Договор и позиции — решение, и в истории плана они названы номером и
		// продуктом, а не идентификаторами: по ним вопрос «почему другой договор»
		// и задают.
		const changes = await listInteractionChanges(ctx, created.id);
		const contractChange = changes.find((change) => change.field === 'contract');
		const itemsChange = changes.find((change) => change.field === 'contractItems');

		expect(contractChange?.newLabel).toBe('ДГ-2026-001');
		expect(contractChange?.reason).toBe('Подписали договор');
		expect(itemsChange?.newLabel).toBe('Тренажёр сетевых лабораторий «Полигон»');

		// Снятый договор уносит с собой и выбранные позиции: позиция без договора
		// ни к чему не относится.
		await updateInteraction(
			ctx,
			updateInteractionSchema.parse({ ...base, contractId: null, contractItemIds: [] })
		);

		expect((await getInteraction(ctx, created.id)).contract).toBeNull();
	});
});

describe('договор с карточки контрагента', () => {
	async function anyProduct(): Promise<string> {
		const [row] = await database.db
			.insert(products)
			.values({ code: 'PRD-FORM-01', name: 'Продукт формы', status: 'active' })
			.returning({ id: products.id });

		return row.id;
	}

	it('заводит договор и его позицию, а потом правит их', async () => {
		const ctx = admin();
		const organization = await insertOrganization(database.db, { shortName: 'СЗПУ' });
		const productId = await anyProduct();

		const created = await saveContract(
			ctx,
			saveContractSchema.parse({
				organizationId: organization,
				number: 'РТК-2026/77',
				signedOn: '2026-03-01',
				validUntil: '2027-02-28',
				status: 'active'
			})
		);

		expect(created.number).toBe('РТК-2026/77');
		expect(created.status).toBe('active');

		const withItem = await saveContractItem(ctx, {
			id: null,
			contractId: created.id,
			productId,
			licenseSignedAt: '2026-03-05',
			licenseUntil: '2027-03-04',
			transferStatus: 'передан вузу'
		});

		expect(withItem.items).toHaveLength(1);
		expect(withItem.items[0].transferStatus).toBe('передан вузу');

		// Правка присылает запись целиком, и очищенное поле очищается: правило
		// импорта «пустое ничего не стирает» к форме не относится.
		const closed = await saveContract(
			ctx,
			saveContractSchema.parse({
				id: created.id,
				organizationId: organization,
				number: 'РТК-2026/77-1',
				signedOn: '2026-03-01',
				validUntil: null,
				status: 'closed'
			})
		);

		expect(closed.number).toBe('РТК-2026/77-1');
		expect(closed.validUntil).toBeNull();
		expect(closed.status).toBe('closed');

		const edited = await saveContractItem(ctx, {
			id: withItem.items[0].id,
			contractId: created.id,
			productId,
			licenseSignedAt: '2026-03-05',
			licenseUntil: '2028-03-04',
			transferStatus: 'возвращён'
		});

		expect(edited.items[0].licenseUntil).toBe('2028-03-04');
		expect(edited.items[0].transferStatus).toBe('возвращён');

		const events = await database.db
			.select({ type: auditEvents.eventType })
			.from(auditEvents)
			.where(eq(auditEvents.subjectType, 'contract'));

		expect(events.map((event) => event.type)).toEqual(
			expect.arrayContaining(['directory.contract_created', 'directory.contract_updated'])
		);
	});

	it('не даёт подменить продукт уже заведённой позиции', async () => {
		const ctx = admin();
		const organization = await insertOrganization(database.db, { shortName: 'ПУПИ' });
		const productId = await anyProduct();

		const contract = await saveContract(
			ctx,
			saveContractSchema.parse({
				organizationId: organization,
				number: 'РТК-2026/78',
				status: 'draft'
			})
		);

		const withItem = await saveContractItem(ctx, {
			id: null,
			contractId: contract.id,
			productId,
			licenseSignedAt: null,
			licenseUntil: null,
			transferStatus: 'ожидает передачи'
		});

		const [other] = await database.db
			.insert(products)
			.values({ code: 'PRD-FORM-02', name: 'Другой продукт', status: 'active' })
			.returning({ id: products.id });

		await expect(
			saveContractItem(ctx, {
				id: withItem.items[0].id,
				contractId: contract.id,
				productId: other.id,
				licenseSignedAt: null,
				licenseUntil: null,
				transferStatus: 'ожидает передачи'
			})
		).rejects.toBeInstanceOf(ValidationError);
	});

	it('прячет договор чужого вуза от того, кто вуз не ведёт', async () => {
		const ctx = admin();
		const mine = await insertOrganization(database.db, { shortName: 'Мой вуз' });
		const foreign = await insertOrganization(database.db, { shortName: 'Чужой вуз' });

		const own = await saveContract(
			ctx,
			saveContractSchema.parse({ organizationId: mine, number: 'СВОЙ-1', status: 'draft' })
		);
		const hidden = await saveContract(
			ctx,
			saveContractSchema.parse({ organizationId: foreign, number: 'ЧУЖОЙ-1', status: 'draft' })
		);

		const manager = await scopedActor(database.db, { organizationIds: [mine] });

		// Список договоров сужается областью доступа так же, как список вузов:
		// чужой договор не показывается и по прямой ссылке неотличим от
		// несуществующего.
		const page = await listContracts(manager, contractListQuerySchema.parse({}));

		expect(page.items.map((contract) => contract.number)).toEqual(['СВОЙ-1']);
		expect(page.total).toBe(1);

		await expect(getContract(manager, own.id)).resolves.toMatchObject({ number: 'СВОЙ-1' });
		await expect(getContract(manager, hidden.id)).rejects.toBeInstanceOf(NotFoundError);
		await expect(listOrganizationContracts(manager, foreign)).resolves.toEqual([]);
	});
});
