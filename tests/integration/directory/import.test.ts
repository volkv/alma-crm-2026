/**
 * Импорт каталога на настоящей базе.
 *
 * Здесь проверяется то, чего не проверить на снимке в памяти: что применение
 * действительно кладёт организации, продукты, направления, договоры и позиции;
 * что оно идёт одной транзакцией; что повторная загрузка того же файла ничего
 * не меняет; и что ограничения базы (уникальность ИНН и кода, связь позиции с
 * договором, «строка с ошибкой ничего не записала») выполняются на живой схеме.
 */
import { readFileSync } from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatalogImportView } from '$lib/contracts/directory-import';
import {
	auditEvents,
	contractItems,
	contracts,
	directions,
	directoryImportRows,
	organizations,
	productDirections,
	products
} from '$lib/server/db/schema';
import {
	applyCatalogMapping,
	confirmCatalogImport,
	createCatalogImport,
	getCatalogImportPreview,
	listCatalogImportRows,
	rejectCatalogImport,
	suggestCatalogMapping
} from '$lib/server/directory/import';
import { ConflictError, ForbiddenError } from '$lib/server/errors';
import { insertOrganization, scopedActor, startTestDatabase, testActor } from '../helpers/db';
import type { TestDatabase } from '../helpers/db';

// См. комментарий в `helpers/db.ts`: без этого сервисы пойдут в базу разработчика.
vi.mock('$env/dynamic/private', () => ({ env: process.env }));

let database: TestDatabase;

/** Та же выгрузка тремя файлами: они обязаны дать один и тот же результат. */
function fixture(name: string): Uint8Array {
	return readFileSync(new URL(`../../fixtures/${name}`, import.meta.url));
}

const SZPU_INN = '7802450127';
const PUPI_INN = '5203660080';

type Catalog = { szpu: string; pupi: string; lms: string; analytics: string };

/**
 * Справочник, каким он стоит до загрузки: два вуза, два продукта, направление и
 * два договора с позициями. Ровно на них и ссылается файл каталога.
 */
async function seedCatalog(): Promise<Catalog> {
	const szpu = await insertOrganization(database.db, { shortName: 'СЗПУ', inn: SZPU_INN });
	const pupi = await insertOrganization(database.db, { shortName: 'ПУПИ', inn: PUPI_INN });

	const productRows = await database.db
		.insert(products)
		.values([
			{ code: 'PRD-LMS-01', name: 'Платформа учебных курсов «Ориентир»', status: 'active' },
			{ code: 'PRD-ANL-02', name: 'Аналитический модуль «Радар»', status: 'active' }
		])
		.returning({ id: products.id, code: products.code });

	const byCode = new Map(productRows.map((row) => [row.code, row.id]));
	const lms = byCode.get('PRD-LMS-01') as string;
	const analytics = byCode.get('PRD-ANL-02') as string;

	await database.db.insert(directions).values({ code: 'DEV', name: 'Разработка', position: 1 });

	const contractRows = await database.db
		.insert(contracts)
		.values([
			{
				organizationId: szpu,
				number: 'РТК-2026-0142',
				signedOn: '2026-08-20',
				validUntil: '2027-08-31',
				status: 'active'
			},
			{
				organizationId: pupi,
				number: 'РТК-2026-0187',
				signedOn: '2026-09-01',
				validUntil: '2027-06-30',
				status: 'active'
			}
		])
		.returning({ id: contracts.id, number: contracts.number });

	const contractByNumber = new Map(contractRows.map((row) => [row.number, row.id]));

	await database.db.insert(contractItems).values([
		{
			contractId: contractByNumber.get('РТК-2026-0142') as string,
			productId: lms,
			licenseSignedAt: '2026-08-20',
			licenseUntil: '2027-08-31',
			transferStatus: 'transferred'
		},
		{
			contractId: contractByNumber.get('РТК-2026-0142') as string,
			productId: analytics,
			licenseSignedAt: '2026-08-20',
			licenseUntil: '2027-08-31',
			transferStatus: 'transferred'
		},
		{
			contractId: contractByNumber.get('РТК-2026-0187') as string,
			productId: analytics,
			licenseSignedAt: '2026-09-01',
			licenseUntil: '2027-06-30',
			transferStatus: 'pending'
		},
		{
			contractId: contractByNumber.get('РТК-2026-0187') as string,
			productId: lms,
			licenseSignedAt: '2026-09-01',
			licenseUntil: '2027-06-30',
			transferStatus: 'transferred'
		}
	]);

	return { szpu, pupi, lms, analytics };
}

