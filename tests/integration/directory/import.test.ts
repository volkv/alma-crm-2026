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
import { and, count, eq, isNull } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOrganizationSchema, organizationListQuerySchema } from '$lib/contracts/directory';
import type { CatalogImportView } from '$lib/contracts/directory-import';
import {
	affiliations,
	auditEvents,
	consents,
	contractItems,
	contracts,
	directions,
	directoryImportRows,
	organizationResponsibles,
	organizations,
	people,
	productContacts,
	productDirections,
	products
} from '$lib/server/db/schema';
import {
	applyCatalogMapping,
	confirmCatalogImport,
	createCatalogImport,
	getCatalogImport,
	getCatalogImportPreview,
	listCatalogImports,
	listCatalogImportRows,
	rejectCatalogImport,
	suggestCatalogMapping
} from '$lib/server/directory/import';
import { listOrganizations, listProductContacts } from '$lib/server/directory/read';
import { assignResponsible } from '$lib/server/directory/responsibles';
import { suggestVendorMapping } from '$lib/server/directory/vendor-import';
import { createOrganization } from '$lib/server/directory/write';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '$lib/server/errors';
import { decryptContacts } from '$lib/server/people/pii';
import {
	allWorkspaceIds,
	insertOrganization,
	insertUser,
	scopedActor,
	startTestDatabase,
	testActor
} from '../helpers/db';
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

		// Вендор заведён своим видом — правообладатель ПО, а не плательщик рядом с вузом.
		const [vendor] = await database.db
			.select({ kind: organizations.kind })
			.from(organizations)
			.where(eq(organizations.shortName, 'ТехноСфера Софт'));

		expect(vendor.kind).toBe('vendor');

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

