/**
 * Импорт данных об обучении на настоящей базе.
 *
 * Здесь проверяется то, чего не проверить на заглушке: представление
 * показателей (оно и решает, что считается актуальным), замещение полной
 * выгрузки, версия строки после исправления и разница между нулём и
 * отсутствием данных — разница, которая живёт в `sum(...)` PostgreSQL.
 */
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StatSnapshotView } from '$lib/contracts/stats';
import { auditEvents, programs, statRows, statSnapshots } from '$lib/server/db/schema';
import { ConflictError, ForbiddenError, ValidationError } from '$lib/server/errors';
import {
	applyMapping,
	confirmSnapshot,
	createSnapshot,
	rejectSnapshot,
	validateSnapshot
} from '$lib/server/stats/import';
import { suggestMapping } from '$lib/server/stats/mapping';
import {
	getSnapshotPreview,
	listIndicators,
	listPeriods,
	listSnapshotRows,
	listSnapshots,
	rankPrograms
} from '$lib/server/stats/read';
import { insertOrganization, startTestDatabase, testActor, type TestDatabase } from '../helpers/db';

// См. комментарий в `helpers/db.ts`: без этого сервисы пойдут в базу разработчика.
vi.mock('$env/dynamic/private', () => ({ env: process.env }));

let database: TestDatabase;

const PERIOD = { periodStart: '2026-09-01', periodEnd: '2027-08-31' } as const;

const HEADER = 'Вуз;Код программы;Подано заявок;Зачислено;Параллельные потоки;Завершили обучение';

/** Шапка и строки в том виде, в каком их сохраняет русский Excel. */
function csv(...rows: string[]): Uint8Array {
	return new TextEncoder().encode([HEADER, ...rows].join('\r\n') + '\r\n');
}

/** Справочник, на который ссылается выгрузка. */
async function directory(): Promise<{ szpu: string; pupi: string }> {
	const szpu = await insertOrganization(database.db, { shortName: 'СЗПУ', inn: '7802450127' });
	const pupi = await insertOrganization(database.db, { shortName: 'ПУПИ', inn: '5203660080' });

	await database.db.insert(programs).values([
		{ code: 'VO-BAK-01', name: 'Прикладная информатика', level: 'bachelor', status: 'active' },
		{ code: 'VO-MAG-01', name: 'Инженерия данных', level: 'master', status: 'active' }
	]);

	return { szpu, pupi };
}

async function programId(code: string): Promise<string> {
	const [row] = await database.db
		.select({ id: programs.id })
		.from(programs)
		.where(eq(programs.code, code));

	return row.id;
}

type ImportOptions = {
	mode?: 'full' | 'append' | 'correction';
	source?: 'file' | 'lms';
	name?: string;
};

/**
 * Полный путь загрузки: файл, предложенное сопоставление, разбор и проверка.
 * Сопоставление берётся из подсказки — путь «человек согласился с
 * предложением» проходится в каждом тесте, а не только в своём.
 */
async function importCsv(
	ctx: ReturnType<typeof testActor>,
	bytes: Uint8Array,
	options: ImportOptions = {}
): Promise<StatSnapshotView> {
	const created = await createSnapshot(ctx, {
		source: options.source ?? 'file',
		mode: options.mode ?? 'full',
		periodKind: 'academic',
		...PERIOD,
		file: { name: options.name ?? 'выгрузка.csv', bytes }
	});

	const preview = await getSnapshotPreview(ctx, created.id);
	await applyMapping(ctx, created.id, suggestMapping(preview.headers));

	return validateSnapshot(ctx, created.id);
}

beforeAll(async () => {
	// Хранилище файлов у прогона своё и начинается пустым: и база, и бакет
	// живут в контейнерах, которые поднимает `startTestDatabase`.
	database = await startTestDatabase();
}, 300_000);

afterAll(async () => {
	await database?.stop();
});

beforeEach(async () => {
	await database.reset();
});

