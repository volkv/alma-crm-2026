/**
 * Эталонный набор отчётов: числа документа против чисел кода.
 *
 * Проверяется на настоящей базе, потому что весь отчёт — это SQL: границы окна
 * записи, пересечение пауз, область доступа и группировка по ключу снимка. На
 * заглушках такой тест доказывал бы только то, что заглушки согласованы между
 * собой.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import { interactionListQuerySchema } from '$lib/contracts/interactions';
import { reportQuerySchema, type ReportQuery, type ReportView } from '$lib/contracts/reports';
import type { ActorContext } from '$lib/server/actor';
import { B2B_WORKSPACE_KEY } from '$lib/server/stages/definitions';
import { organizationResponsibles } from '$lib/server/db/schema';
import { listInteractions } from '$lib/server/interactions/read';
import { checkReportInvariants, reconcileModes } from '$lib/server/reports/invariants';
import { buildReport } from '$lib/server/reports/rows';
import {
	addBoundaryInteraction,
	EXPECTED_BREAKDOWNS,
	EXPECTED_MOVEMENT,
	EXPECTED_RECONCILIATION,
	EXPECTED_SNAPSHOT,
	QUARTER_PERIOD,
	SEPTEMBER_PERIOD,
	renameStage,
	seedReferenceSet,
	type ReferenceIds
} from '../../fixtures/reports/reference';
import {
	allWorkspaceIds,
	insertUser,
	startTestDatabase,
	testActor,
	TEST_USER_IDS,
	type TestDatabase
} from '../helpers/db';

// См. комментарий в `helpers/db.ts`: без этого сервисы пойдут в базу разработчика.
vi.mock('$env/dynamic/private', () => ({ env: process.env }));

/**
 * Переменные входа через внешнего провайдера. Общий помощник базы их пока не
 * выставляет — задача аутентификации ещё в работе, — а `getConfig()` проверяет
 * конфигурацию целиком и без них не собирается. Отчёт в провайдер не ходит, и
 * значения здесь только для того, чтобы проверка прошла; строку убирают, когда
 * помощник начнёт выставлять их сам.
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

/**
 * Контекст с ограниченной областью. Собирается здесь, а не через `testActor`:
 * область — это множество людей, и вопрос «что видит тот, кому делегированы
 * записи одного сотрудника» иначе не задать.
 */
function delegatedActor(userIds: readonly string[], workspaceIds: readonly string[]): ActorContext {
	const scope = {
		kind: 'delegated' as const,
		userIds: new Set(userIds),
		workspaceIds: new Set(workspaceIds)
	};
	const base = testActor({ roleId: 'manager' });

	return { ...base, scope, user: base.user === null ? null : { ...base.user, scope } };
}

/**
 * Запрос отчёта из того, что пишут в адресе: многозначные фильтры принимаются
 * строкой, как их и передают ссылкой.
 */
/**
 * Запрос отчёта. Отчёт строится внутри пространства, и эталонный набор живёт в
 * B2B — оно и подставляется, если тест не назвал другое.
 */
function query(
	input: Omit<z.input<typeof reportQuerySchema>, 'workspace'> & { workspace?: string }
): ReportQuery {
	return reportQuerySchema.parse({ workspace: B2B_WORKSPACE_KEY, ...input });
}

/** Полосы всех воронок подряд: воронка своя у каждой группы процесса. */
function funnelStages(view: ReportView) {
	return view.charts.funnel?.stages ?? [];
}

/** Число в стадии воронки по ключу: корзина — это пара «группа + ключ». */
function stageValue(view: ReportView, key: string): number {
	return funnelStages(view).find((bucket) => bucket.key.endsWith(`:${key}`))?.value ?? 0;
}

function closedValue(view: ReportView, key: string): number {
	return view.charts.funnel?.closed.find((bucket) => bucket.key === key)?.value ?? 0;
}

function breakdown(view: ReportView, key: string): Record<string, number> {
	const points = view.charts.breakdowns.find((item) => item.key === key)?.points ?? [];

	return Object.fromEntries(points.map((point) => [point.label, point.value]));
}

