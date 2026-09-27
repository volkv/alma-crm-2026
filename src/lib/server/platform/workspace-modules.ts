/**
 * Модули пространства: какие включены, какие нужны стадиям, какие действуют.
 *
 * Действующие модули — это включённые явно (строки `workspace_modules`)
 * вместе с нужными стадиям действующей редакции (`requiredByStage` в
 * манифесте). Второе множество не хранится: оно выводится из процесса, и
 * публикация стадии, которую подтверждают данными обучения, сразу делает
 * «Обучение» действующим — без отдельного шага в настройках, который забыли бы
 * сделать. Черновик процесса не учитывается: требование появляется с
 * публикацией.
 *
 * Проверка «модуль действует» здесь только объявлена (`assertModuleActive`), а
 * зовёт её слой маршрута — действия и файлы модулей. В сервисы ядра она не
 * встроена: обмен с LMS и сборку документов зовут напрямую сид, фоновые задачи
 * и проверки, и модуль к ним отношения не имеет.
 */
import { and, eq, inArray } from 'drizzle-orm';
import type { SetWorkspaceModuleInput, WorkspaceModulesView } from '$lib/contracts/modules';
import {
	activeModules,
	INSTALLED_MODULES,
	isModuleKey,
	moduleByKey,
	moduleContributions,
	requiredModules,
	type ModuleKey
} from '$lib/platform/registry';
import type { ActorContext } from '../actor';
import { recordAuditEvent } from '../audit';
import { getDb } from '../db';
import { workspaceModules, workspaces } from '../db/schema';
import { withTransaction } from '../db/transaction';
import { ConflictError, ValidationError } from '../errors';
import { assertInteractionVisible } from '../interactions/access';
import { requirePermission } from '../rbac';
import {
	readActiveRevision,
	readActiveRevisionForWorkspace,
	readWorkflowForWorkspace,
	readWorkspaceByKey,
	type Executor
} from '../stages/process';

/** Модули пространства во всех трёх смыслах. */
export type ActiveModules = {
	/** Включённые явно — только те, что есть в установке. */
	enabled: ReadonlySet<ModuleKey>;
	/** Нужные стадиям действующей редакции: модуль → названия стадий. */
	required: ReadonlyMap<ModuleKey, readonly string[]>;
	/** Действующие, в порядке конфига. */
	active: readonly ModuleKey[];
};

/** Ключи установленных модулей среди строк базы: строка могла пережить модуль. */
function installedKeys(keys: readonly string[]): Set<ModuleKey> {
	return new Set(keys.filter(isModuleKey));
}

/**
 * Модули одного пространства.
 *
 * Без исполнителя редакция читается из кэша — так её читают карточка и меню.
 * С исполнителем (транзакцией) — из базы через него же: правка обязана видеть
 * то, что уже записала, а кэш отвечает состоянием на последнюю публикацию.
 */
export async function readActiveModules(
	workspaceId: string,
	executor?: Executor
): Promise<ActiveModules> {
	const db = executor ?? getDb();

	// По очереди, а не разом: с исполнителем оба запроса идут через одну
	// транзакцию.
	const rows = await db
		.select({ moduleKey: workspaceModules.moduleKey })
		.from(workspaceModules)
		.where(eq(workspaceModules.workspaceId, workspaceId));
	const revision =
		executor === undefined
			? await readActiveRevisionForWorkspace(workspaceId)
			: await readWorkflowForWorkspace(executor, workspaceId).then((workflow) =>
					workflow === null ? null : readActiveRevision(executor, workflow)
				);

	const enabled = installedKeys(rows.map((row) => row.moduleKey));
	const required = requiredModules(revision?.stages ?? []);

	return { enabled, required, active: activeModules(enabled, required) };
}

/**
 * Действующие модули нескольких пространств — для меню: одна выборка строк и
 * кэшированная редакция на каждое пространство.
 */
export async function readActiveModulesForWorkspaces(
	workspaceIds: readonly string[]
): Promise<Map<string, ModuleKey[]>> {
	if (workspaceIds.length === 0) {
		return new Map();
	}

	const [rows, revisions] = await Promise.all([
		getDb()
			.select({
				workspaceId: workspaceModules.workspaceId,
				moduleKey: workspaceModules.moduleKey
			})
			.from(workspaceModules)
			.where(inArray(workspaceModules.workspaceId, [...workspaceIds])),
		Promise.all(workspaceIds.map((id) => readActiveRevisionForWorkspace(id)))
	]);

	return new Map(
		workspaceIds.map((id, index) => {
			const enabled = installedKeys(
				rows.filter((row) => row.workspaceId === id).map((row) => row.moduleKey)
			);

			return [id, activeModules(enabled, requiredModules(revisions[index]?.stages ?? []))];
		})
	);
}

