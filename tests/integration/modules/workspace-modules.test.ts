/**
 * Модули пространства на настоящей базе: что включила миграция, что требуют
 * стадии, кто может переключать и что говорит проверка для действий модулей.
 *
 * Действующие модули — это включённые ∪ нужные стадиям, поэтому отдельно
 * проверено, что модуль, нужный стадии, действует и без строки в таблице:
 * пространство, заведённое прямым SQL, иначе осталось бы без обучения.
 */
import { and, eq, like } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { checklistRule } from '$lib/platform/checklist-rules';
import { auditEvents, workspaceModules, workspaces } from '$lib/server/db/schema';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '$lib/server/errors';
import {
	assertModuleActive,
	listWorkspaceModules,
	readActiveModules,
	setWorkspaceModule
} from '$lib/server/platform/workspace-modules';
import { uploadDocument } from '$lib/server/documents/upload';
import { B2C_PROCESS } from '$lib/server/stages/definitions';
import { startTestDatabase, testActor, type TestDatabase } from '../helpers/db';
import {
	B2B_PROCESS,
	B2B_WORKSPACE_KEY,
	B2C_WORKSPACE_KEY,
	createInteractionOn,
	seedProcess
} from '../stages/fixture';

// См. комментарий в `helpers/db.ts`: без этого сервисы пойдут в базу разработчика.
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

async function workspaceId(key: string): Promise<string> {
	const [row] = await database.db
		.select({ id: workspaces.id })
		.from(workspaces)
		.where(eq(workspaces.key, key));

	return row.id;
}

async function enabledKeys(key: string): Promise<string[]> {
	const rows = await database.db
		.select({ moduleKey: workspaceModules.moduleKey })
		.from(workspaceModules)
		.where(eq(workspaceModules.workspaceId, await workspaceId(key)));

	return rows.map((row) => row.moduleKey).sort();
}

async function removeRow(key: string, moduleKey: string): Promise<void> {
	await database.db
		.delete(workspaceModules)
		.where(
			and(
				eq(workspaceModules.workspaceId, await workspaceId(key)),
				eq(workspaceModules.moduleKey, moduleKey)
			)
		);
}

async function moduleEvents() {
	return database.db
		.select({
			eventType: auditEvents.eventType,
			outcome: auditEvents.outcome,
			details: auditEvents.details
		})
		.from(auditEvents)
		.where(like(auditEvents.eventType, 'workspaces.module_%'))
		.orderBy(auditEvents.occurredAt);
}