describe('загрузка файла', () => {
	it('принимает csv, показывает превью и предлагает сопоставление', async () => {
		await directory();
		const ctx = testActor({ roleId: 'manager' });

		const snapshot = await createSnapshot(ctx, {
			source: 'file',
			mode: 'full',
			periodKind: 'academic',
			...PERIOD,
			file: { name: 'вузы-2026.csv', bytes: csv('СЗПУ;VO-BAK-01;120;90;3;80') }
		});

		expect(snapshot.status).toBe('uploading');
		expect(snapshot.fileDocumentId).not.toBeNull();

		const preview = await getSnapshotPreview(ctx, snapshot.id);

		expect(preview.headers).toStrictEqual([
			'Вуз',
			'Код программы',
			'Подано заявок',
			'Зачислено',
			'Параллельные потоки',
			'Завершили обучение'
		]);
		expect(preview.totalRows).toBe(1);
		expect(preview.sample[0]).toMatchObject({ Вуз: 'СЗПУ', 'Подано заявок': '120' });

		// Подсказка обязана снимать с человека основную часть разметки.
		const suggested = preview.advice.filter((advice) => advice.field !== null);

		expect(suggested.length).toBeGreaterThanOrEqual(4);
		expect(suggestMapping(preview.headers)).toMatchObject({
			Вуз: 'organization',
			'Код программы': 'program',
			'Подано заявок': 'applications',
			Зачислено: 'enrolled'
		});
	});

	it('не принимает файл, который не похож на таблицу', async () => {
		const ctx = testActor({ roleId: 'manager' });

		await expect(
			createSnapshot(ctx, {
				source: 'file',
				mode: 'full',
				periodKind: 'academic',
				...PERIOD,
				file: { name: 'скан.pdf', bytes: new TextEncoder().encode('%PDF-1.7\n%%EOF\n') }
			})
		).rejects.toBeInstanceOf(ValidationError);
	});

	it('отказывает, когда обязательные поля не сопоставлены', async () => {
		await directory();
		const ctx = testActor({ roleId: 'manager' });

		const snapshot = await createSnapshot(ctx, {
			source: 'file',
			mode: 'full',
			periodKind: 'academic',
			...PERIOD,
			file: { name: 'выгрузка.csv', bytes: csv('СЗПУ;VO-BAK-01;120;90;3;80') }
		});

		await expect(
			applyMapping(ctx, snapshot.id, { 'Подано заявок': 'applications' })
		).rejects.toThrowError('Сопоставлены не все обязательные поля');
	});
});