/** Модули всех пространств — для настроек пространств. */
export async function listWorkspaceModules(ctx: ActorContext): Promise<WorkspaceModulesView[]> {
	await requirePermission(ctx, 'stages.configure', { type: 'stages.process_viewed' });

	const rows = await getDb()
		.select({ id: workspaces.id, key: workspaces.key, name: workspaces.name })
		.from(workspaces)
		.orderBy(workspaces.position);

	return Promise.all(
		rows.map(async (workspace): Promise<WorkspaceModulesView> => {
			const state = await readActiveModules(workspace.id);

			return {
				workspaceId: workspace.id,
				workspaceKey: workspace.key,
				workspaceName: workspace.name,
				modules: INSTALLED_MODULES.map((module) => ({
					key: module.key,
					label: module.label,
					description: module.description,
					enabled: state.enabled.has(module.key),
					requiredBy: [...(state.required.get(module.key) ?? [])],
					active: state.active.includes(module.key),
					contributions: moduleContributions(module.key)
				}))
			};
		})
	);
}

/** Названия стадий словами: «Ведение занятий» или «А», «Б». */
function stageList(names: readonly string[]): string {
	return names.map((name) => `«${name}»`).join(', ');
}

/**
 * Включение и выключение модуля в пространстве.
 *
 * Модуль, нужный стадии действующей редакции, выключить нельзя: он всё равно
 * продолжил бы действовать по правилу стадии, а настройки говорили бы
 * «выключен». Повторное включение и выключение выключенного ничего не меняют и
 * в журнал не пишутся.
 */
export async function setWorkspaceModule(
	ctx: ActorContext,
	input: SetWorkspaceModuleInput
): Promise<{ changed: boolean }> {
	await requirePermission(ctx, 'stages.configure', {
		type: input.enabled ? 'workspaces.module_enabled' : 'workspaces.module_disabled'
	});

	if (!isModuleKey(input.moduleKey)) {
		throw new ValidationError('Такого модуля нет');
	}

	const moduleKey = input.moduleKey;
	const label = moduleByKey(moduleKey)?.label ?? moduleKey;

	return withTransaction(ctx, async (tx) => {
		const workspace = await readWorkspaceByKey(tx, input.workspaceKey);

		let changed: boolean;

		if (input.enabled) {
			const inserted = await tx
				.insert(workspaceModules)
				.values({ workspaceId: workspace.id, moduleKey, enabledBy: ctx.user?.id ?? null })
				.onConflictDoNothing()
				.returning({ moduleKey: workspaceModules.moduleKey });

			changed = inserted.length > 0;
		} else {
			const { required } = await readActiveModules(workspace.id, tx);
			const stages = required.get(moduleKey);

			if (stages !== undefined) {
				throw new ConflictError(
					`Модуль «${label}» нужен ${stages.length === 1 ? 'стадии' : 'стадиям'} ${stageList(stages)} процесса пространства «${workspace.name}». Выключить его можно, когда стадии перестанут его требовать`
				);
			}

			const deleted = await tx
				.delete(workspaceModules)
				.where(
					and(
						eq(workspaceModules.workspaceId, workspace.id),
						eq(workspaceModules.moduleKey, moduleKey)
					)
				)
				.returning({ moduleKey: workspaceModules.moduleKey });

			changed = deleted.length > 0;
		}

		if (changed) {
			await recordAuditEvent(
				ctx,
				{
					type: input.enabled ? 'workspaces.module_enabled' : 'workspaces.module_disabled',
					outcome: 'success',
					subject: { type: 'workspace', id: workspace.id },
					details: { workspaceKey: workspace.key, moduleKey }
				},
				tx
			);
		}

		return { changed };
	});
}

/**
 * Отказ, если модуль не действует в пространстве взаимодействия. Для слоя
 * маршрута: действий и файлов модулей.
 *
 * Сначала видимость дела: чужое пространство отвечает тем же «не найдено», что
 * и несуществующее дело, а не рассказом о своих модулях.
 */
export async function assertModuleActive(
	ctx: ActorContext,
	interactionId: string,
	module: ModuleKey
): Promise<void> {
	const { workspaceId } = await assertInteractionVisible(ctx, interactionId);
	const { active } = await readActiveModules(workspaceId);

	if (active.includes(module)) {
		return;
	}

	const [workspace] = await getDb()
		.select({ name: workspaces.name })
		.from(workspaces)
		.where(eq(workspaces.id, workspaceId));

	throw new ValidationError(
		`Модуль «${moduleByKey(module)?.label ?? module}» не подключён к пространству «${workspace?.name ?? ''}»`,
		['Его подключают в «Настройки → Пространства»']
	);
}