describe('модули пространства', () => {
	it('миграция включает эталонным пространствам те модули, которыми они пользовались', async () => {
		expect(await enabledKeys(B2B_WORKSPACE_KEY)).toEqual(['contracts', 'learning', 'meetings']);
		expect(await enabledKeys(B2C_WORKSPACE_KEY)).toEqual([
			'contracts',
			'learning',
			'meetings',
			'payment'
		]);
	});

	it('модуль, нужный стадии, выключить нельзя, и он действует без строки в таблице', async () => {
		const ctx = testActor({ roleId: 'admin' });
		await seedProcess(database, B2B_WORKSPACE_KEY, B2B_PROCESS);

		const refusal = setWorkspaceModule(ctx, {
			workspaceKey: B2B_WORKSPACE_KEY,
			moduleKey: 'learning',
			enabled: false
		});
		await expect(refusal).rejects.toThrow(ConflictError);
		await expect(refusal).rejects.toThrow('«Ведение занятий»');

		// Обучению преподавателей и повышению квалификации модуль нужен ради
		// пунктов, которые закрывает поток нужного назначения.
		const requiredBy = ['Обучение преподавателей', 'Ведение занятий', 'Повышение квалификации'];

		// Строку убрали в обход настроек — модуль всё равно действует по стадии.
		await removeRow(B2B_WORKSPACE_KEY, 'learning');
		const state = await readActiveModules(await workspaceId(B2B_WORKSPACE_KEY));

		expect(state.enabled.has('learning')).toBe(false);
		expect(state.required.get('learning')).toEqual(requiredBy);
		expect(state.active).toEqual(['contracts', 'learning', 'meetings']);

		const views = await listWorkspaceModules(ctx);
		const learning = views
			.find((view) => view.workspaceKey === B2B_WORKSPACE_KEY)
			?.modules.find((module) => module.key === 'learning');

		expect(learning).toMatchObject({
			enabled: false,
			active: true,
			requiredBy
		});
	});

	it('включение и выключение пишут события, повтор ничего не меняет, менеджеру отказ', async () => {
		const admin = testActor({ roleId: 'admin' });
		const input = { workspaceKey: B2C_WORKSPACE_KEY, moduleKey: 'meetings' };

		expect(await setWorkspaceModule(admin, { ...input, enabled: false })).toEqual({
			changed: true
		});
		expect(await setWorkspaceModule(admin, { ...input, enabled: false })).toEqual({
			changed: false
		});
		expect(await enabledKeys(B2C_WORKSPACE_KEY)).not.toContain('meetings');
		expect(await setWorkspaceModule(admin, { ...input, enabled: true })).toEqual({
			changed: true
		});

		await expect(
			setWorkspaceModule(testActor({ roleId: 'manager' }), { ...input, enabled: false })
		).rejects.toThrow(ForbiddenError);
		await expect(
			setWorkspaceModule(admin, { ...input, moduleKey: 'licenses', enabled: true })
		).rejects.toThrow(ValidationError);

		expect(await moduleEvents()).toEqual([
			{
				eventType: 'workspaces.module_disabled',
				outcome: 'success',
				details: { workspaceKey: B2C_WORKSPACE_KEY, moduleKey: 'meetings' }
			},
			{
				eventType: 'workspaces.module_enabled',
				outcome: 'success',
				details: { workspaceKey: B2C_WORKSPACE_KEY, moduleKey: 'meetings' }
			},
			{ eventType: 'workspaces.module_disabled', outcome: 'denied', details: {} }
		]);
	});

	it('проверка для действий модуля: отказ без модуля, пропуск по стадии, чужое дело — не найдено', async () => {
		const admin = testActor({ roleId: 'admin' });
		await seedProcess(database, B2B_WORKSPACE_KEY, B2B_PROCESS);
		await seedProcess(database, B2C_WORKSPACE_KEY, B2C_PROCESS);
		const { interactionId } = await createInteractionOn(admin, database, {
			kind: 'legal_entity'
		});

		await assertModuleActive(admin, interactionId, 'contracts');

		await removeRow(B2C_WORKSPACE_KEY, 'contracts');
		const refusal = assertModuleActive(admin, interactionId, 'contracts');
		await expect(refusal).rejects.toThrow(ValidationError);
		await expect(refusal).rejects.toThrow(
			'Модуль «Договоры и лицензии» не подключён к пространству «Коммерческое обучение»'
		);

		// Обучение нужно стадии «Зачисление и обучение» — строка ему не нужна.
		await removeRow(B2C_WORKSPACE_KEY, 'learning');
		await assertModuleActive(admin, interactionId, 'learning');

		const outsider = testActor({
			roleId: 'manager',
			scopeUserIds: [crypto.randomUUID()],
			workspaceIds: []
		});
		await expect(assertModuleActive(outsider, interactionId, 'learning')).rejects.toThrow(
			NotFoundError
		);
	});

	it('«Оплату» не выключить, пока стадия ждёт отметки «Оплата получена»; документ выключенного модуля не загрузить', async () => {
		const admin = testActor({ roleId: 'admin' });
		// Коммерческий процесс без стадий с данными обучения и без пунктов,
		// которые закрывают данные «Обучения»: модуль здесь действует только
		// включённым, и его можно выключить.
		await seedProcess(database, B2C_WORKSPACE_KEY, {
			...B2C_PROCESS,
			stages: B2C_PROCESS.stages.map((stage) => ({
				...stage,
				requiresLmsData: false,
				lmsGroupPurposes: null,
				checklist: stage.checklist.map((item) =>
					item.completion?.kind === 'fact' &&
					checklistRule(item.completion.rule)?.module === 'learning'
						? { ...item, completion: { kind: 'manual' as const } }
						: item
				)
			}))
		});

		const payment = setWorkspaceModule(admin, {
			workspaceKey: B2C_WORKSPACE_KEY,
			moduleKey: 'payment',
			enabled: false
		});
		await expect(payment).rejects.toThrow(ConflictError);
		await expect(payment).rejects.toThrow('«Договор и оплата»');

		const { interactionId } = await createInteractionOn(admin, database, {
			kind: 'legal_entity'
		});
		expect(
			await setWorkspaceModule(admin, {
				workspaceKey: B2C_WORKSPACE_KEY,
				moduleKey: 'learning',
				enabled: false
			})
		).toEqual({ changed: true });

		const certificate = {
			interactionId,
			kind: 'certificate',
			title: 'Удостоверение о повышении квалификации',
			file: { mime: 'text/plain', bytes: new TextEncoder().encode('Удостоверение\n') }
		};
		const refusal = uploadDocument(admin, certificate);
		await expect(refusal).rejects.toThrow(ValidationError);
		await expect(refusal).rejects.toThrow(
			'Вид документа «Документ об обучении» даёт модуль «Обучение», он не подключён к пространству «Коммерческое обучение»'
		);

		await setWorkspaceModule(admin, {
			workspaceKey: B2C_WORKSPACE_KEY,
			moduleKey: 'learning',
			enabled: true
		});
		expect(await uploadDocument(admin, certificate)).toMatchObject({ kind: 'certificate' });
	});
});
