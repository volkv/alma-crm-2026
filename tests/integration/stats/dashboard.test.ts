/**
 * Дашборд портфеля данных на настоящей базе.
 *
 * Здесь проверяется то, чего не проверить на заглушке: картина периода
 * собирается тем же представлением, что и показатели (ноль и отсутствие данных
 * в нём живут в `sum(...)` PostgreSQL), происхождение называет настоящие
 * снимки, а кэш в Redis обесценивается подтверждением — иначе на дашборде
 * минуту висели бы числа, которых уже нет.
 */
import { and, eq, isNull } from 'drizzle-orm';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StatSnapshotView } from '$lib/contracts/stats';
import { organizationResponsibles, programs, statSnapshots } from '$lib/server/db/schema';
import { releaseResponsible } from '$lib/server/directory/responsibles';
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
import { getSnapshotPreview, listPeriods } from '$lib/server/stats/read';
import {
	insertOrganization,
	startTestDatabase,
	scopedActor,
	testActor,
	type TestDatabase
} from '../helpers/db';

// См. комментарий в `helpers/db.ts`: без этого сервисы пойдут в базу разработчика.
vi.mock('$env/dynamic/private', () => ({ env: process.env }));

let database: TestDatabase;

const PERIOD = { periodStart: '2026-09-01', periodEnd: '2027-08-31' } as const;
const PERIOD_KEY = { start: PERIOD.periodStart, end: PERIOD.periodEnd };

const HEADER = 'Вуз;Код программы;Подано заявок;Зачислено;Параллельные потоки;Завершили обучение';

function csv(...rows: string[]): Uint8Array {
	return new TextEncoder().encode([HEADER, ...rows].join('\r\n') + '\r\n');
}

/** Справочник выгрузки: вузовская программа и школьная — они не смешиваются. */
async function directory(): Promise<{ szpu: string; pupi: string }> {
	const szpu = await insertOrganization(database.db, { shortName: 'СЗПУ', inn: '7802450127' });
	const pupi = await insertOrganization(database.db, { shortName: 'ПУПИ', inn: '5203660080' });

	await database.db.insert(programs).values([
		{ code: 'VO-BAK-01', name: 'Прикладная информатика', level: 'bachelor', status: 'active' },
		{ code: 'SCHOOL-01', name: 'Цифровая профориентация', level: 'school', status: 'active' }
	]);

	return { szpu, pupi };
}

async function importCsv(
	ctx: ReturnType<typeof testActor>,
	bytes: Uint8Array,
	options: { mode?: 'full' | 'append' } = {}
): Promise<StatSnapshotView> {
	const created = await createSnapshot(ctx, {
		source: 'file',
		mode: options.mode ?? 'full',
		periodKind: 'academic',
		...PERIOD,
		file: { name: `выгрузка-${crypto.randomUUID().slice(0, 8)}.csv`, bytes }
	});

	const preview = await getSnapshotPreview(ctx, created.id);
	await applyMapping(ctx, created.id, suggestMapping(preview.headers));

	return validateSnapshot(ctx, created.id);
}

beforeAll(async () => {
	database = await startTestDatabase();
}, 300_000);

afterAll(async () => {
	// Кэш дашборда живёт в Redis: соединение надо закрыть, иначе прогон не
	// завершится.
	await getRedis().quit();
	await database?.stop();
});

beforeEach(async () => {
	await database.reset();
});

