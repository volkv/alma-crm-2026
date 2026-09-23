/**
 * Отчёт согласован сам с собой — во времени и между своими частями.
 *
 * Фильтр и колонка с одним смыслом читают одно значение на один момент:
 * отобранный фильтром «Ответственный за вуз» человек обязан стоять в колонке
 * «Ответственный за вуз» той же строки, а отобранное фильтром «Состояние»
 * состояние — в колонке «Состояние». И итоги с диаграммами описывают ровно те
 * строки, что лежат в таблице, даже если база поменялась, пока отчёт
 * собирался.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import { reportQuerySchema, type ReportQuery, type ReportView } from '$lib/contracts/reports';
import type { ActorContext } from '$lib/server/actor';
import { organizationResponsibles } from '$lib/server/db/schema';
import { checkReportInvariants } from '$lib/server/reports/invariants';
import { buildReport } from '$lib/server/reports/rows';
import {
	addFillerInteractions,
	QUARTER_PERIOD,
	SEPTEMBER_PERIOD,
	seedReferenceSet,
	type ReferenceIds
} from '../../fixtures/reports/reference';
import {
	insertUser,
	startTestDatabase,
	testActor,
	TEST_USER_IDS,
	type TestDatabase
} from '../helpers/db';

// См. комментарий в `helpers/db.ts`: без этого сервисы пойдут в базу разработчика.
vi.mock('$env/dynamic/private', () => ({ env: process.env }));

/**
 * Вмешательство между чтением итогов и чтением строк. Сборка отчёта зовёт
 * агрегат раньше строк, и запись, сделанная сразу после агрегата, — это ровно
 * та гонка, которую отчёт обязан пережить: переход или новое взаимодействие,
 * случившиеся, пока отчёт собирался.
 */
const between = vi.hoisted(() => ({ action: null as null | (() => Promise<void>) }));

vi.mock('$lib/server/reports/aggregate', async (importOriginal) => {
	const original = await importOriginal<typeof import('$lib/server/reports/aggregate')>();

	const interfere = async <TResult>(result: TResult): Promise<TResult> => {
		const action = between.action;

		between.action = null;

		if (action !== null) {
			await action();
		}

		return result;
	};

	return {
		...original,
		readSnapshotAggregates: async (...args: Parameters<typeof original.readSnapshotAggregates>) =>
			interfere(await original.readSnapshotAggregates(...args)),
		readMovementAggregates: async (...args: Parameters<typeof original.readMovementAggregates>) =>
			interfere(await original.readMovementAggregates(...args))
	};
});

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
	between.action = null;
	await database.reset();
	ids = await seedReferenceSet(database.db, TEST_USER_IDS.admin);
});

const admin = (): ActorContext => testActor();

function query(input: z.input<typeof reportQuerySchema>): ReportQuery {
	return reportQuerySchema.parse(input);
}

/** Значение колонки по её ключу: колонки идут в порядке каталога, а не запроса. */
function cellValues(view: ReportView, interactionId: string, key: string): readonly string[] {
	const position = view.meta.columns.findIndex((column) => column.key === key);
	const cell = view.rows.find((row) => row.interactionId === interactionId)?.cells[position];

	if (cell === undefined) {
		return [];
	}

	if (cell.kind === 'list') {
		return cell.values;
	}

	return 'value' in cell && typeof cell.value === 'string' ? [cell.value] : [];
}

function interactionIds(view: ReportView): string[] {
	return view.rows.map((row) => row.interactionId).sort();
}