describe('разбор строк', () => {
	it('объясняет неизвестную организацию, нечисловое значение и дубль', async () => {
		await directory();
		const ctx = testActor({ roleId: 'manager' });

		const snapshot = await importCsv(
			ctx,
			csv(
				'СЗПУ;VO-BAK-01;120;90;3;80',
				'ПУПИ;VO-MAG-01;0;0;0;0',
				'Институт цифровых технологий;VO-BAK-01;10;5;1;2',
				'СЗПУ;VO-MAG-01;много;5;1;2',
				'СЗПУ;VO-BAK-01;5;5;1;1'
			)
		);

		expect(snapshot.status).toBe('validated');
		expect(snapshot.rowCount).toBe(5);
		// Неизвестная организация, нечисловое значение и две строки дубля.
		expect(snapshot.errorCount).toBe(4);

		const rows = await listSnapshotRows(ctx, snapshot.id, {
			onlyIssues: true,
			page: 1,
			pageSize: 50
		});
		const messages = rows.items.flatMap((row) => row.issues.map((issue) => issue.message));

		expect(rows.total).toBe(4);
		expect(messages.some((message) => message.includes('не найдена в справочнике'))).toBe(true);
		expect(messages.some((message) => message.includes('не похоже на целое число'))).toBe(true);
		expect(messages.filter((message) => message.startsWith('Дубль'))).toHaveLength(2);

		// Верная строка осталась одна — та, где ноль записан как ноль.
		const valid = await listSnapshotRows(ctx, snapshot.id, {
			onlyIssues: false,
			page: 1,
			pageSize: 50
		});

		expect(valid.items.filter((row) => row.isValid)).toHaveLength(1);
	});

	it('переписывает строки, когда сопоставление применили заново', async () => {
		await directory();
		const ctx = testActor({ roleId: 'manager' });

		const created = await createSnapshot(ctx, {
			source: 'file',
			mode: 'full',
			periodKind: 'academic',
			...PERIOD,
			file: { name: 'выгрузка.csv', bytes: csv('СЗПУ;VO-BAK-01;120;90;3;80') }
		});

		const full = suggestMapping([
			'Вуз',
			'Код программы',
			'Подано заявок',
			'Зачислено',
			'Параллельные потоки',
			'Завершили обучение'
		]);

		await applyMapping(ctx, created.id, full);
		const { 'Подано заявок': _dropped, ...withoutApplications } = full;
		const snapshot = await applyMapping(ctx, created.id, withoutApplications);

		expect(snapshot.rowCount).toBe(1);

		const rows = await listSnapshotRows(ctx, created.id, {
			onlyIssues: false,
			page: 1,
			pageSize: 50
		});

		expect(rows.total).toBe(1);
		// Колонку перестали брать — значение обязано исчезнуть, а не остаться
		// от прошлого разбора.
		expect(rows.items[0].applications).toBeNull();
		expect(rows.items[0].enrolled).toBe(90);
	});
});

describe('подтверждение', () => {
	it('делает снимок текущим и показывает его в показателях', async () => {
		const { szpu } = await directory();
		const ctx = testActor({ roleId: 'manager' });

		const snapshot = await importCsv(ctx, csv('СЗПУ;VO-BAK-01;120;90;3;80'));
		const { snapshot: confirmed } = await confirmSnapshot(ctx, snapshot.id);

		expect(confirmed.status).toBe('confirmed');
		expect(confirmed.isCurrent).toBe(true);
		expect(confirmed.confirmedAt).not.toBeNull();

		const indicators = await listIndicators(ctx, {
			programId: null,
			organizationId: null,
			period: { start: PERIOD.periodStart, end: PERIOD.periodEnd },
			page: 1,
			pageSize: 20
		});

		expect(indicators.items).toHaveLength(1);
		expect(indicators.items[0]).toMatchObject({
			organizationId: szpu,
			applications: 120,
			enrolled: 90,
			parallelStreams: 3,
			completed: 80,
			rowCount: 1,
			snapshotCount: 1
		});

		const periods = await listPeriods(ctx);

		expect(periods).toStrictEqual([
			{ kind: 'academic', start: PERIOD.periodStart, end: PERIOD.periodEnd }
		]);
	});

	it('не подтверждает снимок, в котором нет ни одной верной строки', async () => {
		await directory();
		const ctx = testActor({ roleId: 'manager' });

		const snapshot = await importCsv(ctx, csv('Неизвестный вуз;VO-BAK-01;1;1;1;1'));

		await expect(confirmSnapshot(ctx, snapshot.id)).rejects.toBeInstanceOf(ConflictError);
	});

	it('не подтверждает снимок, который ещё не проверен', async () => {
		await directory();
		const ctx = testActor({ roleId: 'manager' });

		const created = await createSnapshot(ctx, {
			source: 'file',
			mode: 'full',
			periodKind: 'academic',
			...PERIOD,
			file: { name: 'выгрузка.csv', bytes: csv('СЗПУ;VO-BAK-01;120;90;3;80') }
		});

		await expect(confirmSnapshot(ctx, created.id)).rejects.toThrowError('ещё не проверен');
	});

	it('оставляет отклонённый снимок в системе вместе с причиной', async () => {
		await directory();
		const ctx = testActor({ roleId: 'manager' });

		const snapshot = await importCsv(ctx, csv('СЗПУ;VO-BAK-01;120;90;3;80'));
		const rejected = await rejectSnapshot(ctx, snapshot.id, 'Вуз прислал не тот период');

		expect(rejected.status).toBe('rejected');
		expect(rejected.isCurrent).toBe(false);
		expect(rejected.note).toBe('Вуз прислал не тот период');

		const rows = await listSnapshotRows(ctx, snapshot.id, {
			onlyIssues: false,
			page: 1,
			pageSize: 50
		});

		// Строки никуда не делись: по ним и видно, что именно не приняли.
		expect(rows.total).toBe(1);

		const indicators = await listIndicators(ctx, {
			programId: null,
			organizationId: null,
			period: null,
			page: 1,
			pageSize: 20
		});

		expect(indicators.items).toStrictEqual([]);
	});
});