function eventCounts(view: ReportView): Record<string, number> {
	const series = view.charts.movement?.series ?? [];

	return Object.fromEntries(
		series.map((item) => [item.key, item.values.reduce((sum, value) => sum + value, 0)])
	);
}

describe('срез на дату', () => {
	it('раскладывает по стадиям ровно так, как посчитано в документе — конец сентября', async () => {
		const view = await buildReport(admin(), query({ mode: 'snapshot', ...SEPTEMBER_PERIOD }));
		const expected = EXPECTED_SNAPSHOT.september;

		expect(view.rows.length).toBe(expected.rows);
		expect(stageValue(view, 'contact_search')).toBe(expected.contact_search);
		expect(stageValue(view, 'communication')).toBe(expected.communication);
		expect(stageValue(view, 'meeting')).toBe(expected.meeting);
		expect(stageValue(view, 'document_exchange')).toBe(expected.document_exchange);
		expect(stageValue(view, 'signing')).toBe(expected.signing);
		expect(closedValue(view, 'completed')).toBe(expected.completed);
		expect(closedValue(view, 'cancelled')).toBe(expected.cancelled);
	});

	it('раскладывает по стадиям ровно так, как посчитано в документе — конец декабря', async () => {
		const view = await buildReport(admin(), query({ mode: 'snapshot', ...QUARTER_PERIOD }));
		const expected = EXPECTED_SNAPSHOT.december;

		expect(view.rows.length).toBe(expected.rows);
		expect(stageValue(view, 'contact_search')).toBe(expected.contact_search);
		expect(stageValue(view, 'communication')).toBe(expected.communication);
		expect(stageValue(view, 'meeting')).toBe(expected.meeting);
		expect(stageValue(view, 'document_exchange')).toBe(expected.document_exchange);
		expect(closedValue(view, 'completed')).toBe(expected.completed);
		expect(closedValue(view, 'cancelled')).toBe(expected.cancelled);
	});

	it('пауза стадию не меняет и показывается признаком', async () => {
		const view = await buildReport(admin(), query({ mode: 'snapshot', ...QUARTER_PERIOD }));

		// В-5 стоит на коммуникации с незакрытой паузой: часы норматива стоят, а
		// процесс — нет.
		expect(view.totals.paused).toBe(1);
		expect(stageValue(view, 'communication')).toBe(1);
	});

	it('фильтр «только на паузе» отбирает те же записи, что и признак', async () => {
		const view = await buildReport(
			admin(),
			query({ mode: 'snapshot', ...QUARTER_PERIOD, paused: 'true' })
		);

		expect(view.rows.length).toBe(1);
		expect(view.totals.paused).toBe(1);
	});

	it('фильтр «только просроченные» отбирает ровно просроченные на момент среза', async () => {
		const all = await buildReport(admin(), query({ mode: 'snapshot', ...QUARTER_PERIOD }));
		const overdue = await buildReport(
			admin(),
			query({ mode: 'snapshot', ...QUARTER_PERIOD, overdue: 'true' })
		);

		expect(overdue.rows.length).toBe(all.totals.overdue);
		expect(overdue.totals.overdue).toBe(overdue.rows.length);
	});

	it('соблюдает И1 и И2', async () => {
		for (const period of [SEPTEMBER_PERIOD, QUARTER_PERIOD]) {
			const view = await buildReport(admin(), query({ mode: 'snapshot', ...period }));

			expect(checkReportInvariants(view)).toStrictEqual([]);
		}
	});

	it('даёт разрезы документа и предупреждает о двойном счёте по продуктам', async () => {
		const september = await buildReport(admin(), query({ mode: 'snapshot', ...SEPTEMBER_PERIOD }));
		const december = await buildReport(admin(), query({ mode: 'snapshot', ...QUARTER_PERIOD }));

		expect(breakdown(september, 'organizations')).toStrictEqual(
			EXPECTED_BREAKDOWNS.september.organizations
		);
		expect(breakdown(september, 'directions')).toStrictEqual(
			EXPECTED_BREAKDOWNS.september.directions
		);
		expect(breakdown(september, 'products')).toStrictEqual(EXPECTED_BREAKDOWNS.september.products);
		expect(breakdown(december, 'organizations')).toStrictEqual(
			EXPECTED_BREAKDOWNS.december.organizations
		);
		expect(breakdown(december, 'directions')).toStrictEqual(
			EXPECTED_BREAKDOWNS.december.directions
		);
		expect(breakdown(december, 'products')).toStrictEqual(EXPECTED_BREAKDOWNS.december.products);

		const products = december.charts.breakdowns.find((item) => item.key === 'products');
		const sum = (products?.points ?? []).reduce((total, point) => total + point.value, 0);

		// В-1 учтено и в П-1, и в П-1б: сумма по строкам разреза законно больше
		// числа строк отчёта, и разрез называет число таких записей.
		expect(sum).toBe(EXPECTED_BREAKDOWNS.december.productsTotal);
		expect(sum).toBeGreaterThan(december.rows.length);
		expect(products?.doubleCounted).toBe(1);
	});
});