describe('портфель периода', () => {
	it('складывает подтверждённые снимки и различает ноль и отсутствие данных', async () => {
		const ctx = testActor();
		await directory();

		// У второй строки «зачислено» — записанный ноль, «завершили» — пропуск.
		const snapshot = await importCsv(
			ctx,
			csv('СЗПУ;VO-BAK-01;120;90;3;80', 'ПУПИ;SCHOOL-01;40;0;0;')
		);
		await confirmSnapshot(ctx, snapshot.id);

		const dashboard = await getStatsDashboard(ctx, {
			kind: 'academic',
			...PERIOD_KEY
		});

		expect(dashboard.totals.programCount).toBe(2);
		expect(dashboard.totals.organizationCount).toBe(2);
		expect(dashboard.totals.applications).toBe(160);
		expect(dashboard.totals.enrolled).toBe(90);
		// Одна строка завершивших, вторая — пропуск: сумма считается по тому,
		// что есть, а «нет данных вообще» осталось бы `null`.
		expect(dashboard.totals.completed).toBe(80);
		// Площадок в выгрузке не названо: это ноль площадок, а не ноль строк.
		expect(dashboard.totals.siteCount).toBe(0);
	});

	it('оставляет прочерк там, где колонки не было', async () => {
		const ctx = testActor();
		await directory();

		const snapshot = await importCsv(ctx, csv('СЗПУ;VO-BAK-01;120;90;3;'));
		await confirmSnapshot(ctx, snapshot.id);

		const dashboard = await getStatsDashboard(ctx, { kind: 'academic', ...PERIOD_KEY });

		expect(dashboard.totals.completed).toBeNull();
		expect(dashboard.totals.coveragePlan).toBeNull();
	});

	it('не берёт в портфель снимок, который никто не подтверждал', async () => {
		const ctx = testActor();
		await directory();

		await importCsv(ctx, csv('СЗПУ;VO-BAK-01;120;90;3;80'));

		const dashboard = await getStatsDashboard(ctx, { kind: 'academic', ...PERIOD_KEY });

		expect(dashboard.totals.programCount).toBe(0);
		expect(dashboard.totals.applications).toBeNull();
		expect(dashboard.sources).toStrictEqual([]);
		// Периода тоже ещё нет: он появляется вместе с подтверждёнными строками.
		expect(await listPeriods(ctx)).toStrictEqual([]);
	});

	it('держит школьные программы отдельно от вузовских', async () => {
		const ctx = testActor();
		await directory();

		const snapshot = await importCsv(
			ctx,
			csv('СЗПУ;VO-BAK-01;120;90;3;80', 'ПУПИ;SCHOOL-01;40;30;1;25')
		);
		await confirmSnapshot(ctx, snapshot.id);

		const dashboard = await getStatsDashboard(ctx, { kind: 'academic', ...PERIOD_KEY });
		const groups = new Map(dashboard.groups.map((group) => [group.group, group]));

		expect([...groups.keys()]).toStrictEqual(['university', 'school']);
		expect(groups.get('university')?.applications).toBe(120);
		expect(groups.get('school')?.applications).toBe(40);
		expect(groups.get('school')?.programCount).toBe(1);
	});

	it('называет снимки, из которых сложилась картина периода', async () => {
		const ctx = testActor();
		await directory();

		const snapshot = await importCsv(ctx, csv('СЗПУ;VO-BAK-01;120;90;3;80'));
		await confirmSnapshot(ctx, snapshot.id);

		const dashboard = await getStatsDashboard(ctx, { kind: 'academic', ...PERIOD_KEY });

		expect(dashboard.sources).toHaveLength(1);
		expect(dashboard.sources[0].snapshotId).toBe(snapshot.id);
		expect(dashboard.sources[0].source).toBe('file');
		expect(dashboard.sources[0].mode).toBe('full');
		expect(dashboard.sources[0].rowCount).toBe(1);
		expect(dashboard.sources[0].authorName).toBe('Тестовый Администратор');
		// Актуальность — это момент подтверждения, а не загрузки файла.
		expect(dashboard.updatedAt).toBe(dashboard.sources[0].confirmedAt);
		expect(dashboard.updatedAt).not.toBeNull();
	});

	it('показывает только организации из области доступа', async () => {
		const ctx = testActor();
		const { szpu } = await directory();

		const snapshot = await importCsv(
			ctx,
			csv('СЗПУ;VO-BAK-01;120;90;3;80', 'ПУПИ;SCHOOL-01;40;30;1;25')
		);
		await confirmSnapshot(ctx, snapshot.id);

		const curator = await scopedActor(database.db, { roleId: 'manager', organizationIds: [szpu] });
		const dashboard = await getStatsDashboard(curator, { kind: 'academic', ...PERIOD_KEY });

		expect(dashboard.totals.organizationCount).toBe(1);
		expect(dashboard.totals.applications).toBe(120);
		expect(dashboard.organizations.map((row) => row.organizationName)).toStrictEqual(['СЗПУ']);
	});

	it('закрыт без права на чтение данных', async () => {
		const ctx = testActor({ permissions: [] });

		await expect(
			getStatsDashboard(ctx, { kind: 'academic', ...PERIOD_KEY })
		).rejects.toBeInstanceOf(ForbiddenError);
	});
});