describe('фильтр и колонка «Ответственный за вуз»', () => {
	it('после переназначения отбирают и показывают одного и того же человека', async () => {
		const former = await insertUser(database.db, {
			email: 'former@example.org',
			fullName: 'Прежний Ответственный',
			roleId: 'manager'
		});
		const current = await insertUser(database.db, {
			email: 'current@example.org',
			fullName: 'Нынешний Ответственный',
			roleId: 'manager'
		});

		// Вуз А вёл один человек до 15.10, дальше — другой.
		const reassignedAt = new Date('2026-10-15T00:00:00.000+03:00');

		await database.db.insert(organizationResponsibles).values([
			{
				organizationId: ids.organizations.a,
				userId: former,
				validFrom: new Date('2026-06-01T00:00:00.000+03:00'),
				validTo: reassignedAt
			},
			{ organizationId: ids.organizations.a, userId: current, validFrom: reassignedAt }
		]);

		const cols = 'interaction,organization,assignee';

		for (const [period, holder, other] of [
			[SEPTEMBER_PERIOD, 'Прежний Ответственный', current],
			[QUARTER_PERIOD, 'Нынешний Ответственный', former]
		] as const) {
			const whole = await buildReport(admin(), query({ mode: 'snapshot', ...period, cols }));
			const holderId = holder === 'Прежний Ответственный' ? former : current;
			const filtered = await buildReport(
				admin(),
				query({ mode: 'snapshot', ...period, cols, assignee: holderId })
			);
			const shownWithHolder = whole.rows
				.filter((row) => cellValues(whole, row.interactionId, 'assignee').includes(holder))
				.map((row) => row.interactionId)
				.sort();

			// Фильтр отбирает ровно те строки, в которых колонка называет человека.
			expect(filtered.rows.length).toBeGreaterThan(0);
			expect(interactionIds(filtered)).toStrictEqual(shownWithHolder);

			for (const row of filtered.rows) {
				expect(cellValues(filtered, row.interactionId, 'assignee')).toContain(holder);
			}

			// Второй человек на эту дату вуз не вёл: фильтр по нему пуст.
			const empty = await buildReport(
				admin(),
				query({ mode: 'snapshot', ...period, cols, assignee: other })
			);

			expect(empty.rows).toStrictEqual([]);
		}
	});
});

describe('фильтр и колонка «Состояние»', () => {
	it('в срезе на прошлую дату читают состояние на эту дату, а не сегодняшнее', async () => {
		// В-3 завершено 20.12, а 30.09 стояло на стадии: в сентябрьском срезе оно
		// в работе — и в колонке, и для фильтра.
		const cols = 'interaction,organization,state';
		const september = await buildReport(
			admin(),
			query({ mode: 'snapshot', ...SEPTEMBER_PERIOD, cols })
		);
		const completedLater = september.rows.find((row) =>
			cellValues(september, row.interactionId, 'interaction')[0]?.startsWith('В-3')
		);

		expect(completedLater).toBeDefined();

		const id = completedLater!.interactionId;

		expect(cellValues(september, id, 'state')).toStrictEqual(['В работе']);

		const active = await buildReport(
			admin(),
			query({ mode: 'snapshot', ...SEPTEMBER_PERIOD, cols, state: 'active' })
		);
		const completed = await buildReport(
			admin(),
			query({ mode: 'snapshot', ...SEPTEMBER_PERIOD, cols, state: 'completed' })
		);

		expect(interactionIds(active)).toContain(id);
		expect(interactionIds(completed)).not.toContain(id);

		// Во всём срезе фильтр и колонка сходятся строка в строку.
		for (const row of active.rows) {
			expect(cellValues(active, row.interactionId, 'state')).toStrictEqual(['В работе']);
		}

		// На конец квартала оно уже завершено — и так же для обоих.
		const quarter = await buildReport(
			admin(),
			query({ mode: 'snapshot', ...QUARTER_PERIOD, cols, state: 'completed' })
		);

		expect(interactionIds(quarter)).toContain(id);
		expect(cellValues(quarter, id, 'state')).toStrictEqual(['Завершено']);
	});
});

describe('один снимок на итоги и строки', () => {
	it.each(['snapshot', 'movement'] as const)(
		'%s: запись, сделанная между чтением итогов и строк, не разводит их',
		async (mode) => {
			const asked = query({ mode, ...QUARTER_PERIOD });
			const quiet = await buildReport(admin(), asked);

			between.action = async () => {
				// Отдельное соединение теста, сразу зафиксированное: для отчёта это
				// чужая транзакция, закончившаяся посреди его сборки.
				await addFillerInteractions(database.db, ids, TEST_USER_IDS.admin, 3);
			};

			const raced = await buildReport(admin(), asked);

			expect(between.action).toBeNull();

			// Итоги, диаграммы и строки — из одного состояния: того, что было до
			// вставки.
			expect(raced.rows.length).toBe(raced.totals.rowCount);
			expect(checkReportInvariants(raced)).toStrictEqual([]);
			expect(raced.totals).toStrictEqual(quiet.totals);
			expect(raced.rows.map((row) => row.rowKey)).toStrictEqual(
				quiet.rows.map((row) => row.rowKey)
			);

			// Вставка при этом состоялась: следующая сборка её видит.
			const after = await buildReport(admin(), asked);

			expect(after.totals.rowCount).toBe(quiet.totals.rowCount + 3);
			expect(after.rows.length).toBe(after.totals.rowCount);
		}
	);
});