/** Путь до предпросмотра: файл, предложенное сопоставление, разбор. */
async function preview(
	ctx: ReturnType<typeof testActor>,
	bytes: Uint8Array,
	name = 'каталог.csv'
): Promise<CatalogImportView> {
	const created = await createCatalogImport(ctx, { file: { name, bytes } });
	const shown = await getCatalogImportPreview(ctx, created.id);

	return applyCatalogMapping(ctx, created.id, suggestCatalogMapping(shown.headers));
}

const COUNTS = (record: CatalogImportView) => ({
	rowCount: record.rowCount,
	createCount: record.createCount,
	updateCount: record.updateCount,
	unchangedCount: record.unchangedCount,
	errorCount: record.errorCount
});

beforeAll(async () => {
	database = await startTestDatabase();
}, 300_000);

afterAll(async () => {
	await database?.stop();
});

beforeEach(async () => {
	await database.reset();
});

describe('предпросмотр импорта каталога', () => {
	it('читает csv в windows-1251 и раскладывает десять строк по действиям', async () => {
		await seedCatalog();

		const ctx = testActor();
		const created = await createCatalogImport(ctx, {
			file: { name: 'каталог.csv', bytes: fixture('catalog-sample.csv') }
		});
		const shown = await getCatalogImportPreview(ctx, created.id);

		// Кодировка и разделитель читаются из самого файла: русский Excel пишет
		// именно так, и мастер обязан сказать, чем он счёл файл.
		expect(shown.file.encoding).toBe('windows-1251');
		expect(shown.file.delimiter).toBe(';');
		expect(shown.totalRows).toBe(10);
		expect(shown.advice['Название ВУЗа']).toBe('organization');

		const record = await applyCatalogMapping(ctx, created.id, suggestCatalogMapping(shown.headers));

		expect(COUNTS(record)).toEqual({
			rowCount: 10,
			createCount: 3,
			updateCount: 2,
			unchangedCount: 4,
			errorCount: 1
		});
	});

	it('до подтверждения ничего не записывает', async () => {
		const catalog = await seedCatalog();

		await preview(testActor(), fixture('catalog-sample.csv'));

		const licenses = await database.db
			.select({ licenseUntil: contractItems.licenseUntil })
			.from(contractItems)
			.where(eq(contractItems.productId, catalog.lms));

		// В базе по-прежнему два вуза набора, и срок лицензии прежний.
		expect(await database.db.select().from(organizations)).toHaveLength(2);
		expect(licenses.map((row) => row.licenseUntil)).not.toContain('2028-12-31');
	});

	it('называет по каждой строке, что именно поменяется', async () => {
		await seedCatalog();

		const ctx = testActor();
		const record = await preview(ctx, fixture('catalog-sample.csv'));
		const page = await listCatalogImportRows(ctx, record.id, {
			action: 'update',
			page: 1,
			pageSize: 50
		});

		expect(page.items).toHaveLength(2);
		expect(page.items[0].changes).toEqual([
			{
				target: 'contractItem',
				subject: 'РТК-2026-0142 · Платформа учебных курсов «Ориентир»',
				field: 'Срок действия лицензии',
				from: '2027-08-31',
				to: '2028-12-31'
			}
		]);

		const failed = await listCatalogImportRows(ctx, record.id, {
			action: 'error',
			page: 1,
			pageSize: 50
		});

		expect(failed.items).toHaveLength(1);
		expect(failed.items[0].issues[0].message).toContain('Лицензия действует до');
	});

	it('читает книгу XLSX и JSON с теми же числами, что и таблицу', async () => {
		for (const [name, file] of [
			['каталог.xlsx', 'catalog-sample.xlsx'],
			['каталог.json', 'catalog-sample.json']
		] as const) {
			await database.reset();
			await seedCatalog();

			const record = await preview(testActor(), fixture(file), name);

			expect(COUNTS(record)).toEqual({
				rowCount: 10,
				createCount: 3,
				updateCount: 2,
				unchangedCount: 4,
				errorCount: 1
			});
		}
	});
});