describe('кэш дашборда', () => {
	it('переживает изменение в обход сервиса и обесценивается подтверждением', async () => {
		const ctx = testActor();
		await directory();
		const period = { kind: 'academic', ...PERIOD_KEY } as const;

		const first = await importCsv(ctx, csv('СЗПУ;VO-BAK-01;120;90;3;80'));
		await confirmSnapshot(ctx, first.id);

		expect((await getStatsDashboard(ctx, period)).totals.applications).toBe(120);

		// Правка мимо сервиса: снимок перестал быть текущим, а собранный
		// дашборд об этом не знает — так видно, что ответ пришёл из кэша.
		await database.db
			.update(statSnapshots)
			.set({ isCurrent: false })
			.where(eq(statSnapshots.id, first.id));

		expect((await getStatsDashboard(ctx, period)).totals.applications).toBe(120);

		// Подтверждение второго снимка обесценивает кэш: в портфеле остаётся
		// только он, потому что первый уже не текущий.
		const second = await importCsv(ctx, csv('ПУПИ;SCHOOL-01;40;30;1;25'), { mode: 'append' });
		await confirmSnapshot(ctx, second.id);

		const fresh = await getStatsDashboard(ctx, period);

		expect(fresh.totals.applications).toBe(40);
		expect(fresh.sources.map((source) => source.snapshotId)).toStrictEqual([second.id]);
	});

	it('перестаёт показывать вуз прежнему ответственному сразу после снятия', async () => {
		const ctx = testActor();
		const { szpu } = await directory();
		const period = { kind: 'academic', ...PERIOD_KEY } as const;

		const snapshot = await importCsv(
			ctx,
			csv('СЗПУ;VO-BAK-01;120;90;3;80', 'ПУПИ;SCHOOL-01;40;30;1;25')
		);
		await confirmSnapshot(ctx, snapshot.id);

		// КАМ открыл сводку своего вуза — она легла в кэш на минуту.
		const curator = await scopedActor(database.db, { roleId: 'manager', organizationIds: [szpu] });

		expect((await getStatsDashboard(curator, period)).totals.applications).toBe(120);

		const [assignment] = await database.db
			.select({ id: organizationResponsibles.id })
			.from(organizationResponsibles)
			.where(
				and(
					eq(organizationResponsibles.organizationId, szpu),
					isNull(organizationResponsibles.validTo)
				)
			);

		// Вуз сняли — сервисом, тем же, которым это делает карточка вуза.
		await releaseResponsible(ctx, assignment.id);

		const afterRelease = await getStatsDashboard(curator, period);

		// Числа снятого вуза пропадают в ту же секунду, а не по сроку жизни
		// записи в Redis: в ключе кэша стоят действующие назначения области.
		expect(afterRelease.organizations).toStrictEqual([]);
		expect(afterRelease.totals.organizationCount).toBe(0);
		expect(afterRelease.totals.applications).toBeNull();

		// Выгрузка собирается из того же кэша, и «тот же экран в файле» обязано
		// значить и «те же пустые строки».
		const workbook = new ExcelJS.Workbook();
		const report = await buildStatsReport(afterRelease, '2026-09-12');

		await workbook.xlsx.load(report.body.slice().buffer as ArrayBuffer);

		const sheet = workbook.getWorksheet('Вузы и площадки');
		const names: unknown[] = [];

		sheet?.eachRow((row, index) => {
			if (index > 1) {
				names.push(row.getCell(1).value);
			}
		});

		expect(names).toStrictEqual([]);
	});

	it('не отдаёт картину одной области доступа другой', async () => {
		const ctx = testActor();
		const { szpu } = await directory();
		const period = { kind: 'academic', ...PERIOD_KEY } as const;

		const snapshot = await importCsv(
			ctx,
			csv('СЗПУ;VO-BAK-01;120;90;3;80', 'ПУПИ;SCHOOL-01;40;30;1;25')
		);
		await confirmSnapshot(ctx, snapshot.id);

		// Администратор собирает дашборд первым и кладёт его в кэш.
		expect((await getStatsDashboard(ctx, period)).totals.applications).toBe(160);

		const curator = await scopedActor(database.db, { roleId: 'manager', organizationIds: [szpu] });

		expect((await getStatsDashboard(curator, period)).totals.applications).toBe(120);
	});
});
