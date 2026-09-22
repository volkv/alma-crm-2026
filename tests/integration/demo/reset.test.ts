import type { RequestEvent } from '@sveltejs/kit';
import { count, eq, isNull, sql } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	auditEvents,
	comments,
	contracts,
	documents,
	interactions,
	organizations,
	people,
	workflows,
	processRevisions,
	processStageKeys,
	programs,
	stageEntries,
	stages,
	statRows,
	statSnapshots,
	users
} from '$lib/server/db/schema';
import { getRedis } from '$lib/server/redis';
import { setSetting } from '$lib/server/settings';
import { B2B_WORKSPACE_KEY } from '$lib/server/stages/definitions';
import {
	createDraft,
	processDefinition,
	publishProcess,
	readWorkspaceByKey,
	requireActiveRevisionForWorkspace,
	updateDraft
} from '$lib/server/stages/process';
import { CONTRACT_SEED_SIZES } from '../../../scripts/seed/contracts';
import { DIRECTORY_SEED_SIZES } from '../../../scripts/seed/directory';
import { INTERACTION_SEED_SIZES } from '../../../scripts/seed/interactions';
import { seedAll } from '../../../scripts/seed/run';
import { STATS_SEED_SIZES } from '../../../scripts/seed/stats';
import { startTestDatabase, testActor, TEST_USER_IDS, type TestDatabase } from '../helpers/db';
import { pageEvent, sessionUser } from '../helpers/event';

// См. комментарий в `helpers/db.ts`: без этого сервисы пойдут в базу разработчика.
vi.mock('$env/dynamic/private', () => ({ env: process.env }));

/**
 * `DEMO_MODE` разбирается один раз за процесс, поэтому переменная окружения тут
 * уже не поможет — подменяется сама функция (тот же приём, что в
 * `admin/admin.test.ts` и `auth/auth.test.ts`).
 */
const demo = vi.hoisted(() => ({ mode: true }));

vi.mock('$lib/server/config', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/server/config')>();

	return { ...actual, getConfig: () => ({ ...actual.getConfig(), DEMO_MODE: demo.mode }) };
});

const { resetDemoData } = await import('$lib/server/demo/reset');
const { runDemoResetCycle, serverDay } = await import('$lib/server/demo/schedule');

/** Загрузчик и действие маршрута типизированы своим маршрутом; подделка — общим. */
type PageLoad = (event: RequestEvent) => Promise<unknown>;
type FormAction = (event: RequestEvent) => Promise<unknown>;

const generalPage = await import('../../../src/routes/(app)/settings/general/+page.server');

const loadGeneral = generalPage.load as unknown as PageLoad;
const resetAction = generalPage.actions.demoReset as unknown as FormAction;

function generalEvent(user = sessionUser('admin')): RequestEvent {
	return pageEvent({ path: '/settings/general', method: 'POST', user });
}

let database: TestDatabase;

async function countRows(table: PgTable): Promise<number> {
	const [row] = await database.db.select({ value: count() }).from(table);

	return row.value;
}

/** Эталон стенда: числа, которые обязаны получиться после сброса. */
const REFERENCE = {
	organizations: DIRECTORY_SEED_SIZES.organizations,
	people: DIRECTORY_SEED_SIZES.people,
	programs: DIRECTORY_SEED_SIZES.programs,
	interactions: INTERACTION_SEED_SIZES.interactions,
	contracts: CONTRACT_SEED_SIZES.contracts,
	statSnapshots: STATS_SEED_SIZES.snapshots,
	statRows: STATS_SEED_SIZES.rows
} as const;

async function snapshotCounts(): Promise<Record<keyof typeof REFERENCE, number>> {
	return {
		organizations: await countRows(organizations),
		people: await countRows(people),
		programs: await countRows(programs),
		interactions: await countRows(interactions),
		contracts: await countRows(contracts),
		statSnapshots: await countRows(statSnapshots),
		statRows: await countRows(statRows)
	};
}

beforeAll(async () => {
	database = await startTestDatabase();
}, 300_000);

afterAll(async () => {
	await getRedis().quit();
	await database?.stop();
});

beforeEach(async () => {
	demo.mode = true;
	await database.reset();
	await seedAll();
});