describe('движение за период', () => {
	it('даёт одиннадцать строк, разложенных по видам событий', async () => {
		const view = await buildReport(admin(), query({ mode: 'movement', ...QUARTER_PERIOD }));

		expect(view.rows.length).toBe(EXPECTED_MOVEMENT.rows);
		expect(eventCounts(view)).toStrictEqual(EXPECTED_MOVEMENT.kinds);
		expect(checkReportInvariants(view)).toStrictEqual([]);
	});

	it('считает повторный проход через стадию отдельными строками', async () => {
		const view = await buildReport(admin(), query({ mode: 'movement', ...QUARTER_PERIOD }));

		// В-2 прошло «коммуникация → встреча» дважды: событий действительно два.
		const secondInteraction = view.rows.filter(
			(row) => row.interactionId === ids.interactions['В-2']
		);

		expect(secondInteraction.length).toBe(3);
		expect(view.totals.interactionCount).toBeLessThan(view.rows.length);
	});

	it('раскладывается по вузам и направлениям так же, как в документе', async () => {
		const view = await buildReport(admin(), query({ mode: 'movement', ...QUARTER_PERIOD }));

		expect(breakdown(view, 'organizations')).toStrictEqual(EXPECTED_MOVEMENT.organizations);
		expect(breakdown(view, 'directions')).toStrictEqual(EXPECTED_MOVEMENT.directions);
	});

	it('не считает паузу событием движения', async () => {
		const view = await buildReport(
			admin(),
			query({ mode: 'movement', from: '2026-10-19', to: '2026-10-21' })
		);

		// В эти три дня случилась только пауза В-5.
		expect(view.rows.length).toBe(0);
	});
});

describe('сверка режимов (И4)', () => {
	it('связывает два среза с движением по каждой стадии', async () => {
		const rows = await reconcileModes(admin(), query({ mode: 'movement', ...QUARTER_PERIOD }));

		for (const expected of EXPECTED_RECONCILIATION) {
			const row = rows.find(
				(item) => item.bucketId.endsWith(`:${expected.stage}`) || item.bucketId === expected.stage
			);

			expect(row, `нет строки сверки для ${expected.stage}`).toBeDefined();
			expect({ entered: row!.entered, left: row!.left }).toStrictEqual({
				entered: expected.entered,
				left: expected.left
			});
			expect(row!.end - row!.start).toBe(row!.entered - row!.left);
		}

		expect(rows.every((row) => row.balanced)).toBe(true);

		const entered = rows.reduce((sum, row) => sum + row.entered, 0);
		const left = rows.reduce((sum, row) => sum + row.left, 0);

		// Вошло на одно больше, чем вышло: у строки «начато» нет стороны «откуда»,
		// и ровно на столько выросла выборка среза.
		expect(entered).toBe(11);
		expect(left).toBe(10);
		expect(entered - left).toBe(EXPECTED_SNAPSHOT.december.rows - EXPECTED_SNAPSHOT.september.rows);
	});
});