describe('режимы', () => {
	it('полная выгрузка замещает прежнюю того же источника, периода и области', async () => {
		await directory();
		const ctx = testActor({ roleId: 'manager' });

		const first = await importCsv(ctx, csv('СЗПУ;VO-BAK-01;120;90;3;80'));
		await confirmSnapshot(ctx, first.id);

		const second = await importCsv(ctx, csv('СЗПУ;VO-BAK-01;150;110;4;95'));
		const { snapshot: confirmed } = await confirmSnapshot(ctx, second.id);

		expect(confirmed.supersedesSnapshotId).toBe(first.id);

		const [previous] = await database.db
			.select({ isCurrent: statSnapshots.isCurrent, status: statSnapshots.status })
			.from(statSnapshots)
			.where(eq(statSnapshots.id, first.id));

		// Прежняя выгрузка остаётся в базе, но перестаёт считаться.
		expect(previous).toStrictEqual({ isCurrent: false, status: 'confirmed' });

		const indicators = await listIndicators(ctx, {
			programId: null,
			organizationId: null,
			period: { start: PERIOD.periodStart, end: PERIOD.periodEnd },
			page: 1,
			pageSize: 20
		});

		expect(indicators.items).toHaveLength(1);
		expect(indicators.items[0]).toMatchObject({ applications: 150, snapshotCount: 1 });
	});

	it('дополнение ничего не вытесняет и складывается с текущим', async () => {
		await directory();
		const ctx = testActor({ roleId: 'manager' });

		const base = await importCsv(ctx, csv('СЗПУ;VO-BAK-01;120;90;3;80'));
		await confirmSnapshot(ctx, base.id);

		const extra = await importCsv(ctx, csv('ПУПИ;VO-MAG-01;40;30;2;25'), {
			mode: 'append',
			source: 'lms'
		});
		const { snapshot: confirmed } = await confirmSnapshot(ctx, extra.id);

		expect(confirmed.supersedesSnapshotId).toBeNull();

		const [previous] = await database.db
			.select({ isCurrent: statSnapshots.isCurrent })
			.from(statSnapshots)
			.where(eq(statSnapshots.id, base.id));

		expect(previous.isCurrent).toBe(true);

		const indicators = await listIndicators(ctx, {
			programId: null,
			organizationId: null,
			period: { start: PERIOD.periodStart, end: PERIOD.periodEnd },
			page: 1,
			pageSize: 20
		});

		expect(indicators.items).toHaveLength(2);
	});

	it('исправление заводит новую версию строки, а прежняя перестаёт считаться', async () => {
		await directory();
		const ctx = testActor({ roleId: 'manager' });

		const base = await importCsv(ctx, csv('СЗПУ;VO-BAK-01;120;90;3;80'));
		await confirmSnapshot(ctx, base.id);

		const correction = await importCsv(ctx, csv('СЗПУ;VO-BAK-01;130;95;3;80'), {
			mode: 'correction'
		});
		const { replacedRows } = await confirmSnapshot(ctx, correction.id);

		expect(replacedRows).toBe(1);

		const [old] = await database.db
			.select({ replacedByRowId: statRows.replacedByRowId, version: statRows.version })
			.from(statRows)
			.where(eq(statRows.snapshotId, base.id));

		const [fresh] = await database.db
			.select({ version: statRows.version, applications: statRows.applications })
			.from(statRows)
			.where(eq(statRows.snapshotId, correction.id));

		expect(old.replacedByRowId).not.toBeNull();
		expect(old.version).toBe(1);
		expect(fresh.version).toBe(2);

		const indicators = await listIndicators(ctx, {
			programId: null,
			organizationId: null,
			period: { start: PERIOD.periodStart, end: PERIOD.periodEnd },
			page: 1,
			pageSize: 20
		});

		// Показатель считается по исправленной строке, а не по сумме обеих.
		expect(indicators.items).toHaveLength(1);
		expect(indicators.items[0]).toMatchObject({ applications: 130, rowCount: 1 });
	});
});