describe('видимость загрузки каталога', () => {
	/** Загрузка целиком: автор — руководитель, которому отданы оба вуза файла. */
	async function appliedByLead(): Promise<{
		catalog: Catalog;
		author: ReturnType<typeof testActor>;
		importId: string;
	}> {
		const catalog = await seedCatalog();

		// Вендоров файла заранее завёл администратор: руководитель новых не заводит.
		for (const shortName of ['ТехноСфера Софт', 'Ладога Датасистемс', 'Полярный код']) {
			await insertOrganization(database.db, { shortName, kind: 'vendor' });
		}

		const author = await scopedActor(database.db, {
			roleId: 'lead',
			organizationIds: [catalog.szpu, catalog.pupi]
		});

		const record = await preview(author, fixture('catalog-sample.csv'));
		await confirmCatalogImport(author, record.id);

		return { catalog, author, importId: record.id };
	}

	it('автор видит свою загрузку целиком, вместе со строками файла', async () => {
		const { author, importId } = await appliedByLead();

		expect((await listCatalogImports(author)).map((item) => item.id)).toEqual([importId]);
		expect((await getCatalogImport(author, importId)).status).toBe('confirmed');

		const rows = await listCatalogImportRows(author, importId, {
			action: null,
			page: 1,
			pageSize: 50
		});

		expect(rows.total).toBe(10);
		// Строка файла как есть — у того, кто файл принёс.
		expect(rows.items[0].raw).not.toBeNull();
		expect(Object.keys(rows.items[0].raw ?? {})).toContain('Название ВУЗа');
	});

	it('руководитель вуза из файла видит список и итоги, но не строки файла', async () => {
		const { catalog, importId } = await appliedByLead();

		// Вуз файла передан другому руководителю: загрузка попадает в его область
		// затронутой организацией, а не авторством.
		const reader = await scopedActor(database.db, {
			roleId: 'lead',
			organizationIds: [catalog.szpu]
		});

		const list = await listCatalogImports(reader);

		expect(list.map((item) => item.id)).toEqual([importId]);
		expect(list[0].rowCount).toBe(10);
		expect((await getCatalogImport(reader, importId)).createCount).toBe(3);

		const rows = await listCatalogImportRows(reader, importId, {
			action: null,
			page: 1,
			pageSize: 50
		});

		// Итоги построчно видны — что именно загрузка сделала со справочником;
		// исходные ячейки файла закрыты: в них колонки, которые импорт не переносит.
		expect(rows.total).toBe(10);
		expect(rows.items[0].organizationName).not.toBeNull();
		expect(rows.items.every((row) => row.raw === null)).toBe(true);

		// Предпросмотр — это тот же файл, только шапкой и первыми строками.
		await expect(getCatalogImportPreview(reader, importId)).rejects.toBeInstanceOf(ForbiddenError);
	});

	it('вне области загрузки нет вовсе: ни в списке, ни по прямой ссылке', async () => {
		const { importId } = await appliedByLead();

		const stranger = await scopedActor(database.db, {
			roleId: 'manager',
			permissions: ['directory.import', 'organizations.read'],
			organizationIds: [await insertOrganization(database.db, { shortName: 'Чужой вуз' })]
		});

		expect(await listCatalogImports(stranger)).toEqual([]);
		// Чужая запись отвечает «не найдено», а не отказом: иначе перебором
		// идентификаторов видно, что существует за пределами области.
		await expect(getCatalogImport(stranger, importId)).rejects.toBeInstanceOf(NotFoundError);
		await expect(
			listCatalogImportRows(stranger, importId, { action: null, page: 1, pageSize: 50 })
		).rejects.toBeInstanceOf(NotFoundError);
		await expect(getCatalogImportPreview(stranger, importId)).rejects.toBeInstanceOf(NotFoundError);
		await expect(confirmCatalogImport(stranger, importId)).rejects.toBeInstanceOf(NotFoundError);
	});

	it('неприменённая загрузка не видна никому, кроме автора и полного доступа', async () => {
		const catalog = await seedCatalog();
		const author = await scopedActor(database.db, {
			roleId: 'lead',
			organizationIds: [catalog.szpu, catalog.pupi]
		});

		const record = await preview(author, fixture('catalog-sample.csv'));

		// Ссылки на записи справочника проставляет подтверждение, поэтому у
		// неприменённой загрузки затронутых организаций нет: делить её не с кем.
		const reader = await scopedActor(database.db, {
			roleId: 'lead',
			organizationIds: [catalog.szpu]
		});

		expect(await listCatalogImports(reader)).toEqual([]);
		await expect(getCatalogImport(reader, record.id)).rejects.toBeInstanceOf(NotFoundError);
		expect((await getCatalogImport(author, record.id)).status).toBe('mapped');
	});

	it('полный доступ видит и загрузку, и строки файла', async () => {
		const { importId } = await appliedByLead();
		const admin = testActor();

		expect((await listCatalogImports(admin)).map((item) => item.id)).toEqual([importId]);

		const rows = await listCatalogImportRows(admin, importId, {
			action: null,
			page: 1,
			pageSize: 50
		});

		expect(rows.items[0].raw).not.toBeNull();
		expect((await getCatalogImportPreview(admin, importId)).totalRows).toBe(10);
	});
});

