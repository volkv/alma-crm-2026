/**
 * Стадии действующей редакции процесса — единственное место отчёта, которое
 * знает, как редакция связана со своими стадиями.
 *
 * Отчёт группирует строки по паре «пространство + ключ стадии из снимка» и
 * от редакции не зависит: ключ записан в момент входа и не переписывается,
 * поэтому переиздание процесса, перенумерация позиций и переименование на числа
 * не влияют. Редакция нужна ровно для двух вещей — показать актуальное название
 * стадии по её ключу и выстроить стадии в порядке процесса.
 *
 * Поэтому связь «редакция → её стадии» вынесена сюда одной строкой: таблица
 * `stage_routes` становится `process_revisions`, а `stages.route_id` —
 * `stages.revision_id`, и переименование правит эту функцию, а не пять запросов
 * в четырёх модулях.
 */
import { asc, eq } from 'drizzle-orm';
import { stages, workflows, workspaces } from '../db/schema';
import type { ReportExecutor } from './transaction';

/** Стадия действующей редакции: ключ, актуальное название и место в порядке. */
export type ReportStage = {
	key: string;
	name: string;
	position: number;
};

export type ReportWorkspace = {
	id: string;
	key: string;
	name: string;
	/**
	 * В порядке процесса. Пусто, если действующей редакции у пространства ещё
	 * нет.
	 */
	stages: readonly ReportStage[];
};

/**
 * Все пространства с их действующими стадиями, в порядке пространств.
 *
 * Читаются все пространства, а не только те, что встретились в выборке: воронка
 * обязана показать и стадию, на которой сейчас никто не стоит, — ноль в ней
 * значит «никого», а отсутствие строки читается как «такой стадии нет».
 */
export async function readActiveWorkspaces(
	db: ReportExecutor
): Promise<Map<string, ReportWorkspace>> {
	const rows = await db
		.select({
			workspaceId: workspaces.id,
			workspaceKey: workspaces.key,
			workspaceName: workspaces.name,
			stageKey: stages.key,
			stageName: stages.name,
			stagePosition: stages.position
		})
		.from(workspaces)
		// Единственная строка отчёта про устройство редакции: действующая редакция
		// назначенного процесса и её стадии.
		.leftJoin(workflows, eq(workflows.id, workspaces.workflowId))
		.leftJoin(stages, eq(stages.revisionId, workflows.activeRevisionId))
		.orderBy(asc(workspaces.position), asc(stages.position));

	const found = new Map<string, ReportWorkspace & { stages: ReportStage[] }>();

	for (const row of rows) {
		let workspace = found.get(row.workspaceId);

		if (workspace === undefined) {
			workspace = {
				id: row.workspaceId,
				key: row.workspaceKey,
				name: row.workspaceName,
				stages: []
			};
			found.set(row.workspaceId, workspace);
		}

		if (row.stageKey !== null && row.stageName !== null && row.stagePosition !== null) {
			workspace.stages.push({
				key: row.stageKey,
				name: row.stageName,
				position: row.stagePosition
			});
		}
	}

	return found;
}

/** Название и место стадии в порядке процесса. */
export type StageLabel = {
	/**
	 * Название для таблицы и сверки: с пространством в скобках, когда
	 * пространств с процессом больше одного. В строке таблицы иначе не понять,
	 * чья это стадия.
	 */
	label: string;
	/**
	 * Название без пространства: воронка пространства уже названа своим
	 * заголовком.
	 */
	name: string;
	order: number;
	retired: boolean;
};

/** Стадии одного пространства — заготовка его воронки, в порядке процесса. */
export type StageSkeletonWorkspace = {
	workspaceId: string;
	workspaceKey: string;
	workspaceName: string;
	stages: { bucketId: string; stageKey: string; label: StageLabel }[];
};

export type StageIndex = {
	label: (workspaceId: string, key: string, snapshotName: string | null) => StageLabel;
	stageName: (key: string) => string;
	/** Пространство по идентификатору: его ключ уходит в фильтр воронки. */
	workspace: (workspaceId: string) => ReportWorkspace | null;
	/**
	 * Заготовка воронок: по воронке на пространство, стадии — в порядке
	 * процесса.
	 */
	skeleton: () => StageSkeletonWorkspace[];
};

/**
 * Индекс стадий. Группировка идёт по паре «пространство + ключ стадии», а не
 * по названию и не по идентификатору стадии: ключ записан в момент входа и не
 * переписывается, поэтому переиздание процесса и переименование на числа не
 * влияют. Пространство в ключе обязательно — одинаковые ключи в разных
 * пространствах это законная ситуация, и без него две разные стадии слились бы
 * в одну строку.
 */
export function createStageIndex(workspacesById: Map<string, ReportWorkspace>): StageIndex {
	const known = new Map<string, StageLabel>();
	const skeleton: StageSkeletonWorkspace[] = [];
	const nameByKey = new Map<string, string>();
	const retired = new Map<string, StageLabel>();
	let order = 0;

	// Название стадии дополняется пространством, только когда пространств с
	// процессом больше одного: иначе «Встреча (B2B)» повторяет то, что и так
	// написано на экране.
	const prefixed =
		[...workspacesById.values()].filter((workspace) => workspace.stages.length > 0).length > 1;

	for (const workspace of workspacesById.values()) {
		const bucket: StageSkeletonWorkspace = {
			workspaceId: workspace.id,
			workspaceKey: workspace.key,
			workspaceName: workspace.name,
			stages: []
		};

		for (const stage of workspace.stages) {
			const bucketId = `${workspace.id}:${stage.key}`;
			const label: StageLabel = {
				label: prefixed ? `${stage.name} (${workspace.name})` : stage.name,
				name: stage.name,
				order: order++,
				retired: false
			};

			known.set(bucketId, label);
			bucket.stages.push({ bucketId, stageKey: stage.key, label });

			if (!nameByKey.has(stage.key)) {
				nameByKey.set(stage.key, stage.name);
			}
		}

		skeleton.push(bucket);
	}

	return {
		label(workspaceId, key, snapshotName) {
			const bucketId = `${workspaceId}:${key}`;
			const found = known.get(bucketId);

			if (found !== undefined) {
				return found;
			}

			// Ключа нет в действующем процессе: стадию удалили или объединили.
			// Показывается название из снимка с пометкой, и такие стадии стоят в
			// конце порядка — перенести строку в соседнюю стадию значило бы
			// изменить прошлое.
			let missing = retired.get(bucketId);

			if (missing === undefined) {
				const name = `${snapshotName ?? key} (стадия удалена из процесса)`;

				missing = { label: name, name, order: order + retired.size, retired: true };
				retired.set(bucketId, missing);
			}

			return missing;
		},
		stageName(key) {
			return nameByKey.get(key) ?? key;
		},
		workspace(workspaceId) {
			return workspacesById.get(workspaceId) ?? null;
		},
		skeleton() {
			return skeleton;
		}
	};
}