describe('показатели', () => {
	it('различают ноль и отсутствие данных', async () => {
		await directory();
		const ctx = testActor({ roleId: 'manager' });

		// У первой строки «завершили обучение» пусто — год ещё идёт; у второй
		// везде записан ноль.
		const snapshot = await importCsv(
			ctx,
			csv('СЗПУ;VO-BAK-01;120;90;3;', 'ПУПИ;VO-MAG-01;0;0;0;0')
		);
		await confirmSnapshot(ctx, snapshot.id);

		const indicators = await listIndicators(ctx, {
			programId: null,
			organizationId: null,
			period: { start: PERIOD.periodStart, end: PERIOD.periodEnd },
			page: 1,
			pageSize: 20
		});

		const byProgram = new Map(indicators.items.map((item) => [item.programCode, item] as const));

		expect(byProgram.get('VO-BAK-01')).toMatchObject({ applications: 120, completed: null });
		expect(byProgram.get('VO-MAG-01')).toMatchObject({ applications: 0, completed: 0 });
	});

	it('не считают строки неподтверждённого снимка', async () => {
		await directory();
		const ctx = testActor({ roleId: 'manager' });

		await importCsv(ctx, csv('СЗПУ;VO-BAK-01;120;90;3;80'));

		const indicators = await listIndicators(ctx, {
			programId: null,
			organizationId: null,
			period: null,
			page: 1,
			pageSize: 20
		});

		expect(indicators.items).toStrictEqual([]);
	});

	it('отбираются по программе и организации', async () => {
		const { szpu } = await directory();
		const ctx = testActor({ roleId: 'manager' });

		const snapshot = await importCsv(
			ctx,
			csv('СЗПУ;VO-BAK-01;120;90;3;80', 'ПУПИ;VO-MAG-01;40;30;2;25')
		);
		await confirmSnapshot(ctx, snapshot.id);

		const byOrganization = await listIndicators(ctx, {
			programId: null,
			organizationId: szpu,
			period: null,
			page: 1,
			pageSize: 20
		});

		expect(byOrganization.items).toHaveLength(1);
		expect(byOrganization.items[0].organizationId).toBe(szpu);

		const byProgram = await listIndicators(ctx, {
			programId: await programId('VO-MAG-01'),
			organizationId: null,
			period: null,
			page: 1,
			pageSize: 20
		});

		expect(byProgram.items).toHaveLength(1);
		expect(byProgram.items[0].programCode).toBe('VO-MAG-01');
	});
});

