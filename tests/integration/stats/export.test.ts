/**
 * Выгрузка отчёта на настоящих данных.
 *
 * Модульная проверка собирает книгу из готового представления; здесь важно
 * другое — что в неё попадает то же, что показывает дашборд, что название
 * организации доезжает до ячейки из базы обезвреженным (вуз называет себя сам,
 * а строку с ведущим знаком равенства таблица выполнит у того, кто открыл файл)
 * и что сама выгрузка остаётся в журнале: файл уезжает из системы, и кто его
 * собрал, видно только оттуда.
 */
import type { RequestEvent } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { statPeriodKey } from '$lib/contracts/stats';
import { auditEvents, programs } from '$lib/server/db/schema';
import { ForbiddenError } from '$lib/server/errors';
import { getRedis } from '$lib/server/redis';
import { getStatsDashboard } from '$lib/server/stats/dashboard';
import { buildStatsReport } from '$lib/server/stats/export';
import {
	applyMapping,
	confirmSnapshot,
	createSnapshot,
	validateSnapshot
} from '$lib/server/stats/import';
import { suggestMapping } from '$lib/server/stats/mapping';
import { getSnapshotPreview } from '$lib/server/stats/read';
import {
	insertOrganization,
	startTestDatabase,
	testActor,
	TEST_USER_IDS,
	type TestDatabase
} from '../helpers/db';
import { pageEvent } from '../helpers/event';

// См. комментарий в `helpers/db.ts`: без этого сервисы пойдут в базу разработчика.
vi.mock('$env/dynamic/private', () => ({ env: process.env }));

/** Маршрут типизирован своим `$types`; подделка события — общим типом. */
type Endpoint = (event: RequestEvent) => Promise<Response>;

const exportRoute = await import('../../../src/routes/(app)/data/export/+server');

let database: TestDatabase;

const PERIOD = { periodStart: '2026-09-01', periodEnd: '2027-08-31' } as const;
const PERIOD_KEY = { kind: 'academic', start: PERIOD.periodStart, end: PERIOD.periodEnd } as const;

/**
 * Название, которое вуз прислал сам. Кавычек в нём нет намеренно: строка
 * проезжает через разбор CSV, где кавычки значат совсем другое, а опасен здесь
 * ведущий знак равенства.
 */
const DANGEROUS_NAME = '=Академия цифровых компетенций';

const HEADER = 'Вуз;Код программы;Подано заявок;Зачислено;Параллельные потоки;Завершили обучение';

async function confirmedSnapshot(ctx: ReturnType<typeof testActor>): Promise<void> {
	await insertOrganization(database.db, { shortName: DANGEROUS_NAME, inn: '7802450127' });

	await database.db
		.insert(programs)
		.values([
			{ code: 'VO-BAK-01', name: 'Прикладная информатика', level: 'bachelor', status: 'active' }
		]);

	const bytes = new TextEncoder().encode(
		[HEADER, `${DANGEROUS_NAME};VO-BAK-01;120;0;3;`].join('\r\n') + '\r\n'
	);

	const created = await createSnapshot(ctx, {
		source: 'file',
		mode: 'full',
		periodKind: 'academic',
		...PERIOD,
		file: { name: 'выгрузка.csv', bytes }
	});

	const preview = await getSnapshotPreview(ctx, created.id);
	await applyMapping(ctx, created.id, suggestMapping(preview.headers));
	await validateSnapshot(ctx, created.id);
	await confirmSnapshot(ctx, created.id);
}

beforeAll(async () => {
	database = await startTestDatabase();
}, 300_000);

afterAll(async () => {
	await getRedis().quit();
	await database?.stop();
});

beforeEach(async () => {
	await database.reset();
});

describe('отчёт по данным об обучении', () => {
	it('уносит в книгу числа дашборда и обезвреженные названия', async () => {
		const ctx = testActor();
		await confirmedSnapshot(ctx);

		const dashboard = await getStatsDashboard(ctx, PERIOD_KEY);
		const report = await buildStatsReport(dashboard, '2026-09-12');
		const workbook = new ExcelJS.Workbook();

		await workbook.xlsx.load(report.body.slice().buffer as ArrayBuffer);

		const organizations = workbook.getWorksheet('Вузы и площадки');
		const row = organizations?.getRow(2);

		expect(row?.getCell(1).value).toBe(`'${DANGEROUS_NAME}`);
		expect(row?.getCell(1).formula).toBeUndefined();
		// Заявки и программы — числами, записанный ноль остался нулём, а
		// «завершили обучение» в файле пустое: колонки в выгрузке не было.
		expect(row?.getCell(2).value).toBe(1);
		expect(row?.getCell(3).value).toBe(dashboard.totals.applications);
		expect(row?.getCell(4).value).toBe(0);
		expect(row?.getCell(6).value).toBeNull();
	});

	it('называет в имени файла период и день выгрузки', async () => {
		const ctx = testActor();
		await confirmedSnapshot(ctx);

		const report = await buildStatsReport(await getStatsDashboard(ctx, PERIOD_KEY), '2026-09-12');

		expect(report.fileName).toBe('Данные об обучении 2026-09-01 — 2027-08-31 на 2026-09-12.xlsx');
	});

	it('называет на листе «Источники» ту загрузку, из которой сложились числа', async () => {
		const ctx = testActor();
		await confirmedSnapshot(ctx);

		const report = await buildStatsReport(await getStatsDashboard(ctx, PERIOD_KEY), '2026-09-12');
		const workbook = new ExcelJS.Workbook();

		await workbook.xlsx.load(report.body.slice().buffer as ArrayBuffer);

		const row = workbook.getWorksheet('Источники')?.getRow(2);

		expect(row?.getCell(1).value).toBe('Файл');
		expect(row?.getCell(3).value).toBe('выгрузка.csv');
		expect(row?.getCell(4).value).toBe('Тестовый Администратор');
		expect(row?.getCell(6).value).toBe(1);
	});

	it('не собирается без права на чтение данных', async () => {
		const ctx = testActor({ permissions: [] });

		await expect(getStatsDashboard(ctx, PERIOD_KEY)).rejects.toBeInstanceOf(ForbiddenError);
	});

	it('сама попадает в журнал одной записью', async () => {
		await confirmedSnapshot(testActor());

		const response = await (exportRoute.GET as Endpoint)(
			pageEvent({ path: '/data/export', query: `?period=${statPeriodKey(PERIOD_KEY)}` })
		);

		expect(response.status).toBe(200);

		// Загрузка снимка пишет в журнал свои события; здесь считается только
		// выгрузка — и ровно одна, а не по записи на лист книги.
		const exported = await database.db
			.select({ outcome: auditEvents.outcome, actorUserId: auditEvents.actorUserId })
			.from(auditEvents)
			.where(eq(auditEvents.eventType, 'stats.exported'));

		expect(exported).toStrictEqual([{ outcome: 'success', actorUserId: TEST_USER_IDS.admin }]);
	});
});