describe('применение импорта каталога', () => {
	it('заводит недостающее, обновляет сроки и не трогает строки с ошибками', async () => {
		const catalog = await seedCatalog();
		const ctx = testActor();
		const record = await preview(ctx, fixture('catalog-sample.csv'));
		const applied = await confirmCatalogImport(ctx, record.id);

		expect(applied.status).toBe('confirmed');
		expect(COUNTS(applied)).toEqual({
			rowCount: 10,
			createCount: 3,
			updateCount: 2,
			unchangedCount: 4,
			errorCount: 1
		});

		// Три новых вуза встали рядом с двумя прежними; вуз из строки с ошибкой не
		// завёлся: строка с претензией ничего не записывает.
		const organizationNames = (
			await database.db.select({ shortName: organizations.shortName }).from(organizations)
		).map((row) => row.shortName);

		expect(organizationNames).toEqual(
			expect.arrayContaining(['СЗПУ', 'ПУПИ', 'ТГУИ', 'НГТУА', 'ВКПИ'])
		);
		expect(organizationNames).not.toContain('ЮТИМ');

		// Вендор заведён компанией-заказчиком: основной стороной процесса он не бывает.
		const [vendor] = await database.db
			.select({ kind: organizations.kind })
			.from(organizations)
			.where(eq(organizations.shortName, 'ТехноСфера Софт'));

		expect(vendor.kind).toBe('customer_company');

		// Продукт без кода в файле получил код из своего названия.
		const [polygon] = await database.db
			.select({ code: products.code, vendorOrganizationId: products.vendorOrganizationId })
			.from(products)
			.where(eq(products.name, 'Тренажёр сетевых лабораторий «Полигон»'));

		expect(polygon.code).toBe('TRENAZHER-SETEVYH-LABORATORIY-POLIGON');
		expect(polygon.vendorOrganizationId).not.toBeNull();

		// Направление, которого в справочнике не было, заведено и связано с продуктом.
		const [quantum] = await database.db
			.select({ id: directions.id })
			.from(directions)
			.where(eq(directions.name, 'Квантовые вычисления'));

		expect(quantum).toBeDefined();
		expect(
			await database.db
				.select()
				.from(productDirections)
				.where(eq(productDirections.directionId, quantum.id))
		).toHaveLength(1);

		// Срок лицензии продлён у обоих вузов, а прежняя позиция с тем же сроком
		// осталась нетронутой.
		const [prolonged] = await database.db
			.select({ licenseUntil: contractItems.licenseUntil })
			.from(contractItems)
			.innerJoin(contracts, eq(contracts.id, contractItems.contractId))
			.where(
				and(eq(contracts.organizationId, catalog.szpu), eq(contractItems.productId, catalog.lms))
			);

		expect(prolonged.licenseUntil).toBe('2028-12-31');

		const [untouched] = await database.db
			.select({ licenseUntil: contractItems.licenseUntil })
			.from(contractItems)
			.innerJoin(contracts, eq(contracts.id, contractItems.contractId))
			.where(
				and(
					eq(contracts.organizationId, catalog.szpu),
					eq(contractItems.productId, catalog.analytics)
				)
			);

		expect(untouched.licenseUntil).toBe('2027-08-31');
	});

	it('повторная загрузка того же файла не меняет ничего', async () => {
		await seedCatalog();

		const ctx = testActor();
		const first = await preview(ctx, fixture('catalog-sample.csv'));
		await confirmCatalogImport(ctx, first.id);

		const second = await preview(ctx, fixture('catalog-sample.csv'));

		// Предпросмотр повтора: всё, кроме строки с ошибкой, уже описано.
		expect(COUNTS(second)).toEqual({
			rowCount: 10,
			createCount: 0,
			updateCount: 0,
			unchangedCount: 9,
			errorCount: 1
		});

		const applied = await confirmCatalogImport(ctx, second.id);

		expect(COUNTS(applied)).toEqual({
			rowCount: 10,
			createCount: 0,
			updateCount: 0,
			unchangedCount: 9,
			errorCount: 1
		});

		// Ни одного дубля: организаций столько же, сколько после первой загрузки —
		// два вуза набора, три заведённых файлом и два вендора.
		expect(await database.db.select().from(organizations)).toHaveLength(7);
		expect(await database.db.select().from(contracts)).toHaveLength(5);
		expect(await database.db.select().from(products)).toHaveLength(4);
	});

	it('связывает строки с заведёнными записями', async () => {
		await seedCatalog();

		const ctx = testActor();
		const record = await preview(ctx, fixture('catalog-sample.csv'));
		await confirmCatalogImport(ctx, record.id);

		const rows = await database.db
			.select()
			.from(directoryImportRows)
			.where(eq(directoryImportRows.importId, record.id))
			.orderBy(directoryImportRows.rowNo);

		// У применённой строки есть ссылки на записи справочника: по ним видно,
		// откуда в каталоге взялась эта позиция.
		expect(rows[0].organizationId).not.toBeNull();
		expect(rows[0].contractItemId).not.toBeNull();
		// У строки с ошибкой ссылок нет — она ничего не записала.
		expect(rows[6].action).toBe('error');
		expect(rows[6].organizationId).toBeNull();
	});

	it('записывает применение в журнал числами строк', async () => {
		await seedCatalog();

		const ctx = testActor();
		const record = await preview(ctx, fixture('catalog-sample.csv'));
		await confirmCatalogImport(ctx, record.id);

		const [event] = await database.db
			.select()
			.from(auditEvents)
			.where(eq(auditEvents.eventType, 'directory.import_confirmed'));

		expect(event.details).toMatchObject({
			rowCount: 10,
			createCount: 3,
			updateCount: 2,
			unchangedCount: 4,
			errorCount: 1
		});

		// Заведение вуза и продукта пишется своими событиями: импорт не прячет
		// появление записей справочника за собственным кодом.
		const types = (await database.db.select({ type: auditEvents.eventType }).from(auditEvents)).map(
			(row) => row.type
		);

		expect(types).toContain('organizations.created');
		expect(types).toContain('products.created');
		expect(types).toContain('directions.created');
		expect(types).toContain('directory.import_created');
	});

	it('не применяется дважды', async () => {
		await seedCatalog();

		const ctx = testActor();
		const record = await preview(ctx, fixture('catalog-sample.csv'));
		await confirmCatalogImport(ctx, record.id);

		await expect(confirmCatalogImport(ctx, record.id)).rejects.toBeInstanceOf(ConflictError);
	});

	it('отклонённая загрузка остаётся со строками и причиной', async () => {
		await seedCatalog();

		const ctx = testActor();
		const record = await preview(ctx, fixture('catalog-sample.csv'));
		const rejected = await rejectCatalogImport(ctx, record.id, 'Прислали прошлогоднюю таблицу');

		expect(rejected.status).toBe('rejected');
		expect(rejected.note).toBe('Прислали прошлогоднюю таблицу');
		expect(await database.db.select().from(organizations)).toHaveLength(2);
		expect(
			await database.db
				.select()
				.from(directoryImportRows)
				.where(eq(directoryImportRows.importId, record.id))
		).toHaveLength(10);
	});
});

