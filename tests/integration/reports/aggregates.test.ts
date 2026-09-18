/**
 * Агрегаты отчёта против подсчёта по строкам.
 *
 * Итоги, воронку, динамику и разрезы считает база (`reports/aggregate.ts`), а
 * таблица на экране показывает одну страницу. Это два разных ответа на один
 * вопрос, и разойтись они могут молча: числа над таблицей никто не складывает
 * руками. Поэтому здесь тот же отчёт пересчитывается перебором **полного**
 * набора строк выгрузки (`recountFromRows`) и сверяется целиком — включая
 * подписи, порядок строк разреза и предупреждение о двойном счёте.
 *
 * Проверяется на настоящей базе: агрегат — это SQL, и на заглушках такой тест
 * доказывал бы только то, что заглушки согласованы между собой.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import {
	REPORT_PAGE_SIZE,
	reportQuerySchema,
	type ReportQuery,
	type ReportView
} from '$lib/contracts/reports';
import type { ActorContext } from '$lib/server/actor';
import { checkReportInvariants, recountFromRows } from '$lib/server/reports/invariants';
import { buildReport, buildReportPage } from '$lib/server/reports/rows';
import {
	addFillerInteractions,
	QUARTER_PERIOD,
	SEPTEMBER_PERIOD,
	seedReferenceSet,
	type ReferenceIds
} from '../../fixtures/reports/reference';
import { startTestDatabase, testActor, TEST_USER_IDS, type TestDatabase } from '../helpers/db';

// См. комментарий в `helpers/db.ts`: без этого сервисы пойдут в базу разработчика.
vi.mock('$env/dynamic/private', () => ({ env: process.env }));

/**
 * Переменные входа через внешнего провайдера. Общий помощник базы их пока не
 * выставляет, а `getConfig()` проверяет конфигурацию целиком и без них не
 * собирается.
 */
process.env.OIDC_ISSUER_URL ??= 'http://localhost:8080/realms/lct';
process.env.OIDC_PUBLIC_URL ??= 'http://localhost:8080/realms/lct';
process.env.OIDC_CLIENT_ID ??= 'lct-crm';
process.env.OIDC_CLIENT_SECRET ??= 'test-secret';

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

function query(input: z.input<typeof reportQuerySchema>): ReportQuery {
	return reportQuerySchema.parse(input);
}

/** Числа отчёта без строк: только то, что считает агрегат. */
function numbers(view: ReportView) {
	return { totals: view.totals, charts: view.charts };
}

describe('агрегаты совпадают с подсчётом по строкам', () => {
	const cases: { name: string; input: z.input<typeof reportQuerySchema> }[] = [
		{ name: 'срез на конец сентября', input: { mode: 'snapshot', ...SEPTEMBER_PERIOD } },
		{ name: 'срез на конец декабря', input: { mode: 'snapshot', ...QUARTER_PERIOD } },
		{ name: 'движение за квартал', input: { mode: 'movement', ...QUARTER_PERIOD } }
	];

	for (const { name, input } of cases) {
		it(name, async () => {
			const asked = query(input);
			const view = await buildReport(admin(), asked);

			expect(numbers(view)).toStrictEqual(await recountFromRows(admin(), asked));
			expect(checkReportInvariants(view)).toStrictEqual([]);
		});
	}

	it('под фильтром по вузу — тоже', async () => {
		const asked = query({ mode: 'snapshot', ...QUARTER_PERIOD, org: ids.organizations.b });
		const view = await buildReport(admin(), asked);

		expect(view.totals.rowCount).toBeGreaterThan(0);
		expect(numbers(view)).toStrictEqual(await recountFromRows(admin(), asked));
	});

	it('на пустой выборке — тоже: нули, а не отсутствие чисел', async () => {
		const asked = query({ mode: 'snapshot', from: '2026-01-01', to: '2026-01-31' });
		const view = await buildReport(admin(), asked);

		expect(view.totals.rowCount).toBe(0);
		expect(numbers(view)).toStrictEqual(await recountFromRows(admin(), asked));
	});
});

describe('страница экрана', () => {
	beforeEach(async () => {
		await addFillerInteractions(database.db, ids, TEST_USER_IDS.admin, 55);
	});

	it('режет строки окном, а числа оставляет по всей выборке', async () => {
		const asked = query({ mode: 'snapshot', ...QUARTER_PERIOD });
		const whole = await buildReport(admin(), asked);
		const first = await buildReportPage(admin(), asked, 1);
		const second = await buildReportPage(admin(), asked, 2);

		expect(whole.rows.length).toBe(62);
		expect(first.pages).toBe(2);
		expect(first.view.rows.length).toBe(REPORT_PAGE_SIZE);
		expect(second.view.rows.length).toBe(12);

		// Страницы — это окна одного порядка: вместе они дают ту же выборку, в
		// том же порядке, что и выгрузка.
		expect([...first.view.rows, ...second.view.rows].map((row) => row.rowKey)).toStrictEqual(
			whole.rows.map((row) => row.rowKey)
		);

		// Числа страницы описывают всю выборку, а не показанные строки.
		expect(numbers(first.view)).toStrictEqual(numbers(whole));
		expect(numbers(second.view)).toStrictEqual(numbers(whole));
	});

	it('считает паузу по всей выборке, а не по показанным строкам', async () => {
		const asked = query({ mode: 'snapshot', ...QUARTER_PERIOD });
		const second = await buildReportPage(admin(), asked, 2);
		const paused = second.view.rows.filter((row) => row.interactionId === ids.interactions['В-5']);

		// Единственная незакрытая пауза набора — у В-5, и на второй странице этой
		// строки нет; число над таблицей всё равно обязано её считать.
		expect(paused).toStrictEqual([]);
		expect(second.view.totals.paused).toBe(1);
		expect(second.view.totals.rowCount).toBe(62);
	});

	it('номер за последней страницей приводится к последней, а не к пустоте', async () => {
		const asked = query({ mode: 'snapshot', ...QUARTER_PERIOD });
		const beyond = await buildReportPage(admin(), asked, 9);

		expect(beyond.page).toBe(2);
		expect(beyond.view.rows.length).toBe(12);
	});

	it('в движении страница устроена так же', async () => {
		const asked = query({ mode: 'movement', ...QUARTER_PERIOD });
		const whole = await buildReport(admin(), asked);
		const first = await buildReportPage(admin(), asked, 1);

		expect(whole.rows.length).toBeGreaterThan(REPORT_PAGE_SIZE);
		expect(first.view.rows.length).toBe(REPORT_PAGE_SIZE);
		expect(numbers(first.view)).toStrictEqual(numbers(whole));
	});
});
