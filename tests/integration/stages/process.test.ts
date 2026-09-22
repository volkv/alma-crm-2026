/**
 * Раздел «Процесс» на настоящей базе: список групп, черновик изменений и его
 * правка.
 *
 * Правила пригодности структуры проверяются модулем без базы
 * (`tests/unit/stages/process.test.ts`); здесь — то, чего на структурах в
 * памяти не воспроизвести: один черновик на группу держит частичный уникальный
 * индекс, правка идёт под блокировкой строки группы, а отказ по правам обязан
 * оставить след в журнале.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { auditEvents, processRevisions, processStageKeys, stages } from '$lib/server/db/schema';
import { ConflictError, ForbiddenError, NotFoundError } from '$lib/server/errors';
import {
	createDraft,
	discardDraft,
	getWorkspace,
	listWorkspaces,
	previewPublication,
	processDefinition,
	readWorkflowByKey,
	syncStageKeys,
	updateDraft
} from '$lib/server/stages/process';
import type { ActorContext } from '$lib/server/actor';
import { startTestDatabase, testActor, TEST_USER_IDS, type TestDatabase } from '../helpers/db';
import {
	B2B_WORKSPACE_KEY,
	B2B_PROCESS,
	B2C_WORKSPACE_KEY,
	createInteractionOn,
	seedProcess,
	twoStageProcess
} from './fixture';

vi.mock('$env/dynamic/private', () => ({ env: process.env }));

let database: TestDatabase;

beforeAll(async () => {
	database = await startTestDatabase();
}, 300_000);

afterAll(async () => {
	await database?.stop();
});

beforeEach(async () => {
	await database.reset();
});

const admin = (): ActorContext => testActor({ roleId: 'admin' });

describe('список групп процесса', () => {
	it('отдаёт обе группы со счётчиками стадий и незавершённых взаимодействий', async () => {
		const ctx = admin();
		await seedProcess(database, B2B_WORKSPACE_KEY, B2B_PROCESS);
		await createInteractionOn(ctx, database, { title: 'Работа с вузом' });

		const workspaces = await listWorkspaces(ctx);
		const b2b = workspaces.find((workspace) => workspace.key === B2B_WORKSPACE_KEY);
		const b2c = workspaces.find((workspace) => workspace.key === B2C_WORKSPACE_KEY);

		expect(workspaces).toHaveLength(2);
		expect(b2b?.stageCount).toBe(B2B_PROCESS.stages.length);
		expect(b2b?.activeInteractions).toBe(1);
		expect(b2b?.hasDraft).toBe(false);
		// Группа без описанного процесса остаётся в списке: «здесь ещё ничего не
		// описано» — это ответ, а исчезнувшая строка выглядит как исчезнувший
		// сценарий работы.
		expect(b2c?.stageCount).toBe(0);
	});

	it('закрыт для роли без права на настройку и оставляет след отказа', async () => {
		const manager = testActor({ roleId: 'manager' });

		await expect(listWorkspaces(manager)).rejects.toBeInstanceOf(ForbiddenError);

		const denied = await database.db
			.select({ type: auditEvents.eventType, actorUserId: auditEvents.actorUserId })
			.from(auditEvents)
			.where(eq(auditEvents.outcome, 'denied'));

		expect(denied).toEqual([{ type: 'stages.process_viewed', actorUserId: TEST_USER_IDS.manager }]);
	});
});

describe('реестр ключей стадий', () => {
	it('заводит все ключи редакции и архивирует те, которых в ней не стало', async () => {
		const revision = await seedProcess(database, B2B_WORKSPACE_KEY, B2B_PROCESS);
		const workflow = await readWorkflowByKey(database.db, B2B_WORKSPACE_KEY);

		// Реестр ведётся списком ключей целиком, а не по одному: запрос со
		// списком параметров легко написать так, что PostgreSQL примет его за
		// кортеж, — и тогда не работает вообще ничего, что заводит процесс.
		const keys = await database.db
			.select({ key: processStageKeys.key, archivedAt: processStageKeys.archivedAt })
			.from(processStageKeys)
			.where(eq(processStageKeys.workflowId, workflow.id));

		expect(keys.map((row) => row.key).sort()).toEqual(
			revision.stages.map((stage) => stage.key).sort()
		);
		expect(keys.every((row) => row.archivedAt === null)).toBe(true);

		// Редакция из трёх ключей: остальные одиннадцать становятся архивными.
		const shortened = {
			...revision,
			stages: revision.stages.slice(0, 3)
		};

		const archived = await database.db.transaction((tx) =>
			syncStageKeys(tx, workflow.id, shortened, new Date())
		);

		expect(archived).toBe(revision.stages.length - 3);

		const after = await database.db
			.select({ key: processStageKeys.key, archivedAt: processStageKeys.archivedAt })
			.from(processStageKeys)
			.where(eq(processStageKeys.workflowId, workflow.id));

		// Строки не удаляются никогда: ключ, который когда-либо был в процессе,
		// остаётся занятым.
		expect(after).toHaveLength(revision.stages.length);
		expect(
			after
				.filter((row) => row.archivedAt === null)
				.map((row) => row.key)
				.sort()
		).toEqual(shortened.stages.map((stage) => stage.key).sort());

		// Ключ вернулся в процесс — отметка снимается: иначе редактор откажет в
		// стадии, которая уже стоит.
		await database.db.transaction((tx) => syncStageKeys(tx, workflow.id, revision, new Date()));

		const restored = await database.db
			.select({ key: processStageKeys.key })
			.from(processStageKeys)
			.where(
				and(eq(processStageKeys.workflowId, workflow.id), isNull(processStageKeys.archivedAt))
			);

		expect(restored).toHaveLength(revision.stages.length);
	});
});

describe('черновик изменений', () => {
	it('создаётся копией действующего процесса', async () => {
		const ctx = admin();
		const active = await seedProcess(database, B2B_WORKSPACE_KEY, B2B_PROCESS);

		const draft = await createDraft(ctx, B2B_WORKSPACE_KEY);

		expect(draft.publishedAt).toBeNull();
		expect(draft.version).toBe(active.version + 1);
		expect(draft.stages.map((stage) => stage.key)).toEqual(active.stages.map((stage) => stage.key));
		expect(draft.transitions).toHaveLength(active.transitions.length);

		// Действующая редакция копией не тронута: по ней идут взаимодействия.
		const detail = await getWorkspace(ctx, B2B_WORKSPACE_KEY);
		expect(detail.active?.id).toBe(active.id);
		expect(detail.workspace.hasDraft).toBe(true);
	});

	it('не заводит второй черновик той же группы', async () => {
		const ctx = admin();
		await seedProcess(database, B2B_WORKSPACE_KEY, B2B_PROCESS);
		await createDraft(ctx, B2B_WORKSPACE_KEY);

		await expect(createDraft(ctx, B2B_WORKSPACE_KEY)).rejects.toBeInstanceOf(ConflictError);

		// Редакций две — действующая и черновик; третьей строки не появилось.
		const revisions = await database.db
			.select({ id: processRevisions.id, publishedAt: processRevisions.publishedAt })
			.from(processRevisions);

		expect(revisions).toHaveLength(2);
		expect(revisions.filter((revision) => revision.publishedAt === null)).toHaveLength(1);
	});

	it('не заводится у группы без действующего процесса', async () => {
		// Черновик — копия действующей структуры; копировать нечего, и говорить об
		// этом надо словами, а не пустым редактором.
		await expect(createDraft(admin(), B2C_WORKSPACE_KEY)).rejects.toBeInstanceOf(ConflictError);
	});

	it('переписывает стадии целиком и проставляет правило переноса по умолчанию', async () => {
		const ctx = admin();
		const active = await seedProcess(database, B2B_WORKSPACE_KEY, B2B_PROCESS);
		const draft = await createDraft(ctx, B2B_WORKSPACE_KEY);

		const definition = processDefinition(draft);
		const without = definition.stages.filter((stage) => stage.key !== 'document_revision');

		const saved = await updateDraft(ctx, B2B_WORKSPACE_KEY, {
			...definition,
			stages: without,
			transitions: definition.transitions.filter(
				(transition) =>
					transition.fromStageKey !== 'document_revision' &&
					transition.toStageKey !== 'document_revision'
			)
		});

		expect(saved.stages.map((stage) => stage.key)).not.toContain('document_revision');
		// Цель по умолчанию — предыдущая сохранившаяся стадия: работа возвращается
		// на шаг назад, а не проскакивает вперёд мимо того, чего не сделали.
		expect(saved.migrationRules).toEqual([
			{ removedStageKey: 'document_revision', targetStageKey: 'document_exchange' }
		]);
		// Позиции пересобраны подряд: дыра в нумерации сделала бы «шаг вперёд»
		// вопросом порядка строк.
		expect(saved.stages.map((stage) => stage.position)).toEqual(
			saved.stages.map((_stage, index) => index + 1)
		);

		// Действующая редакция не изменилась ни на стадию.
		const stillActive = await database.db
			.select({ key: stages.key })
			.from(stages)
			.where(eq(stages.revisionId, active.id));

		expect(stillActive.map((stage) => stage.key)).toContain('document_revision');
	});

	it('отменяется вместе со своими стадиями и переходами', async () => {
		const ctx = admin();
		const active = await seedProcess(database, B2B_WORKSPACE_KEY, B2B_PROCESS);
		const draft = await createDraft(ctx, B2B_WORKSPACE_KEY);

		await discardDraft(ctx, B2B_WORKSPACE_KEY);

		const revisions = await database.db.select({ id: processRevisions.id }).from(processRevisions);
		const orphans = await database.db
			.select({ id: stages.id })
			.from(stages)
			.where(eq(stages.revisionId, draft.id));

		expect(revisions.map((revision) => revision.id)).toEqual([active.id]);
		expect(orphans).toEqual([]);
		await expect(discardDraft(ctx, B2B_WORKSPACE_KEY)).rejects.toBeInstanceOf(NotFoundError);
	});
});

describe('предпросмотр применения', () => {
	it('считает числа по каждой затронутой стадии и итог', async () => {
		const ctx = admin();
		await seedProcess(database, B2C_WORKSPACE_KEY, twoStageProcess({}));

		const one = await createInteractionOn(ctx, database, {
			title: 'Первое обучение',
			kind: 'legal_entity'
		});
		await createInteractionOn(ctx, database, {
			title: 'Второе обучение',
			kind: 'legal_entity'
		});

		const draft = await createDraft(ctx, B2C_WORKSPACE_KEY);
		const definition = processDefinition(draft);

		await updateDraft(ctx, B2C_WORKSPACE_KEY, {
			...definition,
			stages: definition.stages.map((stage) =>
				stage.key === 'first' ? { ...stage, name: 'Первое знакомство' } : stage
			)
		});

		const preview = await previewPublication(ctx, B2C_WORKSPACE_KEY);
		const first = preview.rows.find((row) => row.stageKey === 'first');
		const second = preview.rows.find((row) => row.stageKey === 'second');

		expect(first?.change).toBe('renamed');
		expect(first?.interactions).toBe(2);
		expect(second?.change).toBe('kept');
		// Стадия, на которой никого нет, отмечена нулём — строка про неё остаётся.
		expect(second?.interactions).toBe(0);
		// Переименование никого не двигает, поэтому «затронуто» — ноль.
		expect(preview.affected).toBe(0);
		expect(preview.issues).toEqual([]);
		expect(one.interactionId).toBeTypeOf('string');
	});

	it('называет числом тех, кто переедет с удалённой стадии', async () => {
		const ctx = admin();
		await seedProcess(database, B2C_WORKSPACE_KEY, twoStageProcess({}));
		await createInteractionOn(ctx, database, { kind: 'legal_entity' });

		const draft = await createDraft(ctx, B2C_WORKSPACE_KEY);
		const definition = processDefinition(draft);

		// Удаляем первую стадию: цель по умолчанию у неё — следующая, предыдущей
		// у первой стадии не бывает.
		await updateDraft(ctx, B2C_WORKSPACE_KEY, {
			...definition,
			stages: definition.stages.filter((stage) => stage.key !== 'first'),
			transitions: []
		});

		const preview = await previewPublication(ctx, B2C_WORKSPACE_KEY);
		const removed = preview.rows.find((row) => row.stageKey === 'first');

		expect(removed?.change).toBe('removed');
		expect(removed?.interactions).toBe(1);
		expect(removed?.targetStageKey).toBe('second');
		expect(preview.affected).toBe(1);
	});
});
