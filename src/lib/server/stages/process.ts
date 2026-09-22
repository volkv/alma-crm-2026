/**
 * Живой процесс: структура пространства, её черновик и публикация как миграция.
 *
 * В каждом пространстве действует ровно одна редакция структуры, и пользователь
 * её не выбирает: номер редакции остаётся в базе и в журнале, но ни одного
 * решения не принимает. Изменение процесса — это черновик, который применяют ко
 * всем сразу, а применение переносит открытые записи стадий на новую структуру
 * по устойчивым ключам.
 *
 * Три правила, из которых выведено остальное:
 *
 * 1. публикация — это миграция данных, а не смена указателя, поэтому она
 *    атомарна и проходит под блокировками;
 * 2. история не переписывается: закрытые записи остаются на стадиях тех
 *    редакций, при которых их прошли, и их снимки не трогает никто;
 * 3. порядок блокировок односторонний — сначала пространство, потом
 *    взаимодействия по возрастанию идентификатора, — поэтому взаимного замка не
 *    возникает.
 */
import { and, asc, count, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm';
import { DOCUMENT_STATUS_FACT_LABELS, type DocumentMarkEvidence } from '$lib/contracts/documents';
import {
	processDefinitionSchema,
	type ProcessDefinitionInput,
	type WorkspaceDetail,
	type WorkspaceSummary,
	type ProcessPreview,
	type ProcessPreviewRow,
	type ProcessRevisionView,
	type StageChangeKind,
	type StageMigrationRuleView,
	type StageSnapshot,
	type StageTransitionView,
	type StageView
} from '$lib/contracts/interactions';
import type { ActorContext } from '../actor';
import { recordAuditEvent } from '../audit';
import { getDb } from '../db';
import {
	interactions,
	processGroupCounterpartyKinds,
	workspaces,
	processRevisions,
	processStageKeys,
	stageEntries,
	stageMigrationRules,
	stagePauses,
	stages,
	stageTransitions
} from '../db/schema';
import { withTransaction, type Tx } from '../db/transaction';
import { cachedActiveRevision, invalidateProcessRevisions } from '../cache/process';
import { readDocumentMark } from '../documents/evidence';
import { ConflictError, NotFoundError, ValidationError } from '../errors';
import { enqueueApplicationStatus } from '../integrations/exchange/outbox';
import { requirePermission } from '../rbac';

/** Любой исполнитель запроса: транзакция вызывающего или общий пул. */
export type Executor = Tx | ReturnType<typeof getDb>;

/** Строка пространства в том объёме, в каком её читают операции процесса. */
export type WorkspaceRow = {
	id: string;
	key: string;
	name: string;
	activeRevisionId: string | null;
};

export function toStageView(row: typeof stages.$inferSelect): StageView {
	return {
		id: row.id,
		revisionId: row.revisionId,
		position: row.position,
		key: row.key,
		name: row.name,
		category: row.category,
		slaDays: row.slaDays,
		staleAfterDays: row.staleAfterDays,
		requiresResult: row.requiresResult,
		requiresConfirmation: row.requiresConfirmation,
		requiresLmsData: row.requiresLmsData,
		requiresDocumentMark: row.requiresDocumentMark,
		isFinal: row.isFinal,
		checklist: row.checklist
	};
}

function toTransitionView(row: typeof stageTransitions.$inferSelect): StageTransitionView {
	return {
		id: row.id,
		fromStageId: row.fromStageId,
		toStageId: row.toStageId,
		kind: row.kind,
		requiredPermissionKey: row.requiredPermissionKey,
		requiresReason: row.requiresReason
	};
}

/**
 * Слепок стадии на момент входа. Процесс могут изменить, а норматив и чек-лист
 * уже пройденной стадии обязаны остаться такими, какими их видел исполнитель.
 * Собирается из стадии, а не из представления, — снимок делают и там, где
 * представления не строят.
 */
export function stageSnapshot(stage: {
	key: string;
	name: string;
	position: number;
	category: StageSnapshot['category'];
	slaDays: number;
	staleAfterDays: number | null;
	requiresResult: boolean;
	requiresConfirmation: boolean;
	requiresLmsData: boolean;
	requiresDocumentMark: StageSnapshot['requiresDocumentMark'];
	isFinal: boolean;
	checklist: StageSnapshot['checklist'];
}): StageSnapshot {
	return {
		key: stage.key,
		name: stage.name,
		position: stage.position,
		category: stage.category,
		slaDays: stage.slaDays,
		staleAfterDays: stage.staleAfterDays,
		requiresResult: stage.requiresResult,
		requiresConfirmation: stage.requiresConfirmation,
		requiresLmsData: stage.requiresLmsData,
		requiresDocumentMark: stage.requiresDocumentMark,
		isFinal: stage.isFinal,
		checklist: stage.checklist
	};
}

/**
 * Редакция вместе со стадиями, переходами и правилами переноса. Без проверки
 * прав: её делает тот, кто решает, зачем структуру читают, — карточка, доска
 * или раздел настроек.
 */
export async function readRevision(
	executor: Executor,
	revisionId: string
): Promise<ProcessRevisionView> {
	const [revision] = await executor
		.select()
		.from(processRevisions)
		.where(eq(processRevisions.id, revisionId));

	if (revision === undefined) {
		throw new NotFoundError('Редакция процесса не найдена');
	}

	const [stageRows, transitionRows, ruleRows] = await Promise.all([
		executor
			.select()
			.from(stages)
			.where(eq(stages.revisionId, revisionId))
			.orderBy(asc(stages.position)),
		executor.select().from(stageTransitions).where(eq(stageTransitions.revisionId, revisionId)),
		executor
			.select()
			.from(stageMigrationRules)
			.where(eq(stageMigrationRules.revisionId, revisionId))
			.orderBy(asc(stageMigrationRules.removedStageKey))
	]);

	return {
		id: revision.id,
		groupId: revision.groupId,
		version: revision.version,
		name: revision.name,
		note: revision.note,
		publishedAt: revision.publishedAt,
		stages: stageRows.map(toStageView),
		transitions: transitionRows.map(toTransitionView),
		migrationRules: ruleRows.map((row) => ({
			removedStageKey: row.removedStageKey,
			targetStageKey: row.targetStageKey
		}))
	};
}

/**
 * Пространство по идентификатору. Отсутствие — это поломка данных, а не
 * состояние.
 */
export async function readWorkspaceRow(
	executor: Executor,
	workspaceId: string
): Promise<WorkspaceRow> {
	const [row] = await executor
		.select({
			id: workspaces.id,
			key: workspaces.key,
			name: workspaces.name,
			activeRevisionId: workspaces.activeRevisionId
		})
		.from(workspaces)
		.where(eq(workspaces.id, workspaceId));

	if (row === undefined) {
		throw new NotFoundError('Пространство не найдено');
	}

	return row;
}

/**
 * Пространство под блокировкой.
 *
 * `update` берут публикация и правка черновика — две такие операции
 * выстраиваются в очередь. `share` берёт создание взаимодействия и приём
 * заявки: пока публикация держит `update`, создание ждёт; пока создания держат
 * `share`, ждёт публикация. Без этого взаимодействие, созданное в миллисекунду
 * публикации, встало бы на стадию редакции, которая уже не действует, — шаг
 * «заблокировать незавершённые» таких строк ещё не видит.
 */
export async function lockWorkspace(
	tx: Tx,
	workspaceId: string,
	mode: 'update' | 'share'
): Promise<WorkspaceRow> {
	const query = tx
		.select({
			id: workspaces.id,
			key: workspaces.key,
			name: workspaces.name,
			activeRevisionId: workspaces.activeRevisionId
		})
		.from(workspaces)
		.where(eq(workspaces.id, workspaceId));

	const [row] = await (mode === 'update' ? query.for('update') : query.for('share'));

	if (row === undefined) {
		throw new NotFoundError('Пространство не найдено');
	}

	return row;
}

/**
 * Действующая редакция процесса пространства. Её отсутствие — рабочее
 * состояние: пространство заведено миграцией, а процесс в нём ещё не описан.
 */
export async function readActiveRevision(
	executor: Executor,
	workspace: WorkspaceRow
): Promise<ProcessRevisionView | null> {
	return workspace.activeRevisionId === null
		? null
		: readRevision(executor, workspace.activeRevisionId);
}

/**
 * Та же редакция, но из кэша: для тех, кто читает структуру, чтобы показать её,
 * — карточка, её список и доска. Внутри транзакции звать нельзя и незачем:
 * правка процесса обязана видеть то, что она сама уже записала, а кэш отвечает
 * состоянием на момент последней публикации.
 */
export async function readActiveRevisionCached(
	workspace: WorkspaceRow
): Promise<ProcessRevisionView | null> {
	return cachedActiveRevision(workspace.id, () => readActiveRevision(getDb(), workspace));
}

/** Та же редакция, но её отсутствие — отказ словами, а не пустая лента. */
export async function requireActiveRevision(
	executor: Executor,
	workspace: WorkspaceRow
): Promise<ProcessRevisionView> {
	const revision = await readActiveRevision(executor, workspace);

	if (revision === null) {
		throw new ConflictError(
			`Для пространства «${workspace.name}» процесс ещё не описан: заведите стадии в разделе «Процесс» и примените их ко всем`
		);
	}

	return revision;
}

/**
 * Пространство по виду контрагента. Таблица соответствий одна на продукт:
 * второе правило выбора означало бы, что одна и та же заявка получает разные
 * процессы в зависимости от канала.
 */
export async function resolveWorkspace(executor: Executor, kind: string): Promise<WorkspaceRow> {
	const [row] = await executor
		.select({
			id: workspaces.id,
			key: workspaces.key,
			name: workspaces.name,
			activeRevisionId: workspaces.activeRevisionId
		})
		.from(processGroupCounterpartyKinds)
		.innerJoin(workspaces, eq(workspaces.id, processGroupCounterpartyKinds.groupId))
		.where(eq(processGroupCounterpartyKinds.kind, kind as 'educational_institution'))
		.limit(1);

	if (row === undefined) {
		throw new ValidationError('Этот вид организации не может быть основной стороной', [
			`Организации вида «${kind}» не задают процесс: основной стороной бывают учебное заведение, юридическое и физическое лицо`
		]);
	}

	return row;
}

/** Первая стадия редакции: с неё взаимодействие начинает путь. */
export function firstStage(revision: ProcessRevisionView): StageView {
	const stage = [...revision.stages].sort((left, right) => left.position - right.position)[0];

	if (stage === undefined) {
		throw new ConflictError('В действующей редакции процесса нет ни одной стадии');
	}

	return stage;
}

/**
 * Структура редакции в том виде, в каком её принимает запись. Переходы
 * адресуются ключами: стадия новой редакции — другая строка, а ключ тот же.
 */
export function processDefinition(revision: ProcessRevisionView): ProcessDefinitionInput {
	const keyByStageId = new Map(revision.stages.map((stage) => [stage.id, stage.key]));

	return {
		name: revision.name,
		note: revision.note,
		migrationRules: revision.migrationRules.map((rule) => ({ ...rule })),
		stages: [...revision.stages]
			.sort((left, right) => left.position - right.position)
			.map((stage) => ({
				key: stage.key,
				name: stage.name,
				category: stage.category,
				slaDays: stage.slaDays,
				staleAfterDays: stage.staleAfterDays,
				requiresResult: stage.requiresResult,
				requiresConfirmation: stage.requiresConfirmation,
				requiresLmsData: stage.requiresLmsData,
				requiresDocumentMark: stage.requiresDocumentMark,
				isFinal: stage.isFinal,
				checklist: stage.checklist.map((item) => ({ ...item }))
			})),
		transitions: revision.transitions.map((transition) => {
			const fromStageKey = keyByStageId.get(transition.fromStageId);
			const toStageKey = keyByStageId.get(transition.toStageId);

			// Переход на стадию чужой редакции — испорченные данные, а не то, что
			// можно скопировать в черновик: молча выбросив его, мы потеряли бы часть
			// описания процесса, о которой никто не узнает.
			if (fromStageKey === undefined || toStageKey === undefined) {
				throw new ValidationError('Редакция ссылается на стадию, которой в ней нет', [
					`Переход ${transition.id} ведёт мимо стадий редакции`
				]);
			}

			return {
				fromStageKey,
				toStageKey,
				kind: transition.kind,
				requiredPermissionKey: transition.requiredPermissionKey,
				requiresReason: transition.requiresReason
			};
		})
	};
}

/**
 * Снимок отметки для записи, переезжающей на новую структуру.
 *
 * Пустой набор полей, когда стадия отметки не требует: прежнее значение — это
 * история записи, и стирать его правкой процесса незачем. Показывает его
 * карточка только там, где требование есть.
 */
async function documentMarkPatch(
	tx: Tx,
	interactionId: string,
	requiredMark: StageSnapshot['requiresDocumentMark']
): Promise<{ documentMarkEvidence?: DocumentMarkEvidence | null }> {
	if (requiredMark === null) {
		return {};
	}

	return { documentMarkEvidence: await readDocumentMark(tx, interactionId, requiredMark) };
}

/** Стадии и переходы одной редакции. Пишутся целиком: правится описание. */
async function writeRevisionContent(
	tx: Tx,
	revisionId: string,
	input: ProcessDefinitionInput
): Promise<Map<string, string>> {
	const inserted = await tx
		.insert(stages)
		.values(
			input.stages.map((stage, index) => ({
				revisionId,
				position: index + 1,
				key: stage.key,
				name: stage.name,
				category: stage.category,
				slaDays: stage.slaDays,
				staleAfterDays: stage.staleAfterDays,
				requiresResult: stage.requiresResult,
				requiresConfirmation: stage.requiresConfirmation,
				requiresLmsData: stage.requiresLmsData,
				requiresDocumentMark: stage.requiresDocumentMark,
				isFinal: stage.isFinal,
				checklist: stage.checklist
			}))
		)
		.returning({ id: stages.id, key: stages.key });

	const idByKey = new Map(inserted.map((stage) => [stage.key, stage.id]));

	if (input.transitions.length > 0) {
		await tx.insert(stageTransitions).values(
			input.transitions.map((transition) => {
				const fromStageId = idByKey.get(transition.fromStageKey);
				const toStageId = idByKey.get(transition.toStageKey);

				// Схема контракта это уже проверила; здесь остаётся только снять
				// неопределённость типа — карта построена из тех же ключей.
				if (fromStageId === undefined || toStageId === undefined) {
					throw new ValidationError('Переход ссылается на стадию, которой нет в процессе', [
						`${transition.fromStageKey} → ${transition.toStageKey}`
					]);
				}

				return {
					revisionId,
					fromStageId,
					toStageId,
					kind: transition.kind,
					requiredPermissionKey: transition.requiredPermissionKey,
					requiresReason: transition.requiresReason
				};
			})
		);
	}

	if (input.migrationRules.length > 0) {
		await tx.insert(stageMigrationRules).values(
			input.migrationRules.map((rule) => ({
				revisionId,
				removedStageKey: rule.removedStageKey,
				targetStageKey: rule.targetStageKey
			}))
		);
	}

	return idByKey;
}

/**
 * Следующий номер редакции внутри пространства. Колонка редакции пока зовётся
 * `group_id` и указывает на пространство: цепочка редакций переедет на процесс
 * отдельным шагом, и двигать её заодно с местом значило бы смешать две правки в
 * одной миграции.
 */
async function nextVersion(executor: Executor, workspaceId: string): Promise<number> {
	const [row] = await executor
		.select({ value: sql<number>`coalesce(max(${processRevisions.version}), 0)::int` })
		.from(processRevisions)
		.where(eq(processRevisions.groupId, workspaceId));

	return (row?.value ?? 0) + 1;
}

/* ------------------------------------------------------------------------- *
 * Чистые правила: сопоставление ключей, цель переноса, проверка структуры.
 * ------------------------------------------------------------------------- */

/** Параметры стадии, изменение которых пересобирает снимок открытой записи. */
type ComparableStage = {
	key: string;
	name: string;
	category: StageSnapshot['category'];
	slaDays: number;
	staleAfterDays: number | null;
	requiresResult: boolean;
	requiresConfirmation: boolean;
	requiresLmsData: boolean;
	requiresDocumentMark: StageSnapshot['requiresDocumentMark'];
	isFinal: boolean;
	checklist: { key: string; label: string; required: boolean }[];
};

/** Что стало со стадией: одна строка сопоставления по ключу. */
export type StageMatch = {
	key: string;
	change: StageChangeKind;
	/** Что именно изменилось в параметрах — по фразе на параметр. */
	changes: string[];
	/** Название после изменения; у удалённой — прежнее. */
	name: string;
};

function checklistText(
	items: readonly { key: string; label: string; required: boolean }[]
): string {
	return items.map((item) => `${item.required ? '*' : ''}${item.key}:${item.label}`).join('|');
}

/** Чем стадия черновика отличается от одноимённой стадии действующей структуры. */
function stageDifferences(before: ComparableStage, after: ComparableStage): string[] {
	const changes: string[] = [];

	if (before.name !== after.name) {
		changes.push(`название: «${before.name}» → «${after.name}»`);
	}

	if (before.category !== after.category) {
		changes.push(`смысловая группа: ${before.category} → ${after.category}`);
	}

	if (before.slaDays !== after.slaDays) {
		changes.push(`норматив: ${before.slaDays} → ${after.slaDays} дн.`);
	}

	if (before.staleAfterDays !== after.staleAfterDays) {
		changes.push(
			`срок протухания: ${before.staleAfterDays ?? 'нет'} → ${after.staleAfterDays ?? 'нет'}`
		);
	}

	if (before.requiresResult !== after.requiresResult) {
		changes.push(
			after.requiresResult ? 'начинает требовать результат' : 'больше не требует результата'
		);
	}

	if (before.requiresConfirmation !== after.requiresConfirmation) {
		changes.push(
			after.requiresConfirmation
				? 'начинает требовать подтверждение'
				: 'больше не требует подтверждения'
		);
	}

	if (before.requiresLmsData !== after.requiresLmsData) {
		changes.push(
			after.requiresLmsData
				? 'начинает требовать данные обучения'
				: 'больше не требует данных обучения'
		);
	}

	if (before.requiresDocumentMark !== after.requiresDocumentMark) {
		changes.push(
			after.requiresDocumentMark === null
				? 'больше не требует отметки документа'
				: `начинает требовать отметку документа «${DOCUMENT_STATUS_FACT_LABELS[after.requiresDocumentMark]}»`
		);
	}

	if (before.isFinal !== after.isFinal) {
		changes.push(after.isFinal ? 'становится финальной' : 'перестаёт быть финальной');
	}

	if (checklistText(before.checklist) !== checklistText(after.checklist)) {
		changes.push('изменён чек-лист');
	}

	return changes;
}

/**
 * Сопоставление стадий по ключу в пределах процесса пространства.
 *
 * Именно по ключу, а не по идентификатору строки: строка `stages` живёт внутри
 * редакции и меняется с каждой публикацией, а ключ внутри одного процесса не
 * меняется никогда. Переименование отличается от «удалили и добавили» тем же
 * ключом — иначе история стадии обрывалась бы на каждой правке названия.
 */
export function matchStages(
	active: readonly ComparableStage[],
	draft: readonly ComparableStage[]
): StageMatch[] {
	const draftByKey = new Map(draft.map((stage) => [stage.key, stage]));
	const activeByKey = new Map(active.map((stage) => [stage.key, stage]));
	const matches: StageMatch[] = [];

	for (const before of active) {
		const after = draftByKey.get(before.key);

		if (after === undefined) {
			matches.push({ key: before.key, change: 'removed', changes: [], name: before.name });
			continue;
		}

		const changes = stageDifferences(before, after);

		if (changes.length === 0) {
			matches.push({ key: before.key, change: 'kept', changes, name: after.name });
			continue;
		}

		// Переименование — отдельный случай, а не «параметры изменились»: оно
		// видно на всех экранах сразу и объясняется человеку другими словами.
		const renamedOnly = changes.length === 1 && before.name !== after.name;

		matches.push({
			key: before.key,
			change: renamedOnly ? 'renamed' : 'changed',
			changes,
			name: after.name
		});
	}

	for (const after of draft) {
		if (!activeByKey.has(after.key)) {
			matches.push({ key: after.key, change: 'added', changes: [], name: after.name });
		}
	}

	return matches;
}

/**
 * Куда по умолчанию переедут записи с удаляемой стадии.
 *
 * Предыдущая сохранившаяся стадия: работа возвращается на шаг назад, а не
 * проскакивает вперёд мимо того, чего ещё не сделали. У первой стадии
 * предыдущей нет — для неё цель это следующая сохранившаяся.
 */
export function defaultMigrationTarget(
	activeOrderedKeys: readonly string[],
	removedKey: string,
	survivingKeys: ReadonlySet<string>
): string | null {
	const index = activeOrderedKeys.indexOf(removedKey);

	if (index === -1) {
		return null;
	}

	for (let step = index - 1; step >= 0; step -= 1) {
		const key = activeOrderedKeys[step];

		if (survivingKeys.has(key)) {
			return key;
		}
	}

	for (let step = index + 1; step < activeOrderedKeys.length; step += 1) {
		const key = activeOrderedKeys[step];

		if (survivingKeys.has(key)) {
			return key;
		}
	}

	return null;
}

/** Структура черновика в объёме, который проверяют правила пригодности. */
export type DraftShape = {
	stages: { key: string; name: string; position: number; category: string; isFinal: boolean }[];
	transitions: { fromStageKey: string; toStageKey: string; kind: string }[];
	migrationRules: { removedStageKey: string; targetStageKey: string }[];
};

/**
 * Что мешает применить эту структуру ко всем — по фразе на претензию.
 *
 * Чистая функция: на входе структура и то, что о ней знает база (архивные
 * ключи, число незавершённых на каждой стадии), на выходе список претензий
 * словами. Схема контракта проверяет форму описания, а здесь — его пригодность
 * к работе: по процессу, из которого некуда идти, взаимодействие встанет
 * навсегда.
 */
export function validateProcessDraft(
	draft: DraftShape,
	context: {
		/** Ключи, которые в этом процессе когда-то были и помечены архивными. */
		archivedKeys: ReadonlySet<string>;
		/** Ключи действующей структуры по порядку; пусто у первой редакции. */
		activeOrderedKeys: readonly string[];
		/** Сколько незавершённых взаимодействий стоит на стадии с этим ключом. */
		openByKey: ReadonlyMap<string, number>;
	} = { archivedKeys: new Set(), activeOrderedKeys: [], openByKey: new Map() }
): string[] {
	const issues: string[] = [];
	const ordered = [...draft.stages].sort((left, right) => left.position - right.position);

	if (ordered.length === 0) {
		return ['В процессе нет ни одной стадии'];
	}

	const positionOf = new Map(ordered.map((stage) => [stage.key, stage.position]));
	const nameOf = new Map(ordered.map((stage) => [stage.key, stage.name]));
	const positions = new Map<number, string>();

	for (const stage of ordered) {
		const taken = positions.get(stage.position);

		if (taken !== undefined) {
			issues.push(`Позиция ${stage.position} занята двумя стадиями: «${taken}» и «${stage.name}»`);
		} else {
			positions.set(stage.position, stage.name);
		}

		// Группа говорит, на каком участке процесса мы стоим, название — что на
		// нём делают. Стадия, названная кодом своей группы, не отвечает ни на
		// один из двух вопросов.
		if (stage.name.trim().toLowerCase() === stage.category) {
			issues.push(
				`Стадия «${stage.name}» названа кодом своей смысловой группы: название должно говорить, что на ней делают`
			);
		}

		// Ключ, который когда-либо был в этом процессе и убран, остаётся занятым:
		// иначе история прошлого года, сопоставленная по ключу, приросла бы
		// записями совсем другой работы, и никакой отчёт этого не покажет.
		if (context.archivedKeys.has(stage.key)) {
			issues.push(
				`Ключ «${stage.key}» уже был в этом процессе и снят: заведите стадию под другим ключом`
			);
		}
	}

	const forwardFrom = new Set<string>();
	const forwardTo = new Set<string>();
	const reachable = new Map<string, string[]>();

	for (const transition of draft.transitions) {
		const from = positionOf.get(transition.fromStageKey);
		const to = positionOf.get(transition.toStageKey);

		if (from === undefined || to === undefined) {
			issues.push(
				`Переход ${transition.fromStageKey} → ${transition.toStageKey} ведёт на стадию, которой нет в процессе`
			);
			continue;
		}

		if (transition.kind === 'forward') {
			forwardFrom.add(transition.fromStageKey);
			forwardTo.add(transition.toStageKey);

			if (to <= from) {
				issues.push(
					`Переход вперёд «${nameOf.get(transition.fromStageKey)}» → «${nameOf.get(transition.toStageKey)}» ведёт назад по порядку стадий`
				);
			}
		}

		if (transition.kind === 'return' && to >= from) {
			issues.push(
				`Возврат «${nameOf.get(transition.fromStageKey)}» → «${nameOf.get(transition.toStageKey)}» ведёт вперёд по порядку стадий`
			);
		}

		const next = reachable.get(transition.fromStageKey) ?? [];
		next.push(transition.toStageKey);
		reachable.set(transition.fromStageKey, next);
	}

	const finals = ordered.filter((stage) => stage.isFinal);

	if (finals.length === 0) {
		issues.push('В процессе нет ни одной финальной стадии: его нечем закончить');
	}

	for (const stage of ordered) {
		if (!stage.isFinal && !forwardFrom.has(stage.key)) {
			issues.push(`У стадии «${stage.name}» нет перехода вперёд: с неё не уйти дальше`);
		}
	}

	// Первая стадия — только стартовая: переход, ведущий на неё вперёд, означал
	// бы, что процесс начинается дважды.
	const first = ordered[0];

	if (forwardTo.has(first.key)) {
		issues.push(`На первую стадию «${first.name}» ведёт переход вперёд: начало процесса одно`);
	}

	if (finals.length > 0) {
		const finalKeys = new Set(finals.map((stage) => stage.key));

		for (const stage of ordered) {
			if (!canReachFinal(stage.key, reachable, finalKeys)) {
				issues.push(
					`Со стадии «${stage.name}» не добраться ни до одной финальной: взаимодействие встанет на ней навсегда`
				);
			}
		}
	}

	const survivingKeys = new Set(ordered.map((stage) => stage.key));
	const ruleByKey = new Map(draft.migrationRules.map((rule) => [rule.removedStageKey, rule]));

	for (const removedKey of context.activeOrderedKeys) {
		if (survivingKeys.has(removedKey)) {
			continue;
		}

		const rule = ruleByKey.get(removedKey);
		const standing = context.openByKey.get(removedKey) ?? 0;

		// Правило обязательно там, где на стадии кто-то стоит: без него
		// незавершённым взаимодействиям некуда переехать, и публикация оставила
		// бы их на стадии несуществующей редакции.
		if (rule === undefined && standing > 0) {
			issues.push(
				`На стадии «${removedKey}» стоит незавершённых взаимодействий: ${standing}. Укажите, куда их перенести`
			);
			continue;
		}

		if (rule !== undefined && !survivingKeys.has(rule.targetStageKey)) {
			issues.push(
				`Правило переноса со стадии «${removedKey}» ведёт на «${rule.targetStageKey}», которой в процессе нет`
			);
		}
	}

	return issues;
}

/** Достижима ли из стадии хотя бы одна финальная — обход в ширину по переходам. */
function canReachFinal(
	from: string,
	reachable: ReadonlyMap<string, string[]>,
	finalKeys: ReadonlySet<string>
): boolean {
	const seen = new Set<string>([from]);
	const queue = [from];

	while (queue.length > 0) {
		const key = queue.shift() as string;

		if (finalKeys.has(key)) {
			return true;
		}

		for (const next of reachable.get(key) ?? []) {
			if (!seen.has(next)) {
				seen.add(next);
				queue.push(next);
			}
		}
	}

	return false;
}

/**
 * Предпросмотр применения: строка на каждую затронутую стадию плюс итог.
 *
 * Чистая функция, потому что её же считает тест и по ней же собирается таблица
 * на экране. Числа берутся снаружи: считать их здесь значило бы ходить в базу
 * из функции, которую зовут, чтобы объяснить решение.
 */
export function buildPreview(input: {
	groupId: string;
	matches: readonly StageMatch[];
	openByKey: ReadonlyMap<string, number>;
	migrationRules: readonly StageMigrationRuleView[];
	nameByKey: ReadonlyMap<string, string>;
	issues: readonly string[];
}): ProcessPreview {
	const ruleByKey = new Map(input.migrationRules.map((rule) => [rule.removedStageKey, rule]));
	const rows: ProcessPreviewRow[] = [];
	const movedFrom = new Set<string>();

	for (const match of input.matches) {
		const standing = input.openByKey.get(match.key) ?? 0;
		const rule = match.change === 'removed' ? ruleByKey.get(match.key) : undefined;

		if (match.change === 'removed' && standing > 0) {
			movedFrom.add(match.key);
		}

		rows.push({
			stageKey: match.key,
			stageName: match.name,
			change: match.change,
			changes: match.changes,
			interactions: standing,
			targetStageKey: rule?.targetStageKey ?? null,
			targetStageName:
				rule === undefined
					? null
					: (input.nameByKey.get(rule.targetStageKey) ?? rule.targetStageKey)
		});
	}

	// Затронутыми считаются те, кто переезжает: перепривязка записи к стадии с
	// тем же ключом человеку не видна и в число «затронуто» не идёт.
	const affected = [...movedFrom].reduce(
		(total, key) => total + (input.openByKey.get(key) ?? 0),
		0
	);

	return { groupId: input.groupId, affected, rows, issues: [...input.issues] };
}

/* ------------------------------------------------------------------------- *
 * Чтение: список пространств и процесс одного пространства.
 * ------------------------------------------------------------------------- */

/**
 * Сколько незавершённых взаимодействий пространства стоит на каждом ключе
 * стадии.
 *
 * По ключу из стадии, а не из снимка: снимок описывает то, что видел
 * исполнитель, а перенос работает с тем, где запись стоит сейчас.
 */
async function countOpenByStageKey(
	executor: Executor,
	workspaceId: string
): Promise<Map<string, number>> {
	const rows = await executor
		.select({ key: stages.key, value: count() })
		.from(stageEntries)
		.innerJoin(interactions, eq(interactions.id, stageEntries.interactionId))
		.innerJoin(stages, eq(stages.id, stageEntries.stageId))
		.where(
			and(
				isNull(stageEntries.leftAt),
				eq(interactions.workspaceId, workspaceId),
				eq(interactions.status, 'active')
			)
		)
		.groupBy(stages.key);

	return new Map(rows.map((row) => [row.key, row.value]));
}

/**
 * Архивные ключи процесса пространства: заводить стадию под ними нельзя. Реестр
 * ключей пока привязан колонкой `group_id` к пространству — на процесс он
 * переедет вместе с редакциями.
 */
async function readArchivedKeys(executor: Executor, workspaceId: string): Promise<Set<string>> {
	const rows = await executor
		.select({ key: processStageKeys.key })
		.from(processStageKeys)
		.where(
			and(
				eq(processStageKeys.groupId, workspaceId),
				sql`${processStageKeys.archivedAt} is not null`
			)
		);

	return new Set(rows.map((row) => row.key));
}

/**
 * Пространства со счётчиками. Счётчики считаются отдельными запросами, а не
 * соединением: стадии и взаимодействия — разные множества, и одно соединение
 * перемножило бы их, дав правдоподобное, но неверное число.
 */
export async function listWorkspaces(ctx: ActorContext): Promise<WorkspaceSummary[]> {
	await requirePermission(ctx, 'stages.configure', { type: 'stages.process_viewed' });

	return readWorkspaces();
}

/**
 * Те же пространства, но для того, кто заводит взаимодействие, а не настраивает
 * процесс. Форма заведения показывает ими, что произойдёт после сохранения, и
 * говорит заранее, если в пространстве процесса ещё нет; права настраивать
 * процесс у КАМа при этом нет, и требовать его здесь значило бы закрыть форму
 * от того, кто ею и пользуется.
 */
export async function listWorkspacesForWork(ctx: ActorContext): Promise<WorkspaceSummary[]> {
	requirePermission(ctx, 'interactions.write');

	return readWorkspaces();
}

async function readWorkspaces(): Promise<WorkspaceSummary[]> {
	const db = getDb();

	const [rows, stageCounts, activeCounts, drafts] = await Promise.all([
		db.select().from(workspaces).orderBy(asc(workspaces.position)),
		db
			.select({ revisionId: stages.revisionId, value: count() })
			.from(stages)
			.groupBy(stages.revisionId),
		db
			.select({ workspaceId: interactions.workspaceId, value: count() })
			.from(interactions)
			.where(eq(interactions.status, 'active'))
			.groupBy(interactions.workspaceId),
		db
			// Черновик висит на колонке `group_id`, которая сегодня указывает на
			// пространство: цепочка редакций переедет на процесс отдельным шагом.
			.select({ workspaceId: processRevisions.groupId })
			.from(processRevisions)
			.where(isNull(processRevisions.publishedAt))
	]);

	const stagesByRevision = new Map(stageCounts.map((row) => [row.revisionId, row.value]));
	const activeByWorkspace = new Map(activeCounts.map((row) => [row.workspaceId, row.value]));
	const workspacesWithDraft = new Set(drafts.map((row) => row.workspaceId));

	return rows.map((workspace) => ({
		id: workspace.id,
		key: workspace.key,
		name: workspace.name,
		description: workspace.description,
		position: workspace.position,
		stageCount:
			workspace.activeRevisionId === null
				? 0
				: (stagesByRevision.get(workspace.activeRevisionId) ?? 0),
		activeInteractions: activeByWorkspace.get(workspace.id) ?? 0,
		hasDraft: workspacesWithDraft.has(workspace.id)
	}));
}

/** Пространство по ключу. Ключ, а не идентификатор: адрес раздела читают люди. */
export async function readWorkspaceByKey(executor: Executor, key: string): Promise<WorkspaceRow> {
	const [row] = await executor
		.select({
			id: workspaces.id,
			key: workspaces.key,
			name: workspaces.name,
			activeRevisionId: workspaces.activeRevisionId
		})
		.from(workspaces)
		.where(eq(workspaces.key, key));

	if (row === undefined) {
		throw new NotFoundError('Пространство не найдено');
	}

	return row;
}

/** Черновик пространства, если он заведён. У пространства он один. */
export async function readDraft(
	executor: Executor,
	workspaceId: string
): Promise<ProcessRevisionView | null> {
	const [row] = await executor
		.select({ id: processRevisions.id })
		.from(processRevisions)
		.where(and(eq(processRevisions.groupId, workspaceId), isNull(processRevisions.publishedAt)))
		.limit(1);

	return row === undefined ? null : readRevision(executor, row.id);
}

/**
 * Процесс пространства целиком: что действует, что в черновике и что ему мешает.
 */
export async function getWorkspace(
	ctx: ActorContext,
	workspaceKey: string
): Promise<WorkspaceDetail> {
	await requirePermission(ctx, 'stages.configure', { type: 'stages.process_viewed' });

	const db = getDb();
	const workspace = await readWorkspaceByKey(db, workspaceKey);

	const [summaries, active, draft, kinds, openByKey, archivedKeys] = await Promise.all([
		listWorkspaces(ctx),
		readActiveRevision(db, workspace),
		readDraft(db, workspace.id),
		db
			.select({ kind: processGroupCounterpartyKinds.kind })
			.from(processGroupCounterpartyKinds)
			.where(eq(processGroupCounterpartyKinds.groupId, workspace.id))
			.orderBy(asc(processGroupCounterpartyKinds.kind)),
		countOpenByStageKey(db, workspace.id),
		readArchivedKeys(db, workspace.id)
	]);

	const summary = summaries.find((row) => row.id === workspace.id);

	if (summary === undefined) {
		throw new NotFoundError('Пространство не найдено');
	}

	return {
		workspace: summary,
		active,
		draft,
		counterpartyKinds: kinds.map((row) => row.kind),
		issues:
			draft === null
				? []
				: validateProcessDraft(toDraftShape(draft), {
						archivedKeys: keysOutsideDraft(archivedKeys, draft),
						activeOrderedKeys: orderedKeys(active),
						openByKey
					})
	};
}

/** Ключи стадий редакции по порядку; у отсутствующей редакции — пусто. */
export function orderedKeys(revision: ProcessRevisionView | null): string[] {
	return revision === null
		? []
		: [...revision.stages].sort((left, right) => left.position - right.position).map((s) => s.key);
}

/** Черновик в объёме, который проверяют правила пригодности. */
export function toDraftShape(revision: ProcessRevisionView): DraftShape {
	return {
		stages: revision.stages.map((stage) => ({
			key: stage.key,
			name: stage.name,
			position: stage.position,
			category: stage.category,
			isFinal: stage.isFinal
		})),
		transitions: revision.transitions.map((transition) => {
			const keyOf = (stageId: string): string =>
				revision.stages.find((stage) => stage.id === stageId)?.key ?? stageId;

			return {
				fromStageKey: keyOf(transition.fromStageId),
				toStageKey: keyOf(transition.toStageId),
				kind: transition.kind
			};
		}),
		migrationRules: revision.migrationRules.map((rule) => ({ ...rule }))
	};
}

/**
 * Архивные ключи за вычетом тех, что стоят в самом черновике под своим прежним
 * смыслом. Такого не бывает у корректных данных, но проверка по множеству
 * должна быть явной: архивным считается ключ, снятый прошлой публикацией.
 */
function keysOutsideDraft(archived: ReadonlySet<string>, draft: ProcessRevisionView): Set<string> {
	return new Set([...archived].filter((key) => draft.stages.some((stage) => stage.key === key)));
}

/* ------------------------------------------------------------------------- *
 * Черновик: завести, править, отменить.
 * ------------------------------------------------------------------------- */

/**
 * Черновик изменений — копия действующей структуры.
 *
 * Так меняется процесс: действующую редакцию править нельзя, а писать её
 * заново руками значит переписать четырнадцать стадий ради правки одного
 * норматива. У пространства без процесса черновик заводится пустым — с одной
 * стадией, потому что процесса без стадий не существует.
 */
export async function createDraft(
	ctx: ActorContext,
	workspaceKey: string
): Promise<ProcessRevisionView> {
	await requirePermission(ctx, 'stages.configure', { type: 'stages.draft_created' });

	return withTransaction(ctx, async (tx) => {
		const workspace = await lockWorkspace(
			tx,
			(await readWorkspaceByKey(tx, workspaceKey)).id,
			'update'
		);
		const existing = await readDraft(tx, workspace.id);

		if (existing !== null) {
			throw new ConflictError(
				'У пространства уже есть черновик изменений: доведите его до применения или отмените'
			);
		}

		const active = await readActiveRevision(tx, workspace);

		if (active === null) {
			throw new ConflictError(
				`Для пространства «${workspace.name}» ещё нет действующего процесса: сначала заведите его стадии набором данных`
			);
		}

		const [created] = await tx
			.insert(processRevisions)
			.values({
				groupId: workspace.id,
				version: await nextVersion(tx, workspace.id),
				name: active.name,
				note: active.note
			})
			.returning({ id: processRevisions.id });

		// Правила переноса не копируются: они принадлежат той редакции, в которой
		// ключ исчез, и в новом черновике описывали бы перенос, которого не будет.
		await writeRevisionContent(tx, created.id, {
			...processDefinition(active),
			migrationRules: []
		});

		await recordAuditEvent(
			ctx,
			{
				type: 'stages.draft_created',
				outcome: 'success',
				subject: { type: 'process_group', id: workspace.id },
				details: { workspaceKey: workspace.key, revisionId: created.id }
			},
			tx
		);

		return readRevision(tx, created.id);
	});
}

/**
 * Правка черновика: стадии, переходы и правила переноса переписываются целиком.
 *
 * Под той же блокировкой пространства, что и публикация: иначе два открытых
 * редактора пишут в одну редакцию, а публикация видит наполовину чужой
 * черновик. Блокировка держится на время сохранения формы, а не на время
 * редактирования.
 */
export async function updateDraft(
	ctx: ActorContext,
	workspaceKey: string,
	input: ProcessDefinitionInput
): Promise<ProcessRevisionView> {
	await requirePermission(ctx, 'stages.configure', { type: 'stages.draft_updated' });

	const parsed = processDefinitionSchema.safeParse(input);

	if (!parsed.success) {
		throw new ValidationError(
			'Черновик процесса не прошёл проверку',
			parsed.error.issues.map((issue) => issue.message)
		);
	}

	const definition = parsed.data;

	return withTransaction(ctx, async (tx) => {
		const workspace = await lockWorkspace(
			tx,
			(await readWorkspaceByKey(tx, workspaceKey)).id,
			'update'
		);
		const draft = await readDraft(tx, workspace.id);

		if (draft === null) {
			throw new NotFoundError('У пространства нет черновика изменений');
		}

		const active = await readActiveRevision(tx, workspace);

		await tx.delete(stageTransitions).where(eq(stageTransitions.revisionId, draft.id));
		await tx.delete(stageMigrationRules).where(eq(stageMigrationRules.revisionId, draft.id));
		await tx.delete(stages).where(eq(stages.revisionId, draft.id));

		await tx
			.update(processRevisions)
			.set({ name: definition.name, note: definition.note, updatedAt: new Date() })
			.where(eq(processRevisions.id, draft.id));

		await writeRevisionContent(tx, draft.id, withDefaultRules(definition, active));

		await recordAuditEvent(
			ctx,
			{
				type: 'stages.draft_updated',
				outcome: 'success',
				subject: { type: 'process_group', id: workspace.id },
				details: {
					workspaceKey: workspace.key,
					revisionId: draft.id,
					stageCount: definition.stages.length,
					transitionCount: definition.transitions.length
				}
			},
			tx
		);

		return readRevision(tx, draft.id);
	});
}

/**
 * Дополняет черновик правилами переноса по умолчанию: на каждую исчезнувшую
 * стадию должно быть сказано, куда девать тех, кто на ней стоял. Явное правило
 * администратора сильнее — оно уже в описании и не переписывается.
 */
export function withDefaultRules(
	definition: ProcessDefinitionInput,
	active: ProcessRevisionView | null
): ProcessDefinitionInput {
	const activeOrderedKeys = orderedKeys(active);
	const surviving = new Set(definition.stages.map((stage) => stage.key));
	const byKey = new Map(definition.migrationRules.map((rule) => [rule.removedStageKey, rule]));

	for (const removedKey of activeOrderedKeys) {
		if (surviving.has(removedKey) || byKey.has(removedKey)) {
			continue;
		}

		const target = defaultMigrationTarget(activeOrderedKeys, removedKey, surviving);

		if (target !== null) {
			byKey.set(removedKey, { removedStageKey: removedKey, targetStageKey: target });
		}
	}

	// Правила по стадиям, которых в действующей структуре нет вовсе, отбрасываем:
	// переносить с них некого, а строка в базе обещала бы обратное.
	const activeKeys = new Set(activeOrderedKeys);

	return {
		...definition,
		migrationRules: [...byKey.values()].filter(
			(rule) => activeKeys.has(rule.removedStageKey) && surviving.has(rule.targetStageKey)
		)
	};
}

/** Отмена черновика: редакция и её содержимое удаляются целиком. */
export async function discardDraft(ctx: ActorContext, workspaceKey: string): Promise<void> {
	await requirePermission(ctx, 'stages.configure', { type: 'stages.draft_discarded' });

	await withTransaction(ctx, async (tx) => {
		const workspace = await lockWorkspace(
			tx,
			(await readWorkspaceByKey(tx, workspaceKey)).id,
			'update'
		);
		const draft = await readDraft(tx, workspace.id);

		if (draft === null) {
			throw new NotFoundError('У пространства нет черновика изменений');
		}

		// Стадии, переходы и правила уходят каскадом: черновик — это редакция
		// целиком, и половина отменённого описания ничего не описывает.
		await tx.delete(processRevisions).where(eq(processRevisions.id, draft.id));

		await recordAuditEvent(
			ctx,
			{
				type: 'stages.draft_discarded',
				outcome: 'success',
				subject: { type: 'process_group', id: workspace.id },
				details: { workspaceKey: workspace.key, revisionId: draft.id }
			},
			tx
		);
	});
}

/* ------------------------------------------------------------------------- *
 * Предпросмотр и публикация.
 * ------------------------------------------------------------------------- */

/**
 * Предпросмотр применения черновика.
 *
 * Считается без блокировок и справочен: пока администратор читает таблицу, КАМы
 * работают, и расхождение чисел применение не отменяет — иначе его нельзя было
 * бы завершить в рабочий день. Фактические числа считает транзакция публикации,
 * и в журнал попадают они.
 */
export async function previewPublication(
	ctx: ActorContext,
	workspaceKey: string
): Promise<ProcessPreview> {
	await requirePermission(ctx, 'stages.configure', { type: 'stages.process_viewed' });

	const db = getDb();
	const workspace = await readWorkspaceByKey(db, workspaceKey);
	const draft = await readDraft(db, workspace.id);

	if (draft === null) {
		throw new NotFoundError('У пространства нет черновика изменений');
	}

	const [active, openByKey, archivedKeys] = await Promise.all([
		readActiveRevision(db, workspace),
		countOpenByStageKey(db, workspace.id),
		readArchivedKeys(db, workspace.id)
	]);

	const issues = validateProcessDraft(toDraftShape(draft), {
		archivedKeys: keysOutsideDraft(archivedKeys, draft),
		activeOrderedKeys: orderedKeys(active),
		openByKey
	});

	return buildPreview({
		// Поле предпросмотра пока зовётся `groupId`: оно переедет на процесс тем
		// же шагом, что и цепочка редакций.
		groupId: workspace.id,
		matches: matchStages(active?.stages ?? [], draft.stages),
		openByKey,
		migrationRules: draft.migrationRules,
		nameByKey: new Map(draft.stages.map((stage) => [stage.key, stage.name])),
		issues
	});
}

/** Чем закончилась публикация: числа, которые уходят в журнал и на экран. */
export type PublicationResult = {
	workspaceId: string;
	workspaceKey: string;
	version: number;
	/** Записей, перепривязанных к стадии с тем же ключом. */
	reboundCount: number;
	/** Взаимодействий, переехавших на другую стадию по правилу переноса. */
	migratedCount: number;
	/** Ключей, снятых этой публикацией и ставших архивными. */
	archivedKeyCount: number;
};

/**
 * Применение черновика ко всем.
 *
 * Единственная операция, которая меняет действующий процесс, и она же переносит
 * все незавершённые взаимодействия пространства на новую структуру. Порядок
 * шагов фиксирован и объяснён по месту.
 */
export async function publishProcess(
	ctx: ActorContext,
	workspaceKey: string
): Promise<PublicationResult> {
	await requirePermission(ctx, 'stages.configure', { type: 'stages.process_published' });

	const result = await withTransaction(ctx, async (tx) => {
		// 1. Блокировка пространства: две одновременные публикации выстраиваются в
		// очередь, а создание взаимодействия ждёт своей разделяемой блокировки.
		const workspace = await lockWorkspace(
			tx,
			(await readWorkspaceByKey(tx, workspaceKey)).id,
			'update'
		);

		// 2. Перечитать черновик под блокировкой и проверить его целиком.
		const draft = await readDraft(tx, workspace.id);

		if (draft === null) {
			throw new NotFoundError('У пространства нет черновика изменений');
		}

		const active = await readActiveRevision(tx, workspace);
		const openByKey = await countOpenByStageKey(tx, workspace.id);
		const archivedKeys = await readArchivedKeys(tx, workspace.id);

		const issues = validateProcessDraft(toDraftShape(draft), {
			archivedKeys: keysOutsideDraft(archivedKeys, draft),
			activeOrderedKeys: orderedKeys(active),
			openByKey
		});

		if (issues.length > 0) {
			throw new ValidationError('Черновик нельзя применить ко всем', issues);
		}

		// 3. Блокировка незавершённых взаимодействий пространства по возрастанию
		// идентификатора: фиксированный порядок исключает взаимный замок.
		const locked = await tx
			.select({ id: interactions.id, ownerUserId: interactions.ownerUserId })
			.from(interactions)
			.where(and(eq(interactions.workspaceId, workspace.id), eq(interactions.status, 'active')))
			.orderBy(asc(interactions.id))
			.for('update');

		// 4. Момент операции — после **всех** ожиданий, а не только после
		// блокировки пространства. `now()` в PostgreSQL это начало транзакции, а
		// публикация ждёт дважды: строку пространства и каждую строку
		// взаимодействия.
		// Момент, снятый до шага 3, оказался бы раньше входа на стадию у того,
		// кто перешёл, пока публикация стояла в очереди за его строкой: `left_at`
		// закрываемой записи вышел бы раньше её `entered_at`, и база отказала бы
		// проверкой `stage_entries_left_after_entered` — сырой ошибкой драйвера
		// вместо ответа по существу.
		const [moment] = (await tx.execute(sql`select clock_timestamp() as at`)) as unknown as {
			at: Date | string;
		}[];
		// `execute` отдаёт значение так, как его прислал драйвер: обёртка нужна,
		// потому что дальше момент уходит в колонки `timestamptz`.
		const at = new Date(moment.at);

		// 5–6. Перепривязка открытых записей и переезд по правилам переноса.
		const moved = await migrateEntries(tx, {
			interactionIds: locked.map((row) => row.id),
			draft,
			rules: draft.migrationRules,
			at
		});

		// 7. Черновик становится действующей редакцией.
		await tx
			.update(processRevisions)
			.set({ publishedAt: at, updatedAt: at })
			.where(eq(processRevisions.id, draft.id));

		await tx
			.update(workspaces)
			.set({ activeRevisionId: draft.id, updatedAt: at })
			.where(eq(workspaces.id, workspace.id));

		const archivedKeyCount = await syncStageKeys(tx, workspace.id, draft, at);

		// 8. События журнала с фактическими числами: предпросмотр справочен,
		// а отвечать на вопрос «что произошло» обязаны эти строки.
		await recordAuditEvent(
			ctx,
			{
				type: 'stages.process_published',
				outcome: 'success',
				subject: { type: 'process_group', id: workspace.id },
				details: {
					workspaceKey: workspace.key,
					revisionId: draft.id,
					versionCount: draft.version,
					stageCount: draft.stages.length,
					transitionCount: draft.transitions.length,
					archivedKeyCount
				}
			},
			tx
		);

		await recordAuditEvent(
			ctx,
			{
				type: 'stages.process_migrated',
				outcome: 'success',
				subject: { type: 'process_group', id: workspace.id },
				details: {
					workspaceKey: workspace.key,
					revisionId: draft.id,
					reboundCount: moved.reboundCount,
					migratedCount: moved.migrated.length
				}
			},
			tx
		);

		// Отдельная строка на каждое переехавшее взаимодействие: на вопрос
		// «почему моя запись стоит не там, где вчера» журнал обязан отвечать по
		// самой записи, а не только по процессу.
		for (const move of moved.migrated) {
			await recordAuditEvent(
				ctx,
				{
					type: 'interactions.stage_migrated',
					outcome: 'success',
					subject: { type: 'interaction', id: move.interactionId },
					details: {
						fromStageKey: move.fromStageKey,
						toStageKey: move.toStageKey,
						stageId: move.toStageId,
						stageEntryId: move.stageEntryId,
						versionCount: draft.version
					}
				},
				tx
			);

			// Запись взаимодействия сдвинута административно, и заявитель видит
			// это на сайте: `updated_at` двигается, а снимок статуса уходит в
			// очередь той же транзакцией. `last_activity_at` не трогаем — работы
			// по взаимодействию никто не вёл, и подсказка «запись протухла»
			// обязана считаться от последнего живого действия.
			await tx
				.update(interactions)
				.set({ updatedAt: at })
				.where(eq(interactions.id, move.interactionId));

			await enqueueApplicationStatus(tx, move.interactionId);
		}

		return {
			workspaceId: workspace.id,
			workspaceKey: workspace.key,
			version: draft.version,
			reboundCount: moved.reboundCount,
			migratedCount: moved.migrated.length,
			archivedKeyCount
		};
	});

	// Действующая редакция сменилась: собранную раньше структуру больше не
	// показывать. После фиксации, а не внутри: до неё показывать ещё нечего.
	await invalidateProcessRevisions();

	return result;
}

/** Одно переехавшее взаимодействие: что попадёт в журнал отдельной строкой. */
type MigratedInteraction = {
	interactionId: string;
	fromStageKey: string;
	toStageKey: string;
	toStageId: string;
	stageEntryId: string;
};

/**
 * Отметки чек-листа, которые переезжают вместе с записью на другую стадию.
 *
 * Переезжает пункт, совпавший **и ключом, и подписью**. Ключи чек-листа
 * уникальны внутри стадии, а не внутри процесса: `papers` на «Документах» и
 * `papers` на «Проверке» — два разных требования, и совпадение ключа при
 * переезде случайно. Отметка описывает сделанную работу, и переносить её на
 * требование с другой формулировкой значит засчитать невыполненное: шаг вперёд
 * с целевой стадии прошёл бы без единого действия.
 *
 * Совпали ключ и подпись — работа та же, и отметка едет: иначе переезд стоил бы
 * исполнителю повторного прохода по тем же пунктам. Отметки по пунктам, которых
 * на целевой стадии нет вовсе, не переезжают: читать их некому, а в записи они
 * выглядели бы выполненной работой.
 */
function keptChecklistMarks(
	before: StageSnapshot['checklist'],
	after: StageSnapshot['checklist'],
	marks: Record<string, boolean>
): Record<string, boolean> {
	const labelByKey = new Map(before.map((item) => [item.key, item.label]));
	const kept: Record<string, boolean> = {};

	for (const item of after) {
		const mark = marks[item.key];

		if (mark !== undefined && labelByKey.get(item.key) === item.label) {
			kept[item.key] = mark;
		}
	}

	return kept;
}

/**
 * Перенос открытых записей на новую структуру.
 *
 * Перепривязываются **только открытые** записи: закрытые остаются на стадиях
 * своих редакций — там, где их прошли, — и их снимки не трогает никто. Иначе
 * каждая публикация переписывала бы всю историю пространства одной длинной
 * транзакцией под блокировкой, двигая `updated_at` у записей, в которых ничего
 * не произошло.
 */
export async function migrateEntries(
	tx: Tx,
	input: {
		interactionIds: readonly string[];
		draft: ProcessRevisionView;
		rules: readonly StageMigrationRuleView[];
		at: Date;
	}
): Promise<{ reboundCount: number; migrated: MigratedInteraction[] }> {
	if (input.interactionIds.length === 0) {
		return { reboundCount: 0, migrated: [] };
	}

	const open = await tx
		.select({
			entryId: stageEntries.id,
			interactionId: stageEntries.interactionId,
			responsibleUserId: stageEntries.responsibleUserId,
			waitingPartyId: stageEntries.waitingPartyId,
			checklistState: stageEntries.checklistState,
			stageSnapshot: stageEntries.stageSnapshot,
			stageKey: stages.key
		})
		.from(stageEntries)
		.innerJoin(stages, eq(stages.id, stageEntries.stageId))
		.where(
			and(
				inArray(stageEntries.interactionId, [...input.interactionIds]),
				isNull(stageEntries.leftAt)
			)
		)
		.orderBy(asc(stageEntries.interactionId));

	const draftByKey = new Map(input.draft.stages.map((stage) => [stage.key, stage]));
	const ruleByKey = new Map(input.rules.map((rule) => [rule.removedStageKey, rule]));
	const migrated: MigratedInteraction[] = [];
	let reboundCount = 0;

	for (const entry of open) {
		const target = draftByKey.get(entry.stageKey);

		if (target !== undefined) {
			// Ключ сохранился: запись остаётся той же, меняются стадия и снимок.
			// Снимок открытой записи пересобирается, потому что изменение процесса
			// обязано применяться ко всем, а не только к тем, кто начнёт завтра.
			await tx
				.update(stageEntries)
				.set({
					stageId: target.id,
					stageSnapshot: stageSnapshot(target),
					// Требование отметки по документу могли включить этой же
					// публикацией, а документ дела давно отмечен: снимок отметки
					// подтягивается сразу, иначе карточка объявила бы стадию
					// неисполненной, хотя движок отпустил бы её вперёд.
					...(await documentMarkPatch(tx, entry.interactionId, target.requiresDocumentMark)),
					updatedAt: input.at
				})
				.where(eq(stageEntries.id, entry.entryId));

			reboundCount += 1;
			continue;
		}

		const rule = ruleByKey.get(entry.stageKey);
		const destination = rule === undefined ? undefined : draftByKey.get(rule.targetStageKey);

		if (destination === undefined) {
			// Проверка черновика это уже исключила; сюда можно попасть только на
			// испорченных данных, и тогда отказ лучше записи в никуда.
			throw new ValidationError('Черновик не говорит, куда перенести записи стадии', [
				`Стадия «${entry.stageKey}» исчезла, а правила переноса для неё нет`
			]);
		}

		// Переезд оформляется двумя записями, а не правкой одной: иначе срез на
		// прошлую дату показал бы, что взаимодействие «всегда» стояло на целевой
		// стадии. Часы новой стадии идут с момента переезда.
		await tx
			.update(stageEntries)
			.set({
				leftAt: input.at,
				outcome: 'migrated',
				migratedAt: input.at,
				updatedAt: input.at
			})
			.where(eq(stageEntries.id, entry.entryId));

		const [opened] = await tx
			.insert(stageEntries)
			.values({
				interactionId: entry.interactionId,
				stageId: destination.id,
				stageSnapshot: stageSnapshot(destination),
				...(await documentMarkPatch(tx, entry.interactionId, destination.requiresDocumentMark)),
				enteredAt: input.at,
				responsibleUserId: entry.responsibleUserId,
				waitingPartyId: entry.waitingPartyId,
				// Отметки переезжают только по пунктам, которые на целевой стадии
				// означают ту же работу (`keptChecklistMarks`).
				checklistState: keptChecklistMarks(
					entry.stageSnapshot.checklist,
					destination.checklist,
					entry.checklistState
				),
				migratedAt: input.at,
				migratedFromStageKey: entry.stageKey
			})
			.returning({ id: stageEntries.id });

		// Пауза переезжает вместе с записью. Закрыть её и не открыть заново
		// значило бы, что часы стадии пошли из-за правки процесса: ждать сторону
		// взаимодействие не перестало, и решение об этом принимает исполнитель, а
		// не администратор. Оставить открытой на закрытой записи тоже нельзя — в
		// истории это читается как «ждать не перестали никогда». Обе строки
		// получают момент публикации: между ними нет ни дыры, ни нахлёста.
		const [paused] = await tx
			.update(stagePauses)
			.set({ endedAt: input.at, updatedAt: input.at })
			.where(and(eq(stagePauses.stageEntryId, entry.entryId), isNull(stagePauses.endedAt)))
			.returning({
				reason: stagePauses.reason,
				waitingPartyId: stagePauses.waitingPartyId,
				nextAction: stagePauses.nextAction,
				note: stagePauses.note
			});

		if (paused !== undefined) {
			await tx.insert(stagePauses).values({
				stageEntryId: opened.id,
				reason: paused.reason,
				waitingPartyId: paused.waitingPartyId,
				nextAction: paused.nextAction,
				note: paused.note,
				startedAt: input.at
			});
		}

		migrated.push({
			interactionId: entry.interactionId,
			fromStageKey: entry.stageKey,
			toStageKey: destination.key,
			toStageId: destination.id,
			stageEntryId: opened.id
		});
	}

	return { reboundCount, migrated };
}

/**
 * Реестр ключей процесса пространства: новые ключи заводятся, исчезнувшие
 * помечаются архивными. Строка не удаляется никогда — ключ, который когда-либо
 * здесь был, остаётся занятым, иначе под именем `signing` однажды появилась бы
 * стадия с другим смыслом. Колонка реестра пока зовётся `group_id` и указывает
 * на пространство: на процесс она переедет вместе с редакциями.
 */
export async function syncStageKeys(
	tx: Tx,
	workspaceId: string,
	revision: ProcessRevisionView,
	at: Date
): Promise<number> {
	const keys = revision.stages.map((stage) => stage.key);

	if (keys.length > 0) {
		await tx
			.insert(processStageKeys)
			.values(keys.map((key) => ({ groupId: workspaceId, key, firstSeenAt: at })))
			.onConflictDoNothing();

		// Ключ вернулся в процесс до того, как его архив кого-нибудь смутил:
		// снимаем отметку, иначе редактор откажет в стадии, которая уже стоит.
		await tx
			.update(processStageKeys)
			.set({ archivedAt: null })
			.where(and(eq(processStageKeys.groupId, workspaceId), inArray(processStageKeys.key, keys)));
	}

	const archived = await tx
		.update(processStageKeys)
		.set({ archivedAt: at })
		.where(
			and(
				eq(processStageKeys.groupId, workspaceId),
				isNull(processStageKeys.archivedAt),
				keys.length === 0 ? sql`true` : notInArray(processStageKeys.key, keys)
			)
		)
		.returning({ key: processStageKeys.key });

	return archived.length;
}

/**
 * Процесс пространства, с которым приезжает стенд. Идемпотентно: если у
 * пространства уже есть действующая редакция, возвращается её идентификатор и
 * ничего не пишется. Зовут сиды и тесты, поэтому функция принимает транзакцию
 * вызывающего и не проверяет прав — решение принял код, который её позвал.
 */
export async function ensureProcess(
	tx: Tx,
	workspaceKey: string,
	definition: ProcessDefinitionInput
): Promise<string> {
	const workspace = await readWorkspaceByKey(tx, workspaceKey);

	if (workspace.activeRevisionId !== null) {
		return workspace.activeRevisionId;
	}

	const parsed = processDefinitionSchema.parse(definition);
	const at = new Date();

	const [revision] = await tx
		.insert(processRevisions)
		.values({
			groupId: workspace.id,
			version: await nextVersion(tx, workspace.id),
			name: parsed.name,
			note: parsed.note,
			publishedAt: at
		})
		.returning({ id: processRevisions.id });

	await writeRevisionContent(tx, revision.id, parsed);

	await tx
		.update(workspaces)
		.set({ activeRevisionId: revision.id, updatedAt: at })
		.where(eq(workspaces.id, workspace.id));

	await syncStageKeys(tx, workspace.id, await readRevision(tx, revision.id), at);

	return revision.id;
}