describe('история процесса', () => {
	it('после переименования стадии числа на прошлую дату не меняются', async () => {
		const asOf = query({ mode: 'snapshot', from: '2026-10-01', to: '2026-12-15' });
		const before = await buildReport(admin(), asOf);

		await renameStage(database.db, ids, 'meeting', 'Встреча с руководством');

		const after = await buildReport(admin(), asOf);

		expect(after.rows.length).toBe(before.rows.length);
		expect(stageValue(after, 'meeting')).toBe(stageValue(before, 'meeting'));
		expect(stageValue(after, 'communication')).toBe(stageValue(before, 'communication'));

		// Поменяться может только название стадии в заголовке колонки.
		const label = (view: ReportView) =>
			funnelStages(view).find((bucket) => bucket.key.endsWith(':meeting'))?.label;

		expect(label(before)).toBe('Встреча с представителями');
		expect(label(after)).toBe('Встреча с руководством');
	});

	it('срок на стадии считается на дату среза, а не на день сборки отчёта', async () => {
		const view = await buildReport(
			admin(),
			query({
				mode: 'snapshot',
				...SEPTEMBER_PERIOD,
				cols: 'interaction,organization,daysOnStage'
			})
		);

		const days = (code: 'В-3' | 'В-7'): number | null => {
			const row = view.rows.find((item) => item.interactionId === ids.interactions[code]);
			const cell = row?.cells[2];

			return cell !== undefined && cell.kind === 'number' ? cell.value : null;
		};

		// В-7 вошло на коммуникацию 15.09 в полдень, В-3 на обмен документами —
		// 28.09; срез считается на 01.10 00:00 по Москве. Числа посчитаны от этой
		// границы: собранный в другой день отчёт дал бы другие, если бы окно
		// открытой записи тянулось до `now()`.
		expect(days('В-7')).toBe(15);
		expect(days('В-3')).toBe(2);
	});

	it('пауза вычитается из срока по состоянию на дату среза', async () => {
		const view = await buildReport(
			admin(),
			query({
				mode: 'snapshot',
				...QUARTER_PERIOD,
				cols: 'interaction,organization,daysOnStage,paused'
			})
		);

		const row = view.rows.find((item) => item.interactionId === ids.interactions['В-5']);
		const days = row?.cells[2];
		const paused = row?.cells[3];

		// В-5 вошло на коммуникацию 02.10 и встало на паузу 20.10, не сняв её до
		// конца периода: активных дней ровно восемнадцать, сколько бы месяцев ни
		// прошло до сборки отчёта.
		expect(days?.kind === 'number' ? days.value : null).toBe(18);
		expect(paused?.kind === 'text' ? paused.value : null).toBe('Ждём ответа контрагента');
	});
});

describe('область доступа', () => {
	it('показывает только записи своей области и не уносит чужие в выборку', async () => {
		const outsider = await insertUser(database.db, {
			email: 'outsider@example.org',
			roleId: 'manager'
		});

		// Ответственный за «Вуз Б»: его область — этот вуз и его собственные
		// записи, а взаимодействия «Вуза А» в неё не входят.
		await database.db.insert(organizationResponsibles).values({
			organizationId: ids.organizations.b,
			userId: outsider
		});

		const limited = delegatedActor([outsider], await allWorkspaceIds(database.db));
		const view = await buildReport(limited, query({ mode: 'snapshot', ...QUARTER_PERIOD }));
		const names = new Set(
			view.rows.map((row) => {
				const cell = row.cells[1];

				return cell.kind === 'text' ? cell.value : null;
			})
		);

		expect(names).toStrictEqual(new Set(['Вуз Б']));
		expect(view.rows.length).toBeLessThan(EXPECTED_SNAPSHOT.december.rows);
	});

	it('пустая область не показывает ничего', async () => {
		const stranger = await insertUser(database.db, {
			email: 'stranger@example.org',
			roleId: 'manager'
		});

		const view = await buildReport(
			delegatedActor([stranger], await allWorkspaceIds(database.db)),
			query({ mode: 'snapshot', ...QUARTER_PERIOD })
		);

		expect(view.rows.length).toBe(0);
	});

	it('И6: строк в отчёте столько же, сколько в списке взаимодействий', async () => {
		const ctx = delegatedActor([TEST_USER_IDS.admin], await allWorkspaceIds(database.db));
		const period = { from: '2026-01-01', to: '2027-01-31' };

		const view = await buildReport(ctx, query({ mode: 'snapshot', ...period, state: 'active' }));
		const list = await listInteractions(
			ctx,
			interactionListQuerySchema.parse({ status: 'active', pageSize: 100 })
		);

		expect(view.rows.length).toBe(list.total);
	});

	it('фильтр по вузу сужает отчёт так же, как список', async () => {
		const ctx = admin();
		const period = { from: '2026-01-01', to: '2027-01-31' };

		const view = await buildReport(
			ctx,
			query({ mode: 'snapshot', ...period, state: 'active', org: ids.organizations.a })
		);
		const list = await listInteractions(
			ctx,
			interactionListQuerySchema.parse({
				status: 'active',
				organizationId: ids.organizations.a,
				pageSize: 100
			})
		);

		expect(view.rows.length).toBe(list.total);
	});
});