describe('сброс демонстрационных данных', () => {
	it('возвращает стенд к эталонным числам сида', async () => {
		const reference = await snapshotCounts();

		expect(reference).toStrictEqual(REFERENCE);

		// Портим стенд ровно так, как это делает показ: заводим лишнее, стираем
		// нужное, правим справочник.
		await database.db
			.insert(organizations)
			.values({
				kind: 'customer_company',
				legalName: 'Общество с ограниченной ответственностью «Лишняя»',
				shortName: 'Лишняя'
			})
			.returning({ id: organizations.id });
		await database.db.delete(comments);
		await database.db
			.update(organizations)
			.set({ shortName: 'Переименовано на показе' })
			.where(eq(organizations.kind, 'educational_institution'));

		await expect(countRows(organizations)).resolves.toBe(REFERENCE.organizations + 1);

		const result = await resetDemoData(testActor());

		await expect(snapshotCounts()).resolves.toStrictEqual(REFERENCE);
		expect(result.interactionCount).toBe(REFERENCE.interactions);
		expect(result.organizationCount).toBe(REFERENCE.organizations);

		// Переименование ушло вместе со строкой: сид не «дописывает» поверх
		// правки, а заливает набор заново.
		const renamed = await database.db
			.select({ value: count() })
			.from(organizations)
			.where(eq(organizations.shortName, 'Переименовано на показе'));

		expect(renamed[0].value).toBe(0);

		// Комментарии вернулись: историю пишет движок стадий, и сброс запускает
		// его так же, как первая заливка.
		await expect(countRows(comments)).resolves.toBe(INTERACTION_SEED_SIZES.comments);
		await expect(countRows(stageEntries)).resolves.toBeGreaterThan(0);
	});

	it('не трогает учётные записи, права и открытые сессии', async () => {
		const before = await database.db
			.select({ id: users.id, email: users.email, roleId: users.roleId })
			.from(users)
			.orderBy(users.email);

		// Открытая сессия живёт в Redis: сброс не имеет права выкинуть из
		// системы тех, кто сейчас работает на стенде.
		const redis = getRedis();
		await redis.set('lct:session:проверка-сброса', 'открыта');

		await resetDemoData(testActor());

		const after = await database.db
			.select({ id: users.id, email: users.email, roleId: users.roleId })
			.from(users)
			.orderBy(users.email);

		expect(after).toStrictEqual(before);
		await expect(redis.get('lct:session:проверка-сброса')).resolves.toBe('открыта');
	});

	it('сохраняет процессы, но пересобирает их редакции и убирает черновик', async () => {
		const [workflow] = await database.db
			.select({ id: workflows.id, activeRevisionId: workflows.activeRevisionId })
			.from(workflows)
			.where(eq(workflows.key, 'b2b'))
			.limit(1);

		const [draft] = await database.db
			.insert(processRevisions)
			.values({ workflowId: workflow.id, version: 99, name: 'Черновик показа' })
			.returning({ id: processRevisions.id });

		await resetDemoData(testActor());

		const [workflowAfter] = await database.db
			.select({ id: workflows.id, activeRevisionId: workflows.activeRevisionId })
			.from(workflows)
			.where(eq(workflows.key, 'b2b'))
			.limit(1);

		// Процесс кладёт миграция, и на него смотрит пространство: он тот же.
		// Редакция — эталонная и заведена заново, потому что эталонный набор
		// взаимодействий сид проводит по её стадиям.
		expect(workflowAfter.id).toBe(workflow.id);
		expect(workflowAfter.activeRevisionId).not.toBeNull();
		expect(workflowAfter.activeRevisionId).not.toBe(workflow.activeRevisionId);

		const leftovers = await database.db
			.select({ value: count() })
			.from(processRevisions)
			.where(eq(processRevisions.id, draft.id));

		expect(leftovers[0].value).toBe(0);

		// Опубликованная редакция ровно одна на процесс: прежние не остаются.
		const revisions = await database.db
			.select({ value: count() })
			.from(processRevisions)
			.where(eq(processRevisions.workflowId, workflow.id));

		expect(revisions[0].value).toBe(1);
	});

	it('возвращает стенд к эталону после применённого изменения процесса', async () => {
		const ctx = testActor();
		const workspace = await readWorkspaceByKey(database.db, B2B_WORKSPACE_KEY);
		const active = await requireActiveRevisionForWorkspace(database.db, workspace.id);

		// Стадия, на которой эталонный набор кого-нибудь оставляет: именно её
		// ключ сид спрашивает у живой редакции, когда ведёт набор заново.
		const standing = await database.db
			.select({ key: stages.key })
			.from(stageEntries)
			.innerJoin(stages, eq(stages.id, stageEntries.stageId))
			.where(isNull(stageEntries.leftAt))
			.groupBy(stages.key);

		const occupied = new Set(standing.map((row) => row.key));
		const removable = active.stages.find(
			(stage) => !stage.isFinal && stage.position > 1 && occupied.has(stage.key)
		);

		expect(removable).toBeDefined();

		const removedKey = removable?.key;
		const draft = await createDraft(ctx, B2B_WORKSPACE_KEY);
		const definition = processDefinition(draft);

		// Переходы через удаляемую стадию сшиваются напрямую: иначе процесс
		// распадётся и черновик не пройдёт проверку.
		const kept = definition.transitions.filter(
			(transition) => transition.fromStageKey !== removedKey && transition.toStageKey !== removedKey
		);
		const bridges = definition.transitions
			.filter((transition) => transition.kind === 'forward' && transition.toStageKey === removedKey)
			.flatMap((into) =>
				definition.transitions
					.filter((out) => out.kind === 'forward' && out.fromStageKey === removedKey)
					.map((out) => ({
						fromStageKey: into.fromStageKey,
						toStageKey: out.toStageKey,
						kind: 'forward' as const,
						requiredPermissionKey: out.requiredPermissionKey,
						requiresReason: out.requiresReason
					}))
			)
			.filter(
				(bridge) =>
					!kept.some(
						(transition) =>
							transition.fromStageKey === bridge.fromStageKey &&
							transition.toStageKey === bridge.toStageKey &&
							transition.kind === bridge.kind
					)
			);

		const survivors = definition.stages.filter((stage) => stage.key !== removedKey);
		const target = survivors
			.slice(
				0,
				definition.stages.findIndex((stage) => stage.key === removedKey)
			)
			.at(-1);

		await updateDraft(ctx, B2B_WORKSPACE_KEY, {
			...definition,
			migrationRules: [{ removedStageKey: removedKey ?? '', targetStageKey: target?.key ?? '' }],
			stages: survivors,
			transitions: [...kept, ...bridges]
		});

		await publishProcess(ctx, B2B_WORKSPACE_KEY);

		// До правки сброс на таком стенде падал посреди заливки: эталонный набор
		// взаимодействий сид ведёт по живой редакции и упирался в стадию,
		// которой больше нет.
		await expect(resetDemoData(ctx)).resolves.toMatchObject({
			interactionCount: REFERENCE.interactions,
			organizationCount: REFERENCE.organizations
		});

		await expect(snapshotCounts()).resolves.toStrictEqual(REFERENCE);

		const restored = await requireActiveRevisionForWorkspace(
			database.db,
			(await readWorkspaceByKey(database.db, B2B_WORKSPACE_KEY)).id
		);

		expect(restored.stages.map((stage) => stage.key).sort()).toStrictEqual(
			active.stages.map((stage) => stage.key).sort()
		);

		// Реестр ключей тоже эталонный: ключ снятой стадии больше не архивный, и
		// завести её заново можно.
		const archived = await database.db
			.select({ key: processStageKeys.key })
			.from(processStageKeys)
			.where(sql`${processStageKeys.archivedAt} is not null`);

		expect(archived).toStrictEqual([]);

		// Повтор кнопки на уже сброшенном стенде делает ровно то же самое.
		await expect(resetDemoData(ctx)).resolves.toMatchObject({
			interactionCount: REFERENCE.interactions
		});
		await expect(snapshotCounts()).resolves.toStrictEqual(REFERENCE);
	}, 300_000);

	it('журнал переживает сброс и получает о нём запись', async () => {
		const before = await database.db
			.select({ id: auditEvents.id })
			.from(auditEvents)
			.orderBy(auditEvents.id);

		expect(before.length).toBeGreaterThan(0);

		await resetDemoData(testActor());

		const after = await database.db
			.select({ id: auditEvents.id })
			.from(auditEvents)
			.orderBy(auditEvents.id);

		// Прежние строки на месте все до одной: журнал append-only, и сброс не
		// исключение.
		expect(after.map((row) => row.id)).toEqual(expect.arrayContaining(before.map((row) => row.id)));

		const recorded = await database.db
			.select({ details: auditEvents.details })
			.from(auditEvents)
			.where(eq(auditEvents.eventType, 'settings.demo_reset'));

		expect(recorded).toHaveLength(1);
		expect(recorded[0].details).toStrictEqual({
			interactionCount: REFERENCE.interactions,
			organizationCount: REFERENCE.organizations,
			documentCount:
				INTERACTION_SEED_SIZES.documents * 2 +
				INTERACTION_SEED_SIZES.scans +
				INTERACTION_SEED_SIZES.signedAgreements,
			// Чем сброс вызван: кнопкой. У сброса по расписанию здесь `schedule`,
			// и журнал отвечает на «куда делась запись» прямо.
			mode: 'manual'
		});
	});

	it('вне демонстрационного режима отказывает и данных не трогает', async () => {
		demo.mode = false;

		const before = await snapshotCounts();

		await expect(resetDemoData(testActor())).rejects.toThrow(/демонстрационном стенде/);
		await expect(snapshotCounts()).resolves.toStrictEqual(before);
	});

	it('без права «Изменение настроек приложения» отказывает и пишет отказ в журнал', async () => {
		const before = await snapshotCounts();
		const actor = testActor({ roleId: 'manager', userId: TEST_USER_IDS.manager, permissions: [] });

		await expect(resetDemoData(actor)).rejects.toThrow(/settings.write/);
		await expect(snapshotCounts()).resolves.toStrictEqual(before);

		const denied = await database.db
			.select({ value: count() })
			.from(auditEvents)
			.where(
				sql`${auditEvents.eventType} = 'settings.demo_reset' and ${auditEvents.outcome} = 'denied'`
			);

		expect(denied[0].value).toBe(1);
	});

	it('второй сброс внахлёст получает отказ, а не стирает базу посреди заливки', async () => {
		const [first, second] = await Promise.allSettled([
			resetDemoData(testActor()),
			resetDemoData(testActor())
		]);

		// Который из двух успел первым — дело гонки; важно, что прошёл ровно один.
		const outcomes = [first.status, second.status].sort();

		expect(outcomes).toStrictEqual(['fulfilled', 'rejected']);
		await expect(snapshotCounts()).resolves.toStrictEqual(REFERENCE);
	});

	it('карточка настроек знает, доступен ли сброс, и отдаёт его итог словами', async () => {
		const enabled = (await loadGeneral(generalEvent())) as { demoMode: boolean };

		expect(enabled.demoMode).toBe(true);

		const done = (await resetAction(generalEvent())) as { demoReset?: string };

		expect(done.demoReset).toMatch(
			new RegExp(
				`взаимодействий — ${REFERENCE.interactions}, организаций — ${REFERENCE.organizations}`
			)
		);

		demo.mode = false;

		const disabled = (await loadGeneral(generalEvent())) as { demoMode: boolean };

		expect(disabled.demoMode).toBe(false);

		// Отказ доезжает до формы текстом, а не пятисотой: страница открыта, и
		// человеку надо сказать, почему кнопка не сработала.
		const refused = (await resetAction(generalEvent())) as {
			status: number;
			data: { message: string };
		};

		expect(refused.status).toBe(409);
		expect(refused.data.message).toMatch(/демонстрационном стенде/);
	});

	it('убирает файлы стёртых документов из хранилища', async () => {
		const before = await database.db.select({ filePath: documents.filePath }).from(documents);

		// Документы стенда собираются конвертацией через Gotenberg: на машине без
		// него сид их не заводит, и убирать тогда нечего.
		expect(before.length).toBeGreaterThan(0);

		const keysBefore = await database.storage.keys('files/');

		expect(keysBefore).toEqual(expect.arrayContaining(before.map((row) => row.filePath)));

		await resetDemoData(testActor());

		const keysAfter = await database.storage.keys('files/');
		const survived = before.map((row) => row.filePath).filter((key) => keysAfter.includes(key));

		// Ни одного прежнего объекта: записей, которые на них ссылались, больше
		// нет, и найти их было бы уже нечем. Новые лежат под новыми ключами — их
		// сид записал заново.
		expect(survived).toStrictEqual([]);

		const after = await database.db.select({ filePath: documents.filePath }).from(documents);

		expect(after).toHaveLength(before.length);
		expect(keysAfter).toEqual(expect.arrayContaining(after.map((row) => row.filePath)));
	});
});

