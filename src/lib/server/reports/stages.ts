/**
 * Стадии действующей редакции процесса — единственное место отчёта, которое
 * знает, как редакция связана со своими стадиями.
 *
 * Отчёт группирует строки по паре «группа процесса + ключ стадии из снимка» и
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
import { getDb } from '../db';
import { processGroups, stages } from '../db/schema';

/** Стадия действующей редакции: ключ, актуальное название и место в порядке. */
export type ReportStage = {
	key: string;
	name: string;
	position: number;
};

export type ReportProcessGroup = {
	id: string;
	key: string;
	name: string;
	/** В порядке процесса. Пусто, если действующей редакции у группы ещё нет. */
	stages: readonly ReportStage[];
};

/**
 * Все группы процесса с их действующими стадиями, в порядке групп.
 *
 * Читаются все группы, а не только те, что встретились в выборке: воронка
 * обязана показать и стадию, на которой сейчас никто не стоит, — ноль в ней
 * значит «никого», а отсутствие строки читается как «такой стадии нет».
 */
export async function readActiveProcessGroups(): Promise<Map<string, ReportProcessGroup>> {
	const rows = await getDb()
		.select({
			groupId: processGroups.id,
			groupKey: processGroups.key,
			groupName: processGroups.name,
			stageKey: stages.key,
			stageName: stages.name,
			stagePosition: stages.position
		})
		.from(processGroups)
		// Единственная строка отчёта про устройство редакции: действующая редакция
		// группы и её стадии.
		.leftJoin(stages, eq(stages.revisionId, processGroups.activeRevisionId))
		.orderBy(asc(processGroups.position), asc(stages.position));

	const groups = new Map<string, ReportProcessGroup & { stages: ReportStage[] }>();

	for (const row of rows) {
		let group = groups.get(row.groupId);

		if (group === undefined) {
			group = { id: row.groupId, key: row.groupKey, name: row.groupName, stages: [] };
			groups.set(row.groupId, group);
		}

		if (row.stageKey !== null && row.stageName !== null && row.stagePosition !== null) {
			group.stages.push({ key: row.stageKey, name: row.stageName, position: row.stagePosition });
		}
	}

	return groups;
}

/** Название и место стадии в порядке процесса. */
export type StageLabel = { label: string; order: number; retired: boolean };

export type StageIndex = {
	label: (groupId: string, key: string, snapshotName: string | null) => StageLabel;
	stageName: (key: string) => string;
	/** Заготовка воронки: все стадии действующих редакций, в порядке процесса. */
	skeleton: () => { bucketId: string; stageKey: string; label: StageLabel }[];
};

/**
 * Индекс стадий. Группировка идёт по паре «группа процесса + ключ стадии», а не
 * по названию и не по идентификатору стадии: ключ записан в момент входа и не
 * переписывается, поэтому переиздание процесса и переименование на числа не
 * влияют. Группа в ключе обязательна — одинаковые ключи в разных группах это
 * законная ситуация, и без неё две разные стадии слились бы в одну строку.
 */
export function createStageIndex(groups: Map<string, ReportProcessGroup>): StageIndex {
	const known = new Map<string, StageLabel>();
	const skeleton: { bucketId: string; stageKey: string; label: StageLabel }[] = [];
	const nameByKey = new Map<string, string>();
	const retired = new Map<string, StageLabel>();
	let order = 0;

	// Название стадии дополняется группой, только когда групп с процессом больше
	// одной: иначе «Встреча (B2B)» повторяет то, что и так написано на экране.
	const prefixed = [...groups.values()].filter((group) => group.stages.length > 0).length > 1;

	for (const group of groups.values()) {
		for (const stage of group.stages) {
			const bucketId = `${group.id}:${stage.key}`;
			const label: StageLabel = {
				label: prefixed ? `${stage.name} (${group.name})` : stage.name,
				order: order++,
				retired: false
			};

			known.set(bucketId, label);
			skeleton.push({ bucketId, stageKey: stage.key, label });

			if (!nameByKey.has(stage.key)) {
				nameByKey.set(stage.key, stage.name);
			}
		}
	}

	return {
		label(groupId, key, snapshotName) {
			const bucketId = `${groupId}:${key}`;
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
				missing = {
					label: `${snapshotName ?? key} (стадия удалена из процесса)`,
					order: order + retired.size,
					retired: true
				};
				retired.set(bucketId, missing);
			}

			return missing;
		},
		stageName(key) {
			return nameByKey.get(key) ?? key;
		},
		skeleton() {
			return skeleton;
		}
	};
}