describe('рейтинг', () => {
	it('объясняет балл, и сумма вкладов равна баллу', async () => {
		await directory();
		const ctx = testActor({ roleId: 'manager' });

		const snapshot = await importCsv(
			ctx,
			csv('СЗПУ;VO-BAK-01;120;90;3;80', 'ПУПИ;VO-MAG-01;40;30;2;25')
		);
		await confirmSnapshot(ctx, snapshot.id);

		const ranking = await rankPrograms(ctx, {
			period: { start: PERIOD.periodStart, end: PERIOD.periodEnd }
		});

		expect(ranking.map((item) => item.programCode)).toStrictEqual(['VO-BAK-01', 'VO-MAG-01']);

		for (const item of ranking) {
			const total = item.explanation.reduce((sum, part) => sum + part.contribution, 0);

			expect(total).toBe(item.score);
			expect(item.explanation.map((part) => part.component)).toStrictEqual([
				'applications',
				'enrolled',
				'parallelStreams'
			]);
		}

		expect(ranking[0].score).toBeGreaterThan(ranking[1].score);
		expect(ranking[0].organizationCount).toBe(1);
	});

	it('складывает организации одной программы', async () => {
		await directory();
		const ctx = testActor({ roleId: 'manager' });

		const snapshot = await importCsv(
			ctx,
			csv('СЗПУ;VO-BAK-01;120;90;3;80', 'ПУПИ;VO-BAK-01;40;30;2;25')
		);
		await confirmSnapshot(ctx, snapshot.id);

		const ranking = await rankPrograms(ctx, {
			period: { start: PERIOD.periodStart, end: PERIOD.periodEnd }
		});

		expect(ranking).toHaveLength(1);
		expect(ranking[0].organizationCount).toBe(2);
		expect(ranking[0].explanation[0].value).toBe(160);
	});
});

describe('права', () => {
	it('наблюдатель читает снимки, но не загружает их', async () => {
		await directory();
		const manager = testActor({ roleId: 'manager' });
		const viewer = testActor({ roleId: 'viewer' });

		const snapshot = await importCsv(manager, csv('СЗПУ;VO-BAK-01;120;90;3;80'));

		const list = await listSnapshots(viewer, {
			status: null,
			source: null,
			q: null,
			sortBy: 'createdAt',
			sortDirection: 'desc',
			page: 1,
			pageSize: 20
		});

		expect(list.total).toBe(1);

		await expect(
			createSnapshot(viewer, {
				source: 'file',
				mode: 'full',
				periodKind: 'academic',
				...PERIOD,
				file: { name: 'выгрузка.csv', bytes: csv('СЗПУ;VO-BAK-01;1;1;1;1') }
			})
		).rejects.toBeInstanceOf(ForbiddenError);

		await expect(confirmSnapshot(viewer, snapshot.id)).rejects.toBeInstanceOf(ForbiddenError);

		const denied = await database.db
			.select({ eventType: auditEvents.eventType, outcome: auditEvents.outcome })
			.from(auditEvents)
			.where(and(eq(auditEvents.outcome, 'denied')));

		// Попытка загрузить данные без права — это то, о чём администратор
		// должен узнать, а не молчаливый отказ в ответе.
		expect(denied).toContainEqual({ eventType: 'stats.snapshot_created', outcome: 'denied' });
		expect(denied).toContainEqual({ eventType: 'stats.snapshot_confirmed', outcome: 'denied' });
	});

	it('пишет в журнал загрузку, сопоставление и подтверждение', async () => {
		await directory();
		const ctx = testActor({ roleId: 'manager' });

		const snapshot = await importCsv(ctx, csv('СЗПУ;VO-BAK-01;120;90;3;80'));
		await confirmSnapshot(ctx, snapshot.id);

		const events = await database.db
			.select({ eventType: auditEvents.eventType, subjectId: auditEvents.subjectId })
			.from(auditEvents)
			.where(eq(auditEvents.outcome, 'success'));

		const types = events.map((event) => event.eventType);

		expect(types).toContain('stats.snapshot_created');
		expect(types).toContain('stats.snapshot_mapped');
		expect(types).toContain('stats.snapshot_confirmed');
		expect(events.filter((event) => event.subjectId === snapshot.id).length).toBeGreaterThan(0);
	});
});