describe('менеджер, контакты и комментарий строки', () => {
	/** Сотрудники оператора, которых называет колонка менеджера файла. */
	async function seedStaff(): Promise<{ veresova: string; zotov: string }> {
		const veresova = await insertUser(database.db, {
			roleId: 'manager',
			fullName: 'Вересова Анна Сергеевна'
		});
		const zotov = await insertUser(database.db, {
			roleId: 'manager',
			fullName: 'Зотов Павел Игоревич'
		});

		// Однофамилец с теми же инициалами: под «Зотов П. И.» строка обязана
		// отказать, а не выбрать одного из двух наугад.
		await insertUser(database.db, { roleId: 'manager', fullName: 'Зотов Пётр Ильич' });

		return { veresova, zotov };
	}

	/** Действующий ответственный вуза целиком. */
	async function generalResponsible(organizationId: string): Promise<string | null> {
		const [row] = await database.db
			.select({ userId: organizationResponsibles.userId })
			.from(organizationResponsibles)
			.where(
				and(
					eq(organizationResponsibles.organizationId, organizationId),
					isNull(organizationResponsibles.validTo),
					isNull(organizationResponsibles.directionId)
				)
			);

		return row?.userId ?? null;
	}

	/** Претензии строк, которые импорт не применил. */
	async function issuesOf(ctx: ReturnType<typeof testActor>, importId: string): Promise<string[]> {
		const failed = await listCatalogImportRows(ctx, importId, {
			action: 'error',
			page: 1,
			pageSize: 50
		});

		return failed.items.flatMap((row) => row.issues.map((issue) => issue.message));
	}

	it('раскладывает три колонки по действиям и считает их одинаково до и после', async () => {
		await seedCatalog();
		await seedStaff();

		const ctx = testActor();
		const record = await preview(ctx, fixture('catalog-people.csv'), 'таблица.csv');

		expect(COUNTS(record)).toEqual({
			rowCount: 7,
			createCount: 3,
			updateCount: 0,
			unchangedCount: 1,
			errorCount: 3
		});

		const applied = await confirmCatalogImport(ctx, record.id);

		expect(COUNTS(applied)).toEqual(COUNTS(record));
	});

	it('назначает ответственного по ФИО и по фамилии с инициалами', async () => {
		const catalog = await seedCatalog();
		const staff = await seedStaff();

		const ctx = testActor();
		const record = await preview(ctx, fixture('catalog-people.csv'), 'таблица.csv');
		await confirmCatalogImport(ctx, record.id);

		expect(await generalResponsible(catalog.szpu)).toBe(staff.veresova);
		// «Вересова А.С.» — тот же человек: ключ «фамилия и инициалы».
		expect(await generalResponsible(catalog.pupi)).toBe(staff.veresova);

		// Новый вуз достаётся названному в файле, а не тому, кто нажал кнопку.
		const [created] = await database.db
			.select({ id: organizations.id })
			.from(organizations)
			.where(eq(organizations.shortName, 'ТГУИ'));

		expect(await generalResponsible(created.id)).toBe(staff.zotov);

		// Назначение записано историей, а не подменой строки: у прежней есть конец.
		const history = await database.db
			.select({
				userId: organizationResponsibles.userId,
				validTo: organizationResponsibles.validTo
			})
			.from(organizationResponsibles)
			.where(eq(organizationResponsibles.organizationId, created.id));

		expect(history).toHaveLength(2);
		expect(history.filter((row) => row.validTo === null)).toHaveLength(1);
	});

	it('не заменяет чужое назначение и отказывает на однофамильцах', async () => {
		await seedCatalog();
		await seedStaff();

		const ctx = testActor();
		const record = await preview(ctx, fixture('catalog-people.csv'), 'таблица.csv');
		const messages = await issuesOf(ctx, record.id);

		expect(messages.some((message) => message.includes('уже отвечает другой сотрудник'))).toBe(
			true
		);
		expect(messages.some((message) => message.includes('подходит несколько сотрудников'))).toBe(
			true
		);
	});

	it('заводит контакт вуза с ролью, согласием и сроком полномочий', async () => {
		const catalog = await seedCatalog();
		await seedStaff();

		const ctx = testActor();
		const record = await preview(ctx, fixture('catalog-people.csv'), 'таблица.csv');
		await confirmCatalogImport(ctx, record.id);

		const [contact] = await database.db
			.select({
				personId: people.id,
				person: people,
				position: affiliations.position,
				roleKind: affiliations.roleKind,
				validTo: affiliations.validTo
			})
			.from(affiliations)
			.innerJoin(people, eq(people.id, affiliations.personId))
			.where(and(eq(affiliations.organizationId, catalog.szpu), eq(people.lastName, 'Иванова')));

		// Контакты лежат шифртекстом: из файла они приезжают открытыми, а в базу
		// ложатся через `people/pii.ts`, и прочитать их можно только ключом.
		const contacts = decryptContacts(contact.person);

		expect(contacts.email).toBe('m.ivanova@szpu.ru');
		expect(contacts.phone).toBe('+7 (999) 123-45-67');
		expect(contact.roleKind).toBe('other');
		expect(contact.validTo).toBeNull();

		// Основание обработки записано вместе с человеком: контакт из рабочей
		// таблицы лежит по договору с вузом, а не по согласию, которого никто не
		// собирал.
		const [consent] = await database.db
			.select({ basis: consents.basis })
			.from(consents)
			.where(eq(consents.personId, contact.personId));

		expect(consent.basis).toBe('contract');
	});

	it('не заводит того же человека дважды и называет неразобранный кусок', async () => {
		const catalog = await seedCatalog();
		await seedStaff();

		const ctx = testActor();
		const record = await preview(ctx, fixture('catalog-people.csv'), 'таблица.csv');
		await confirmCatalogImport(ctx, record.id);

		// Иванова названа в двух строках — полным ФИО и инициалами с той же почтой.
		expect(
			await database.db
				.select({ id: people.id })
				.from(affiliations)
				.innerJoin(people, eq(people.id, affiliations.personId))
				.where(and(eq(affiliations.organizationId, catalog.szpu), eq(people.lastName, 'Иванова')))
		).toHaveLength(1);

		const messages = await issuesOf(ctx, record.id);

		expect(messages.some((message) => message.includes('приёмная'))).toBe(true);
	});

	it('дописывает комментарий в примечание вуза, не затирая прежнее', async () => {
		const catalog = await seedCatalog();
		await seedStaff();

		await database.db
			.update(organizations)
			.set({ notes: 'Договор продлевали в августе' })
			.where(eq(organizations.id, catalog.szpu));

		const ctx = testActor();
		const record = await preview(ctx, fixture('catalog-people.csv'), 'таблица.csv');
		await confirmCatalogImport(ctx, record.id);

		const [organization] = await database.db
			.select({ notes: organizations.notes })
			.from(organizations)
			.where(eq(organizations.id, catalog.szpu));

		// Прежняя заметка на месте, комментарий дописан один раз: вторая строка
		// файла говорит то же самое и ничего не меняет.
		expect(organization.notes).toBe('Договор продлевали в августе\nЖдут смету на 2027 год');
	});

	it('повторная загрузка того же файла ничего не меняет', async () => {
		await seedCatalog();
		await seedStaff();

		const ctx = testActor();
		const first = await preview(ctx, fixture('catalog-people.csv'), 'таблица.csv');
		await confirmCatalogImport(ctx, first.id);

		const peopleAfterFirst = await database.db.select({ id: people.id }).from(people);
		const second = await preview(ctx, fixture('catalog-people.csv'), 'таблица.csv');

		expect(COUNTS(second)).toEqual({
			rowCount: 7,
			createCount: 0,
			updateCount: 0,
			unchangedCount: 4,
			errorCount: 3
		});

		await confirmCatalogImport(ctx, second.id);

		expect(await database.db.select({ id: people.id }).from(people)).toHaveLength(
			peopleAfterFirst.length
		);
	});

	it('руководитель заводит контакт у вуза, который завела эта же строка', async () => {
		// Вуз, заведённый загрузкой, попадает в область руководителя назначением —
		// сначала на него самого, потом на менеджера из файла. Контакт заводится
		// после этого, и его сервис проверяет область тем же условием: до
		// назначения нового вуза для руководителя не существует вовсе.
		const catalog = await seedCatalog();
		const staff = await seedStaff();

		const leadId = await insertUser(database.db, {
			roleId: 'lead',
			fullName: 'Руководитель Загрузки'
		});

		await scopedActor(database.db, {
			roleId: 'lead',
			userId: leadId,
			organizationIds: [catalog.szpu, catalog.pupi]
		});

		// Область руководителя — он сам и его подчинённые: обоих менеджеров файла
		// он назначать вправе.
		const lead = testActor({
			roleId: 'lead',
			userId: leadId,
			scopeUserIds: [leadId, staff.veresova, staff.zotov],
			workspaceIds: await allWorkspaceIds(database.db)
		});

		const record = await preview(lead, fixture('catalog-people.csv'), 'таблица.csv');
		await confirmCatalogImport(lead, record.id);

		const [created] = await database.db
			.select({ id: organizations.id })
			.from(organizations)
			.where(eq(organizations.shortName, 'ТГУИ'));

		expect(await generalResponsible(created.id)).toBe(staff.zotov);
		expect(
			await database.db
				.select({ id: people.id })
				.from(affiliations)
				.innerJoin(people, eq(people.id, affiliations.personId))
				.where(and(eq(affiliations.organizationId, created.id), eq(people.lastName, 'Сидорова')))
		).toHaveLength(1);
	});

	it('руководитель не назначает сотрудника вне своей области', async () => {
		const catalog = await seedCatalog();
		await seedStaff();

		// Вересовой руководителю не подчинён: назначить ей вуз он не может — иначе
		// раздавал бы работу людям, которых потом не увидит.
		const lead = await scopedActor(database.db, {
			roleId: 'lead',
			organizationIds: [catalog.szpu, catalog.pupi]
		});

		const record = await preview(lead, fixture('catalog-people.csv'), 'таблица.csv');
		const messages = await issuesOf(lead, record.id);

		expect(messages.some((message) => message.includes('вне вашей области доступа'))).toBe(true);
		expect(await generalResponsible(catalog.szpu)).not.toBeNull();
	});
});