describe('фильтры', () => {
	it('фильтр по продукту считает взаимодействие подходящим по любому из его продуктов', async () => {
		const view = await buildReport(
			admin(),
			query({ mode: 'snapshot', ...QUARTER_PERIOD, prod: ids.products['П-1б'] })
		);

		expect(view.rows.length).toBe(1);
		expect(view.rows[0].interactionId).toBe(ids.interactions['В-1']);
	});

	it('фильтр по направлению объединяет направления продуктов', async () => {
		const view = await buildReport(
			admin(),
			query({ mode: 'snapshot', ...QUARTER_PERIOD, dir: ids.directions.qa })
		);

		expect(view.rows.length).toBe(EXPECTED_BREAKDOWNS.december.directions.QA);
	});

	it('фильтр по стадии в движении бьёт и по «откуда», и по «куда»', async () => {
		const view = await buildReport(
			admin(),
			query({ mode: 'movement', ...QUARTER_PERIOD, stage: 'meeting' })
		);

		// Четыре входа на встречу и один уход с неё.
		expect(view.rows.length).toBe(5);
	});

	it('договор и статус передачи приезжают в строку списком выбранных позиций', async () => {
		const view = await buildReport(
			admin(),
			query({
				mode: 'snapshot',
				...QUARTER_PERIOD,
				org: ids.organizations.a,
				cols: 'interaction,organization,contract,transferStatus'
			})
		);

		const row = view.rows.find((item) => item.interactionId === ids.interactions['В-1']);
		const contract = row?.cells[2];
		const transfer = row?.cells[3];

		expect(contract?.kind === 'text' ? contract.value : null).toBe('Д-2026/1');
		expect(transfer?.kind === 'list' ? [...transfer.values].sort() : []).toStrictEqual([
			'готовится',
			'передан'
		]);
	});

	it('ответственный за вуз показывается по назначениям, действовавшим на дату среза', async () => {
		const assignee = await insertUser(database.db, {
			email: 'assignee@example.org',
			roleId: 'manager'
		});

		await database.db.insert(organizationResponsibles).values({
			organizationId: ids.organizations.a,
			userId: assignee,
			validFrom: new Date('2026-11-01T00:00:00.000+03:00')
		});

		const before = await buildReport(
			admin(),
			query({
				mode: 'snapshot',
				...SEPTEMBER_PERIOD,
				org: ids.organizations.a,
				cols: 'interaction,organization,assignee'
			})
		);

		const after = await buildReport(
			admin(),
			query({
				mode: 'snapshot',
				...QUARTER_PERIOD,
				org: ids.organizations.a,
				cols: 'interaction,organization,assignee'
			})
		);

		const assignees = (view: ReportView) => {
			const cell = view.rows[0]?.cells[2];

			return cell !== undefined && cell.kind === 'list' ? cell.values : [];
		};

		// Назначение начало действовать 01.11: в сентябрьском срезе его ещё нет.
		expect(assignees(before)).toStrictEqual([]);
		expect(assignees(after).length).toBe(1);
	});
});