describe('право на импорт каталога', () => {
	it('у менеджера его нет, и отказ попадает в журнал', async () => {
		await expect(
			createCatalogImport(testActor({ roleId: 'manager' }), {
				file: { name: 'каталог.csv', bytes: fixture('catalog-sample.csv') }
			})
		).rejects.toBeInstanceOf(ForbiddenError);

		const [denied] = await database.db
			.select({ outcome: auditEvents.outcome })
			.from(auditEvents)
			.where(eq(auditEvents.eventType, 'directory.import_created'));

		expect(denied.outcome).toBe('denied');
	});

	it('руководитель заводит продукт с вендором, которого он не ведёт', async () => {
		// Вендор — ссылка внутри общего справочника продуктов, а не предмет работы:
		// ответственного ему не назначают никогда, и в чью-то область он не
		// попадает вовсе. Строка про такого вендора обязана проходить, иначе
		// руководитель не записал бы ни одного продукта с правообладателем.
		const catalog = await seedCatalog();
		const vendor = await insertOrganization(database.db, {
			shortName: 'ТехноСфера Софт',
			kind: 'customer_company'
		});
		const lead = await scopedActor(database.db, {
			roleId: 'lead',
			organizationIds: [catalog.szpu, catalog.pupi]
		});

		const record = await preview(lead, fixture('catalog-sample.csv'));
		await confirmCatalogImport(lead, record.id);

		const [polygon] = await database.db
			.select({ vendorOrganizationId: products.vendorOrganizationId })
			.from(products)
			.where(eq(products.name, 'Тренажёр сетевых лабораторий «Полигон»'));

		expect(polygon.vendorOrganizationId).toBe(vendor);
	});

	it('руководитель не применяет строку про вуз вне своей области', async () => {
		const catalog = await seedCatalog();
		// Руководителю отдан только один из двух вузов файла: второй для него
		// «ведётся вне области доступа», и строка про него отказывает словами, а не
		// заводит двойника мимо уникального ИНН.
		const lead = await scopedActor(database.db, {
			roleId: 'lead',
			organizationIds: [catalog.szpu]
		});

		const record = await preview(lead, fixture('catalog-sample.csv'));
		const failed = await listCatalogImportRows(lead, record.id, {
			action: 'error',
			page: 1,
			pageSize: 50
		});

		const messages = failed.items.flatMap((row) => row.issues.map((issue) => issue.message));

		expect(messages.some((message) => message.includes('вне вашей области доступа'))).toBe(true);
		expect(record.errorCount).toBeGreaterThan(1);
	});
});
