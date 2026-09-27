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
import { and, asc, eq } from 'drizzle-orm';
import type { ActorContext } from '../actor';
import { stages, workflows, workspaces } from '../db/schema';
import { workspaceFilter } from '../rbac';
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
 * Пространство отчёта с его действующими стадиями — или `null`, если такого нет
 * или сотрудник в него не включён.
 *
 * Стадии читаются все, а не только встретившиеся в выборке: воронка обязана
 * показать и стадию, на которой сейчас никто не стоит, — ноль в ней значит
 * «никого», а отсутствие строки читается как «такой стадии нет». Чужое
 * пространство и несуществующее неразличимы — оба `null`: название и стадии
 * чужого — уже сведения о направлении, в которое сотрудник не включён.
 */
export async function readReportWorkspace(
	db: ReportExecutor,
	ctx: ActorContext,
	key: string
): Promise<ReportWorkspace | null> {
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
		// Сотрудник видит пространство, только если включён в него: та же
		// граница, что у загрузчика ветки `/w/[workspace]`, но проверенная ещё раз
		// здесь — отчёт собирают и экран, и выгрузка, и машинный вызов.
		.where(and(eq(workspaces.key, key), workspaceFilter(ctx, workspaces.id)))
		.orderBy(asc(stages.position));

	const [first] = rows;

	if (first === undefined) {
		return null;
	}

	const found: ReportStage[] = [];

	for (const row of rows) {
		if (row.stageKey !== null && row.stageName !== null && row.stagePosition !== null) {
			found.push({ key: row.stageKey, name: row.stageName, position: row.stagePosition });
		}
	}

	return {
		id: first.workspaceId,
		key: first.workspaceKey,
		name: first.workspaceName,
		stages: found
	};
}

/** Название и место стадии в порядке процесса. */
export type StageLabel = {
	/**
	 * Название стадии — без пространства: отчёт и так собран внутри одного, и
	 * «Встреча (B2B)» повторяла бы заголовок экрана.
	 */
	label: string;
	order: number;
	retired: boolean;
};

/** Полоса заготовки воронки: имя, ключ стадии и её название с местом. */
export type StageSkeletonBucket = { bucketId: string; stageKey: string; label: StageLabel };

export type StageIndex = {
	/** Пространство отчёта: его название стоит в заголовке и имени файла. */
	workspace: ReportWorkspace;
	label: (key: string, snapshotName: string | null) => StageLabel;
	stageName: (key: string) => string;
	/** Заготовка воронки — стадии действующего процесса по порядку. */
	skeleton: () => readonly StageSkeletonBucket[];
};

/**
 * Имя полосы воронки: пространство и ключ стадии. Отчёт собран внутри одного
 * пространства, но в имени оно остаётся — так полосы группирует база
 * (`aggregate.ts`), и одинаковые ключи разных процессов не сольются, когда
 * имя уедет из отчёта в чужой файл или систему.
 */
export function stageBucketId(workspaceId: string, key: string): string {
	return `${workspaceId}:${key}`;
}

/**
 * Индекс стадий пространства отчёта. Группировка идёт по ключу стадии, а не по
 * названию и не по идентификатору стадии: ключ записан в момент входа и не
 * переписывается, поэтому переиздание процесса и переименование на числа не
 * влияют.
 */
export function createStageIndex(workspace: ReportWorkspace): StageIndex {
	const known = new Map<string, StageLabel>();
	const skeleton: StageSkeletonBucket[] = [];
	const retired = new Map<string, StageLabel>();
	let order = 0;

	for (const stage of workspace.stages) {
		const label: StageLabel = { label: stage.name, order: order++, retired: false };

		known.set(stage.key, label);
		skeleton.push({ bucketId: stageBucketId(workspace.id, stage.key), stageKey: stage.key, label });
	}

	return {
		workspace,
		label(key, snapshotName) {
			const found = known.get(key);

			if (found !== undefined) {
				return found;
			}

			// Ключа нет в действующем процессе: стадию удалили или объединили.
			// Показывается название из снимка с пометкой, и такие стадии стоят в
			// конце порядка — перенести строку в соседнюю стадию значило бы
			// изменить прошлое.
			let missing = retired.get(key);

			if (missing === undefined) {
				missing = {
					label: `${snapshotName ?? key} (стадия удалена из процесса)`,
					order: order + retired.size,
					retired: true
				};
				retired.set(key, missing);
			}

			return missing;
		},
		stageName(key) {
			return known.get(key)?.label ?? key;
		},
		skeleton() {
			return skeleton;
		}
	};
}
