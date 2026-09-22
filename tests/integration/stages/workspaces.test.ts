/**
 * Настройка пространств: завести, переименовать, переставить, назначить процесс.
 *
 * Заведение пространства перестало быть миграцией — его делает заказчик, — и
 * именно поэтому правила проверяются на настоящей базе: место в списке
 * уникально, ключ уникален, а смена процесса запрещена там, где в пространстве
 * уже есть работа.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInteractionSchema } from '$lib/contracts/interactions';
import { auditEvents, workspaces } from '$lib/server/db/schema';
import { ConflictError, ForbiddenError, NotFoundError } from '$lib/server/errors';
import { createInteraction } from '$lib/server/interactions/write';
import {
	assignWorkspaceWorkflow,
	createWorkspace,
	ensureWorkflow,
	listWorkflows,
	listWorkspaces,
	renameWorkspace,
	reorderWorkspaces
} from '$lib/server/stages/process';
import { B2B_PROCESS, B2B_WORKSPACE_KEY, B2C_WORKSPACE_KEY } from '$lib/server/stages/definitions';
import type { ActorContext } from '$lib/server/actor';
import {
	insertOrganization,
	startTestDatabase,
	testActor,
	TEST_USER_IDS,
	type TestDatabase
} from '../helpers/db';

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

/** Процесс учебных заведений: его назначают новым пространствам в проверках. */
async function demoProcess(): Promise<void> {
	await database.db.transaction((tx) => ensureWorkflow(tx, B2B_WORKSPACE_KEY, B2B_PROCESS));
}

/** Ключи пространств в том порядке, в каком их показывает меню. */
async function order(): Promise<string[]> {
	return (await listWorkspaces(admin())).map((workspace) => workspace.key);
}

describe('заведение пространства', () => {
	it('встаёт последним в меню и получает процесс, если его назвали', async () => {
		const ctx = admin();
		await demoProcess();

		const created = await createWorkspace(ctx, {
			key: 'region-north',
			name: 'Северное направление',
			description: 'Работа по тому же сценарию, что и с вузами',
			workflowKey: B2B_WORKSPACE_KEY
		});

		expect(created.position).toBe(3);
		expect(created.workflow?.key).toBe(B2B_WORKSPACE_KEY);
		// Один процесс на два места — то, ради чего он и вынесен из пространства:
		// стадии описаны один раз, и правка меняет работу в обоих.
		expect(created.stageCount).toBeGreaterThan(0);
		await expect(order()).resolves.toEqual([B2B_WORKSPACE_KEY, B2C_WORKSPACE_KEY, 'region-north']);
	});

	it('заводится и без процесса: это законное состояние, а не полумера', async () => {
		const created = await createWorkspace(admin(), {
			key: 'empty',
			name: 'Новое направление',
			description: null,
			workflowKey: null
		});

		expect(created.workflow).toBeNull();
		expect(created.stageCount).toBe(0);
	});

	it('не повторяет занятый ключ: ключ стоит в адресе и обязан быть один', async () => {
		await expect(
			createWorkspace(admin(), {
				key: B2B_WORKSPACE_KEY,
				name: 'Ещё одни учебные заведения',
				description: null,
				workflowKey: null
			})
		).rejects.toBeInstanceOf(ConflictError);
	});

	it('не заводит пространство с процессом, которого нет', async () => {
		await expect(
			createWorkspace(admin(), {
				key: 'ghost',
				name: 'Направление без процесса',
				description: null,
				workflowKey: 'no-such-workflow'
			})
		).rejects.toBeInstanceOf(NotFoundError);
	});

	it('закрыто для роли без права на настройку', async () => {
		await expect(
			createWorkspace(testActor({ roleId: 'manager' }), {
				key: 'manager-made',
				name: 'Пространство менеджера',
				description: null,
				workflowKey: null
			})
		).rejects.toBeInstanceOf(ForbiddenError);
	});
});

describe('переименование', () => {
	it('меняет имя и описание, но не ключ: ключ уже разослан ссылками', async () => {
		const ctx = admin();

		await renameWorkspace(ctx, {
			key: B2B_WORKSPACE_KEY,
			name: 'Учебные заведения и колледжи',
			description: 'Работа от имени структурных подразделений'
		});

		const [row] = await database.db
			.select({ key: workspaces.key, name: workspaces.name, description: workspaces.description })
			.from(workspaces)
			.where(eq(workspaces.key, B2B_WORKSPACE_KEY));

		expect(row.name).toBe('Учебные заведения и колледжи');
		expect(row.description).toBe('Работа от имени структурных подразделений');
		expect(row.key).toBe(B2B_WORKSPACE_KEY);
	});
});