describe('граница окна записи', () => {
	it('переход ровно в момент среза относится уже к следующим суткам', async () => {
		// В-3 ушло с обмена документами 18.10. Срез на 17.10 застаёт его там,
		// срез на 18.10 — уже на подписании: правая граница нестрогая.
		const before = await buildReport(
			admin(),
			query({ mode: 'snapshot', from: '2026-10-01', to: '2026-10-17' })
		);
		const after = await buildReport(
			admin(),
			query({ mode: 'snapshot', from: '2026-10-01', to: '2026-10-18' })
		);

		expect(stageValue(before, 'document_exchange')).toBe(1);
		expect(stageValue(before, 'signing')).toBe(0);
		expect(stageValue(after, 'document_exchange')).toBe(0);
		expect(stageValue(after, 'signing')).toBe(1);
	});

	it('переход ровно в момент среза остаётся на прежней стадии', async () => {
		const boundary = await addBoundaryInteraction(database.db, ids, TEST_USER_IDS.admin);

		// `T` среза на 31.10 — это 01.11 00:00, тот самый момент перехода. Правило
		// `entered_at < T <= left_at` оставляет запись на прежней стадии: переход
		// ровно в `T` относится уже к следующим суткам.
		const before = await buildReport(
			admin(),
			query({ mode: 'snapshot', from: '2026-10-01', to: '2026-10-31' })
		);
		const after = await buildReport(
			admin(),
			query({ mode: 'snapshot', from: '2026-10-01', to: '2026-11-01' })
		);

		const stageOf = (view: ReportView): string | null => {
			const row = view.rows.find((item) => item.interactionId === boundary);
			const cell = row?.cells.at(-1);

			return cell !== undefined && cell.kind === 'text' ? cell.value : null;
		};

		expect(stageOf(before)).toBe('Поиск контактных лиц');
		expect(stageOf(after)).toBe('Коммуникация и сверка программ');
	});

	it('переход ровно в момент среза не попадает в движение предыдущего периода', async () => {
		const boundary = await addBoundaryInteraction(database.db, ids, TEST_USER_IDS.admin);

		const period = (from: string, to: string) =>
			buildReport(admin(), query({ mode: 'movement', from, to, cols: 'interaction,moveKind' }));

		const kinds = (view: ReportView): string[] =>
			view.rows
				.filter((row) => row.interactionId === boundary)
				.map((row) => (row.cells[2].kind === 'text' ? (row.cells[2].value ?? '') : ''));

		// Ни одно событие не попадает в два периода и ни одно не теряется между
		// ними: полуоткрытый промежуток кончается в `T`, и переход ровно в `T`
		// принадлежит уже следующему периоду. В октябре у записи только начало
		// работы, сам переход — в ноябре.
		expect(kinds(await period('2026-10-01', '2026-10-31'))).toStrictEqual(['Начато']);
		expect(kinds(await period('2026-11-01', '2026-11-30'))).toStrictEqual(['Вперёд']);
	});

	it('одна запись о стадии даёт две строки движения, и у них разные имена', async () => {
		const boundary = await addBoundaryInteraction(database.db, ids, TEST_USER_IDS.admin);

		// В-9 и начато, и ушло со своей первой стадии внутри октября — ноября:
		// событий два, запись о стадии одна. Имя строки обязано их различать,
		// иначе таблица на экране получает два одинаковых ключа и перестаёт
		// обновляться, показывая числа прошлой выборки.
		const view = await buildReport(
			admin(),
			query({ mode: 'movement', from: '2026-10-01', to: '2026-11-30' })
		);

		const rows = view.rows.filter((row) => row.interactionId === boundary);

		expect(rows.length).toBe(2);
		expect(new Set(rows.map((row) => row.stageEntryId)).size).toBe(1);
		expect(new Set(rows.map((row) => row.rowKey)).size).toBe(2);
	});

	it('имена строк различны во всей выборке в обоих режимах', async () => {
		await addBoundaryInteraction(database.db, ids, TEST_USER_IDS.admin);

		for (const mode of ['snapshot', 'movement'] as const) {
			const view = await buildReport(
				admin(),
				query({ mode, from: '2026-10-01', to: '2026-11-30' })
			);

			expect(new Set(view.rows.map((row) => row.rowKey)).size).toBe(view.rows.length);
		}
	});

	it('событие последнего дня периода входит в движение, а следующего — нет', async () => {
		const inside = await buildReport(
			admin(),
			query({ mode: 'movement', from: '2026-10-18', to: '2026-10-18' })
		);
		const outside = await buildReport(
			admin(),
			query({ mode: 'movement', from: '2026-10-19', to: '2026-10-19' })
		);

		expect(inside.rows.length).toBe(1);
		expect(outside.rows.length).toBe(0);
	});
});