/** Ключ отметки «за какие сутки сброс уже выполнен» — часть наблюдаемого поведения. */
const LAST_DAY_KEY = 'lct:demo:reset:day';

/** Расписание, которое наступило: час ноль — значит, любой момент суток подходит. */
const SCHEDULE_NOW = { enabled: true, hour: 0 };

/** Лишняя строка справочника — то же, что оставляет за собой показ. */
async function addLeftover(): Promise<void> {
	await database.db.insert(organizations).values({
		kind: 'customer_company',
		legalName: 'Общество с ограниченной ответственностью «Осталось от показа»',
		shortName: 'Остаток показа'
	});
}

describe('сброс демонстрационных данных по расписанию', () => {
	it('в назначенный час проходит, помечает сутки и в те же сутки не повторяется', async () => {
		await setSetting(testActor(), 'demo_reset_schedule', SCHEDULE_NOW);
		await addLeftover();

		await expect(countRows(organizations)).resolves.toBe(REFERENCE.organizations + 1);
		await expect(runDemoResetCycle()).resolves.toBe(true);
		await expect(snapshotCounts()).resolves.toStrictEqual(REFERENCE);

		// Отметка стоит за сегодняшние сутки: по ней проход и понимает, что за
		// эти сутки стенд уже сбрасывали.
		await expect(getRedis().get(LAST_DAY_KEY)).resolves.toBe(serverDay(new Date()));

		await addLeftover();

		// Второй проход тех же суток не делает ничего: показ, идущий днём, не
		// должен обрываться сбросом на каждом тике таймера.
		await expect(runDemoResetCycle()).resolves.toBe(false);
		await expect(countRows(organizations)).resolves.toBe(REFERENCE.organizations + 1);
	});

	it('выключенное расписание не трогает стенд и не ставит отметку', async () => {
		await addLeftover();

		await expect(runDemoResetCycle()).resolves.toBe(false);
		await expect(countRows(organizations)).resolves.toBe(REFERENCE.organizations + 1);
		await expect(getRedis().get(LAST_DAY_KEY)).resolves.toBeNull();
	});

	it('вне демонстрационного режима расписание не работает вовсе', async () => {
		await setSetting(testActor(), 'demo_reset_schedule', SCHEDULE_NOW);
		demo.mode = false;

		await addLeftover();

		await expect(runDemoResetCycle()).resolves.toBe(false);
		await expect(countRows(organizations)).resolves.toBe(REFERENCE.organizations + 1);
	});

	it('пишет в журнал системного актора и способ «по расписанию»', async () => {
		await setSetting(testActor(), 'demo_reset_schedule', SCHEDULE_NOW);

		await expect(runDemoResetCycle()).resolves.toBe(true);

		const recorded = await database.db
			.select({
				source: auditEvents.source,
				actorUserId: auditEvents.actorUserId,
				actorLabel: auditEvents.actorLabel,
				details: auditEvents.details
			})
			.from(auditEvents)
			.where(eq(auditEvents.eventType, 'settings.demo_reset'));

		expect(recorded).toHaveLength(1);
		expect(recorded[0].source).toBe('system');
		// Автора у фонового прохода нет: право он проходит по источнику, а не от
		// чьего-то имени, и приписывать сброс человеку было бы неправдой.
		expect(recorded[0].actorUserId).toBeNull();
		expect(recorded[0].actorLabel).toBe('Система');
		expect(recorded[0].details).toMatchObject({
			mode: 'schedule',
			interactionCount: REFERENCE.interactions
		});
	});
});