describe('импорт вендоров', () => {
	const OPERATOR = 'АО «Оператор Обучения»';

	/** Тот же мастер, другой вид загрузки: файл, предложенное сопоставление, разбор. */
	async function vendorPreview(
		ctx: ReturnType<typeof testActor>,
		name: string
	): Promise<CatalogImportView> {
		const created = await createCatalogImport(ctx, {
			kind: 'vendors',
			file: { name, bytes: fixture(name) }
		});
		const shown = await getCatalogImportPreview(ctx, created.id);

		return applyCatalogMapping(ctx, created.id, suggestVendorMapping(shown.headers));
	}

	/** Сколько записей в таблицах, которые трогает загрузка вендоров. */
	async function sizes(): Promise<Record<string, number>> {
		const of = async (table: PgTable) =>
			(await database.db.select({ value: count() }).from(table))[0].value;

		return {
			organizations: await of(organizations),
			products: await of(products),
			people: await of(people),
			affiliations: await of(affiliations),
			productContacts: await of(productContacts)
		};
	}

	it('раскладывает файл по справочнику, а повторная загрузка ничего не меняет', async () => {
		const operator = await insertOrganization(database.db, {
			shortName: OPERATOR,
			kind: 'operator'
		});
		const ctx = testActor();

		// Три формата одного файла дают одни и те же числа.
		for (const name of ['vendors-sample.csv', 'vendors-sample.json']) {
			expect(COUNTS(await vendorPreview(ctx, name))).toEqual({
				rowCount: 4,
				createCount: 4,
				updateCount: 0,
				unchangedCount: 0,
				errorCount: 0
			});
		}

		const record = await vendorPreview(ctx, 'vendors-sample.xlsx');

		expect(record.kind).toBe('vendors');
		expect(COUNTS(record)).toEqual({
			rowCount: 4,
			createCount: 4,
			updateCount: 0,
			unchangedCount: 0,
			errorCount: 0
		});

		await confirmCatalogImport(ctx, record.id);

		const kinds = await database.db
			.select({ id: organizations.id, name: organizations.shortName, kind: organizations.kind })
			.from(organizations);
		const kindOf = new Map(kinds.map((row) => [row.name, row.kind]));
		const idOf = new Map(kinds.map((row) => [row.name, row.id]));

		// Оператор найден и остался оператором; ненайденные компании — вендоры.
		expect(kindOf.get(OPERATOR)).toBe('operator');
		expect(idOf.get(OPERATOR)).toBe(operator);
		expect(kindOf.get('ООО «Ладога Датасистемс»')).toBe('vendor');
		expect(kindOf.get('ООО «Полярный Софт»')).toBe('vendor');
		expect(kinds).toHaveLength(3);

		const productRows = await database.db
			.select({ id: products.id, name: products.name, vendor: products.vendorOrganizationId })
			.from(products);
		const vendorOf = new Map(productRows.map((row) => [row.name, row.vendor]));
		const ladoga = idOf.get('ООО «Ладога Датасистемс»');

		expect(Object.fromEntries(vendorOf)).toEqual({
			'Ладога.Хранилище': ladoga,
			'Ладога.Витрина': ladoga,
			'Ладога.Поток': ladoga,
			'Учебный стенд': operator,
			'Полярный Редактор': idOf.get('ООО «Полярный Софт»')
		});

		const contacts = await database.db
			.select({
				person: people,
				channel: affiliations.channel,
				organizationId: affiliations.organizationId
			})
			.from(affiliations)
			.innerJoin(people, eq(people.id, affiliations.personId));
		const byName = new Map(
			contacts.map((row) => [
				row.person.lastName,
				{ ...row, contacts: decryptContacts(row.person) }
			])
		);

		expect(byName.get('Орлова')?.channel).toBe('Почта, Чат в ТГ');
		expect(byName.get('Сизов')?.channel).toBe('Телефон');
		// Телефон числом из книги лёг телефоном, а не записью числа.
		expect(byName.get('Сизов')?.contacts.phone).toBe('79001112244');
		expect(byName.get('Кравец')).toMatchObject({ channel: 'Почта', organizationId: operator });

		const links = await database.db
			.select({ product: products.name, person: people.lastName })
			.from(productContacts)
			.innerJoin(products, eq(products.id, productContacts.productId))
			.innerJoin(people, eq(people.id, productContacts.personId));

		expect(links.map((link) => `${link.product} · ${link.person}`).sort()).toEqual([
			'Ладога.Витрина · Орлова',
			'Ладога.Поток · Сизов',
			'Ладога.Хранилище · Орлова',
			'Учебный стенд · Кравец'
		]);

		// Строки загрузки ссылаются на компанию: по ней загрузку видит тот, чья она.
		const rows = await listCatalogImportRows(ctx, record.id, {
			action: null,
			page: 1,
			pageSize: 10
		});

		expect(rows.items.every((row) => row.organizationId !== null)).toBe(true);

		const before = await sizes();
		const repeat = await vendorPreview(ctx, 'vendors-sample.xlsx');

		expect(COUNTS(repeat)).toEqual({
			rowCount: 4,
			createCount: 0,
			updateCount: 0,
			unchangedCount: 4,
			errorCount: 0
		});

		await confirmCatalogImport(ctx, repeat.id);

		expect(await sizes()).toEqual(before);
		expect(before).toEqual({
			organizations: 3,
			products: 5,
			people: 3,
			affiliations: 3,
			productContacts: 4
		});
	});

	it('узнаёт оператора по полному названию: «АО «…»» в файле — «Акционерное общество «…»» в карточке', async () => {
		const operator = await insertOrganization(database.db, {
			shortName: 'Школа оператора',
			kind: 'operator'
		});

		await database.db
			.update(organizations)
			.set({ legalName: 'Акционерное общество «Оператор Обучения»' })
			.where(eq(organizations.id, operator));

		const [stand] = await database.db
			.insert(products)
			.values({
				code: 'STAND',
				name: 'Учебный стенд',
				status: 'active',
				vendorOrganizationId: operator
			})
			.returning({ id: products.id });
		const ctx = testActor();
		const record = await vendorPreview(ctx, 'vendors-sample.csv');
		const rows = await listCatalogImportRows(ctx, record.id, {
			action: null,
			page: 1,
			pageSize: 10
		});
		const operatorRow = rows.items.find((row) => row.organizationName === OPERATOR);

		// Компания найдена, продукт её же — заводится только контакт и его связь.
		expect(record.errorCount).toBe(0);
		expect(operatorRow).toMatchObject({
			action: 'create',
			vendorContact: { name: 'Кравец Нина Олеговна', channel: 'Почта, почта' }
		});
		expect(operatorRow?.creations.map((creation) => creation.target)).toEqual(['vendorContact']);

		await confirmCatalogImport(ctx, record.id);

		// Ссылки на записи проставляет подтверждение.
		const applied = await listCatalogImportRows(ctx, record.id, {
			action: null,
			page: 1,
			pageSize: 10
		});

		expect(applied.items.find((row) => row.organizationName === OPERATOR)).toMatchObject({
			organizationId: operator,
			productId: stand.id
		});

		const operators = await database.db
			.select({ id: organizations.id })
			.from(organizations)
			.where(eq(organizations.kind, 'operator'));
		const [product] = await database.db
			.select({ vendor: products.vendorOrganizationId })
			.from(products)
			.where(eq(products.id, stand.id));

		expect(operators).toEqual([{ id: operator }]);
		expect(product.vendor).toBe(operator);
	});

	it('загружает только администратор: вендор без ответственного, вне области руководителя, а контакты видны всем', async () => {
		const university = await insertOrganization(database.db, { shortName: 'Свой вуз' });
		const lead = await scopedActor(database.db, { roleId: 'lead', organizationIds: [university] });

		await expect(
			createCatalogImport(lead, {
				kind: 'vendors',
				file: { name: 'vendors-sample.csv', bytes: fixture('vendors-sample.csv') }
			})
		).rejects.toBeInstanceOf(ForbiddenError);

		const [denied] = await database.db
			.select({ outcome: auditEvents.outcome })
			.from(auditEvents)
			.where(eq(auditEvents.eventType, 'directory.import_created'));

		expect(denied.outcome).toBe('denied');

		const admin = testActor();
		await confirmCatalogImport(admin, (await vendorPreview(admin, 'vendors-sample.csv')).id);

		const vendors = await database.db
			.select({ id: organizations.id })
			.from(organizations)
			.where(eq(organizations.kind, 'vendor'));
		const assigned = await database.db
			.select({ organizationId: organizationResponsibles.organizationId })
			.from(organizationResponsibles);

		// Оператора в базе нет, поэтому и его строка заводит вендора: компаний три.
		expect(vendors).toHaveLength(3);
		expect(assigned.map((row) => row.organizationId)).toEqual([university]);

		const visible = await listOrganizations(lead, organizationListQuerySchema.parse({}));

		expect(visible.items.map((item) => item.id)).toEqual([university]);

		// Формой вендора руководитель тоже не заведёт, а назначить вендору
		// ответственного нельзя и администратору.
		const vendorForm = createOrganizationSchema.parse({
			kind: 'vendor',
			legalName: 'ООО «Новый Вендор»',
			shortName: 'Новый Вендор'
		});

		await expect(createOrganization(lead, vendorForm)).rejects.toBeInstanceOf(ForbiddenError);
		await expect(
			assignResponsible(admin, {
				organizationId: vendors[0].id,
				userId: admin.user?.id as string,
				directionId: null,
				transferInteractions: false
			})
		).rejects.toBeInstanceOf(ValidationError);

		// Менеджер без вендора в области видит контакт по продукту; почта и
		// телефон — по его праву на контакты без маскирования.
		const [flow] = await database.db
			.select({ id: products.id })
			.from(products)
			.where(eq(products.name, 'Ладога.Поток'));
		const manager = await scopedActor(database.db, { roleId: 'manager', organizationIds: [] });
		const [contact] = await listProductContacts(manager, flow.id);

		expect(contact.person).toMatchObject({
			lastName: 'Сизов',
			phone: '79001112244',
			contactsMasked: false
		});

		const withoutPii = testActor({
			roleId: 'manager',
			permissions: ['people.read'],
			scopeUserIds: [],
			workspaceIds: []
		});
		const [masked] = await listProductContacts(withoutPii, flow.id);

		expect(masked.person.lastName).toBe('Сизов');
		expect(masked.person.contactsMasked).toBe(true);
		expect(masked.person.phone).not.toBe('79001112244');
	});
});