describe('порядок пространств', () => {
	it('переставляет их местами, хотя место в списке уникально', async () => {
		const ctx = admin();

		await reorderWorkspaces(ctx, { keys: [B2C_WORKSPACE_KEY, B2B_WORKSPACE_KEY] });

		// Уникальность места — вот почему перестановка идёт двумя проходами: на
		// середине прямого присвоения два пространства встали бы на один номер.
		await expect(order()).resolves.toEqual([B2C_WORKSPACE_KEY, B2B_WORKSPACE_KEY]);
	});

	it('требует список целиком: половина порядка — это не порядок', async () => {
		await expect(reorderWorkspaces(admin(), { keys: [B2C_WORKSPACE_KEY] })).rejects.toThrow(
			/списком всех пространств/
		);

		await expect(order()).resolves.toEqual([B2B_WORKSPACE_KEY, B2C_WORKSPACE_KEY]);
	});

	it('не верит неизвестному ключу', async () => {
		await expect(
			reorderWorkspaces(admin(), { keys: [B2B_WORKSPACE_KEY, 'no-such-workspace'] })
		).rejects.toBeInstanceOf(NotFoundError);
	});
});

describe('назначение процесса', () => {
	it('назначается пустому пространству и снимается с него', async () => {
		const ctx = admin();
		await demoProcess();
		await createWorkspace(ctx, {
			key: 'fresh',
			name: 'Свежее направление',
			description: null,
			workflowKey: null
		});

		await assignWorkspaceWorkflow(ctx, { key: 'fresh', workflowKey: B2B_WORKSPACE_KEY });

		const assigned = (await listWorkspaces(ctx)).find((row) => row.key === 'fresh');
		expect(assigned?.workflow?.key).toBe(B2B_WORKSPACE_KEY);

		await assignWorkspaceWorkflow(ctx, { key: 'fresh', workflowKey: null });

		const cleared = (await listWorkspaces(ctx)).find((row) => row.key === 'fresh');
		expect(cleared?.workflow).toBeNull();
	});

	it('не меняется там, где уже есть работа: переносить записи нечем', async () => {
		const ctx = admin();
		await demoProcess();

		const organizationId = await insertOrganization(database.db, { shortName: 'Вуз' });

		await createInteraction(
			ctx,
			B2B_WORKSPACE_KEY,
			createInteractionSchema.parse({
				title: 'Подготовка специалистов',
				ownerUserId: TEST_USER_IDS.admin,
				parties: [{ organizationId, partyRole: 'educational_institution', isPrimary: true }]
			})
		);

		await expect(
			assignWorkspaceWorkflow(ctx, { key: B2B_WORKSPACE_KEY, workflowKey: null })
		).rejects.toBeInstanceOf(ConflictError);
	});

	it('оставляет след в журнале: «когда и на что поменяли» спрашивают по нему', async () => {
		const ctx = admin();
		await demoProcess();
		await createWorkspace(ctx, {
			key: 'logged',
			name: 'Направление с журналом',
			description: null,
			workflowKey: null
		});

		await assignWorkspaceWorkflow(ctx, { key: 'logged', workflowKey: B2B_WORKSPACE_KEY });

		const events = await database.db
			.select({ type: auditEvents.eventType })
			.from(auditEvents)
			.where(eq(auditEvents.eventType, 'workspaces.workflow_assigned'));

		expect(events).toHaveLength(1);
	});
});

describe('список процессов', () => {
	it('считает стадии действующей редакции и число назначений', async () => {
		const ctx = admin();
		await demoProcess();
		await createWorkspace(ctx, {
			key: 'second',
			name: 'Второе направление',
			description: null,
			workflowKey: B2B_WORKSPACE_KEY
		});

		const b2b = (await listWorkflows(ctx)).find((row) => row.key === B2B_WORKSPACE_KEY);

		expect(b2b?.stageCount).toBeGreaterThan(0);
		// Пространство `b2b` и заведённое «второе»: одно описание работы на два
		// места — ровно то, ради чего процесс вынесен из пространства.
		expect(b2b?.workspaces).toBe(2);
	});
});