describe('закрытие взаимодействия', () => {
	it('закрытые до начала периода в срез не входят', async () => {
		const within = await buildReport(
			admin(),
			query({ mode: 'snapshot', from: '2026-08-01', to: '2026-09-30' })
		);
		const outside = await buildReport(admin(), query({ mode: 'snapshot', ...SEPTEMBER_PERIOD }));

		// В-8 отменено 30.08: период, начинающийся в августе, его показывает,
		// сентябрьский — нет.
		expect(within.rows.some((row) => row.interactionId === ids.interactions['В-8'])).toBe(true);
		expect(outside.rows.some((row) => row.interactionId === ids.interactions['В-8'])).toBe(false);
	});

	it('созданные после даты среза в него не входят', async () => {
		const view = await buildReport(admin(), query({ mode: 'snapshot', ...SEPTEMBER_PERIOD }));

		expect(view.rows.some((row) => row.interactionId === ids.interactions['В-6'])).toBe(false);
	});
});

describe('от числа к подтверждению', () => {
	/** Ячейка строки по ключу колонки: порядок ячеек задаёт `meta.columns`. */
	function cell(view: ReportView, interactionId: string, key: string) {
		const row = view.rows.find((item) => item.interactionId === interactionId);
		const position = view.meta.columns.findIndex((column) => column.key === key);

		return row === undefined || position < 0 ? undefined : row.cells[position];
	}

	it('колонка «Программы» показывает программы взаимодействия, а не размножает строки', async () => {
		const asked = query({ mode: 'snapshot', ...QUARTER_PERIOD });
		const view = await buildReport(admin(), asked);

		// Колонка входит в набор по умолчанию: спрашивать её отдельно не нужно.
		expect(view.meta.columns.some((column) => column.key === 'programs')).toBe(true);

		expect(cell(view, ids.interactions['В-1'], 'programs')).toStrictEqual({
			kind: 'list',
			values: ['ПР-1 DevOps для вузов']
		});
		// Связь многие ко многим строку не удваивает: зерно среза — взаимодействие.
		expect(view.rows.filter((row) => row.interactionId === ids.interactions['В-1']).length).toBe(1);
		expect(cell(view, ids.interactions['В-2'], 'programs')).toStrictEqual({
			kind: 'list',
			values: []
		});
	});

	it('строка несёт ключи документа и учебной группы', async () => {
		const asked = query({ mode: 'snapshot', ...QUARTER_PERIOD });
		const view = await buildReport(admin(), asked);
		const row = view.rows.find((item) => item.interactionId === ids.interactions['В-1']);

		expect(row?.documents).toStrictEqual([
			{
				id: ids.documentId,
				kind: 'agreement',
				storageKey: 'files/reference-agreement',
				sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
			}
		]);
		expect(row?.learningGroups).toStrictEqual([
			{
				id: ids.learningGroupId,
				externalId: 'LMS-REF-1',
				resultId: ids.learningGroupResultId
			}
		]);

		// Подтверждать нечем — пустой список, а не пропуск поля.
		const other = view.rows.find((item) => item.interactionId === ids.interactions['В-2']);

		expect(other?.documents).toStrictEqual([]);
		expect(other?.learningGroups).toStrictEqual([]);
	});

	it('в движении те же ключи едут на каждом событии записи', async () => {
		const view = await buildReport(admin(), query({ mode: 'movement', ...QUARTER_PERIOD }));
		const rows = view.rows.filter((row) => row.interactionId === ids.interactions['В-1']);

		expect(rows.length).toBeGreaterThan(0);

		for (const row of rows) {
			expect(row.documents.map((document) => document.id)).toStrictEqual([ids.documentId]);
			expect(row.learningGroups.map((workspace) => workspace.id)).toStrictEqual([
				ids.learningGroupId
			]);
		}
	});
});
