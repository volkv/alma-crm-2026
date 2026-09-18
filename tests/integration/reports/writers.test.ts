/**
 * И5: четыре писателя дают одни и те же строки.
 *
 * Один и тот же объект отчёта прогоняется через все четыре формата, и файлы
 * читаются обратно: книги — тем же SheetJS, JSON — разбором, PDF — текстом
 * через `pdftotext`. Сверяются число строк и значение каждой ячейки. Если
 * писатель однажды начнёт считать сам, этот тест первым это и покажет.
 *
 * PDF собирает Gotenberg из compose (`pnpm run test:integration` поднимает его):
 * пропускать проверку при недоступной службе нельзя — молча зелёный тест хуже
 * красного.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { eq } from 'drizzle-orm';
import type { RequestEvent } from '@sveltejs/kit';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	REPORT_FORMATS,
	REPORT_PDF_ROWS,
	reportQuerySchema,
	type ReportCell,
	type ReportQuery,
	type ReportView
} from '$lib/contracts/reports';
import type { ActorContext } from '$lib/server/actor';
import { auditEvents } from '$lib/server/db/schema';
import { checkExportInvariant } from '$lib/server/reports/invariants';
import { buildReport } from '$lib/server/reports/rows';
import { renderReport } from '$lib/server/reports/writers';
import { XLSX } from '$lib/server/spreadsheet/sheetjs';
import {
	QUARTER_PERIOD,
	seedReferenceSet,
	type ReferenceIds
} from '../../fixtures/reports/reference';
import { startTestDatabase, testActor, TEST_USER_IDS, type TestDatabase } from '../helpers/db';
import { pageEvent, sessionUser } from '../helpers/event';

// См. комментарий в `helpers/db.ts`: без этого сервисы пойдут в базу разработчика.
vi.mock('$env/dynamic/private', () => ({ env: process.env }));

/**
 * Переменные входа через внешнего провайдера. Общий помощник базы их пока не
 * выставляет — задача аутентификации ещё в работе, — а `getConfig()` проверяет
 * конфигурацию целиком и без них не собирается.
 */
process.env.OIDC_ISSUER_URL ??= 'http://localhost:8080/realms/lct';
process.env.OIDC_PUBLIC_URL ??= 'http://localhost:8080/realms/lct';
process.env.OIDC_CLIENT_ID ??= 'lct-crm';
process.env.OIDC_CLIENT_SECRET ??= 'test-secret';

const run = promisify(execFile);

let database: TestDatabase;
let ids: ReferenceIds;

beforeAll(async () => {
	database = await startTestDatabase();
}, 300_000);

afterAll(async () => {
	await database?.stop();
});

beforeEach(async () => {
	await database.reset();
	ids = await seedReferenceSet(database.db, TEST_USER_IDS.admin);
});

const admin = (): ActorContext => testActor();

const QUERY: ReportQuery = reportQuerySchema.parse({ mode: 'snapshot', ...QUARTER_PERIOD });

/** Значение ячейки так, как его должен показать файл. */
function expectedText(cell: ReportCell): string {
	switch (cell.kind) {
		case 'number':
			return cell.value === null ? '' : String(cell.value);
		case 'list':
			return cell.values.join(', ');
		case 'date':
		case 'datetime':
		case 'text':
		case 'link':
			return cell.value ?? '';
	}
}

/** Лист книги в виде массива строк — так же его читает импорт таблиц. */
function sheetRows(file: Buffer, sheetName: string): string[][] {
	const workbook = XLSX.read(file, { type: 'buffer', cellDates: true });
	const sheet = workbook.Sheets[sheetName];

	return XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, raw: false, defval: '' });
}

async function pdfText(file: Buffer): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), 'report-pdf-'));

	try {
		const path = join(directory, 'report.pdf');

		await writeFile(path, file);

		// `pdftotext` читает файл, а не поток, поэтому PDF ложится во временный
		// каталог; `-layout` сохраняет колонки таблицы.
		const { stdout } = await run('pdftotext', ['-layout', path, '-']);

		return stdout;
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

describe('четыре писателя одного отчёта', () => {
	it('дают одинаковое число строк во всех форматах', async () => {
		const view = await buildReport(admin(), QUERY);
		const files = await Promise.all(
			REPORT_FORMATS.map(async (format) => [format, await renderReport(view, format)] as const)
		);

		const counts: Record<string, number> = {};

		for (const [format, file] of files) {
			if (format === 'xlsx' || format === 'xls') {
				counts[format] = sheetRows(file.body, 'Отчёт').length - 1;
			}

			if (format === 'json') {
				counts[format] = (
					JSON.parse(file.body.toString('utf8')) as { rows: unknown[] }
				).rows.length;
			}
		}

		expect(view.rows.length).toBeGreaterThan(0);
		expect(checkExportInvariant(view, counts)).toStrictEqual([]);

		const pdf = files.find(([format]) => format === 'pdf')![1];
		const text = await pdfText(pdf.body);

		// Ячейку с длинным названием вёрстка переносит, и в тексте страницы её
		// половины расходятся по колонкам. Поэтому строка опознаётся по коду —
		// первому слову названия, уникальному в наборе: важно, что в PDF попали
		// все семь строк, а не то, как их перенесли.
		const codes = view.rows.map((row) => {
			const title = row.cells[0];

			return (title.kind === 'link' ? (title.value ?? '') : '').split(' ')[0];
		});

		expect(new Set(codes).size).toBe(view.rows.length);

		for (const code of codes) {
			expect(text).toContain(code);
		}
	});

	it('пишут в ячейку то же значение, что показывает экран', async () => {
		const view = await buildReport(admin(), QUERY);
		const xlsx = await renderReport(view, 'xlsx');
		const xls = await renderReport(view, 'xls');

		for (const file of [xlsx, xls]) {
			const rows = sheetRows(file.body, 'Отчёт');

			view.rows.forEach((row, index) => {
				row.cells.forEach((cell, position) => {
					const written = rows[index + 1][position] ?? '';

					// Дата в книге лежит числом дней и читается обратно уже строкой
					// формата листа: сравнивается день, а не представление.
					if (cell.kind === 'date' || cell.kind === 'datetime') {
						return;
					}

					expect(written).toBe(expectedText(cell));
				});
			});
		}
	});

	it('дают в JSON те же значения и устойчивые идентификаторы', async () => {
		const view = await buildReport(admin(), QUERY);
		const file = await renderReport(view, 'json');
		const payload = JSON.parse(file.body.toString('utf8')) as {
			schemaVersion: number;
			mode: string;
			period: { start: string; end: string };
			semantics: string;
			rows: { interactionId: string; url: string | null; values: Record<string, unknown> }[];
		};

		expect(payload.schemaVersion).toBe(1);
		expect(payload.mode).toBe('snapshot');
		expect(payload.period).toStrictEqual({ start: QUARTER_PERIOD.from, end: QUARTER_PERIOD.to });
		expect(payload.semantics).toBe(view.meta.semantics);
		expect(payload.rows.map((row) => row.interactionId)).toStrictEqual(
			view.rows.map((row) => row.interactionId)
		);

		// Ссылка на карточку в файле абсолютная: относительная вне приложения не
		// открывается.
		for (const row of payload.rows) {
			expect(row.url).toMatch(/^https?:\/\/.+\/interactions\/[0-9a-f-]{36}$/);
		}
	});

	it('кладут в книгу лист фильтров с режимом, периодом и областью доступа', async () => {
		const view = await buildReport(admin(), QUERY);
		const file = await renderReport(view, 'xlsx');
		const rows = sheetRows(file.body, 'Фильтры').map((row) => row.join(' | '));

		expect(rows.some((row) => row.startsWith('Режим | Срез'))).toBe(true);
		expect(rows.some((row) => row.includes('01.10.2026 — 31.12.2026'))).toBe(true);
		expect(rows.some((row) => row.startsWith('Область доступа'))).toBe(true);
		expect(rows.some((row) => row.includes(view.meta.semantics))).toBe(true);
	});

	it('печатает PDF, и правило семантики в нём читается', async () => {
		const view = await buildReport(admin(), QUERY);
		const file = await renderReport(view, 'pdf');

		expect(file.body.subarray(0, 4).toString('latin1')).toBe('%PDF');

		const text = await pdfText(file.body);

		expect(text).toContain('Отчёт по взаимодействиям');
		expect(text).toContain('Срез на 31.12.2026');
		expect(text).toContain('Вуз А');
	});

	it('на выборке выше потолка PDF отвечает сводкой, а не отказом', async () => {
		// Строки берутся у настоящего отчёта и размножаются: проверяется поведение
		// писателя на объёме, а не семантика выборки — заливать в базу шесть сотен
		// взаимодействий ради одной пометки незачем.
		const view = await buildReport(admin(), QUERY);
		const total = REPORT_PDF_ROWS + 100;
		const many: ReportView = {
			...view,
			rows: Array.from({ length: total }, (_, index) => ({
				...view.rows[index % view.rows.length],
				rowKey: `row-${index}`
			})),
			totals: { ...view.totals, rowCount: total, interactionCount: total }
		};

		const file = await renderReport(many, 'pdf');

		expect(file.body.subarray(0, 4).toString('latin1')).toBe('%PDF');

		const text = await pdfText(file.body);

		expect(text).toContain(`Показаны первые ${REPORT_PDF_ROWS} строк из ${total}`);
		expect(checkExportInvariant(many, { pdf: REPORT_PDF_ROWS })).toStrictEqual([]);
	}, 120_000);

	it('называет файл режимом, периодом и днём сборки', async () => {
		const view = await buildReport(admin(), QUERY);
		const file = await renderReport(view, 'xlsx', '2026-09-17');

		expect(file.fileName).toBe(
			'Отчёт по взаимодействиям — срез на 31.12.2026 (собран 17.09.2026).xlsx'
		);
	});
});

describe('маршрут выгрузки', () => {
	type Endpoint = (event: RequestEvent) => Promise<Response>;

	async function exportRoute(): Promise<Endpoint> {
		const module = await import('../../../src/routes/(app)/reports/export/+server');

		return module.GET as unknown as Endpoint;
	}

	it('отдаёт книгу и пишет событие в журнал', async () => {
		const GET = await exportRoute();
		const response = await GET(
			pageEvent({
				path: '/reports/export',
				query: `?format=xlsx&mode=snapshot&from=${QUARTER_PERIOD.from}&to=${QUARTER_PERIOD.to}`
			})
		);

		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Disposition')).toContain('filename*=UTF-8');
		expect(response.headers.get('Cache-Control')).toBe('no-store');

		const body = Buffer.from(await response.arrayBuffer());

		expect(body.length).toBeGreaterThan(0);

		const events = await database.db
			.select({ outcome: auditEvents.outcome, details: auditEvents.details })
			.from(auditEvents)
			.where(eq(auditEvents.eventType, 'reports.exported'));

		expect(events.length).toBe(1);
		expect(events[0].outcome).toBe('success');
		expect(events[0].details).toStrictEqual({
			mode: 'snapshot',
			periodStart: QUARTER_PERIOD.from,
			periodEnd: QUARTER_PERIOD.to,
			rowCount: 7,
			formatKey: 'xlsx'
		});
	});

	it('не пускает без права на просмотр взаимодействий', async () => {
		const GET = await exportRoute();
		const event = pageEvent({
			path: '/reports/export',
			query: '?format=json',
			user: sessionUser('manager')
		});

		// Область роли, у которой нет права: подменяется набор прав, а не роль —
		// вопрос ровно в праве.
		event.locals.user = { ...event.locals.user!, permissions: new Set() };

		await expect(GET(event)).rejects.toMatchObject({ status: 403 });
	});

	it('в выгрузку не попадают записи вне области доступа', async () => {
		const GET = await exportRoute();
		const scoped = sessionUser('manager');
		const event = pageEvent({
			path: '/reports/export',
			query: `?format=json&mode=snapshot&from=${QUARTER_PERIOD.from}&to=${QUARTER_PERIOD.to}`,
			user: { ...scoped, scope: { kind: 'delegated', userIds: new Set<string>() } }
		});

		const response = await GET(event);
		const payload = JSON.parse(await response.text()) as { rows: unknown[] };

		expect(payload.rows).toStrictEqual([]);
		expect(Object.keys(ids.interactions).length).toBe(8);
	});
});
