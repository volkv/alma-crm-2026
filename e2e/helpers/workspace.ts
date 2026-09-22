import type postgres from 'postgres';
import type { DocumentStatusFact } from '$lib/contracts/documents';
import type {
	ChecklistItem,
	StageCategory,
	StageTransitionKind
} from '$lib/contracts/interactions';

/**
 * Замок, под которым прогон заводит пространства. Один на все файлы, и это
 * главное в нём.
 *
 * Место пространства в списке уникально (`workspaces_position_key`), а свободное
 * считается от занятых. Два файла, считающие его одновременно, получают одно и
 * то же число, и второй падает на вставке; фиксированные номера сталкиваются
 * ещё проще — файл, заводящий пространство заново, освобождает своё место, и
 * сосед успевает его занять. Замок на файл от этого не спасает: сталкиваются
 * как раз разные файлы.
 *
 * Число произвольное, но общее: `pg_advisory_xact_lock` различает замки только
 * по нему.
 */
const WORKSPACE_LOCK = 918273640;

/**
 * Стадия редакции прогона. Необязательные признаки совпадают с умолчаниями
 * таблицы `stages`, поэтому в вызове остаётся то, что для проверки важно.
 */
export type SeedStage = {
	key: string;
	name: string;
	category: StageCategory;
	slaDays: number;
	staleAfterDays?: number | null;
	requiresResult?: boolean;
	requiresConfirmation?: boolean;
	requiresLmsData?: boolean;
	requiresDocumentMark?: DocumentStatusFact | null;
	isFinal?: boolean;
	checklist?: readonly ChecklistItem[];
};

export type SeedTransition = {
	fromStageKey: string;
	toStageKey: string;
	kind: StageTransitionKind;
	requiredPermissionKey: string;
	requiresReason?: boolean;
};

export type SeedWorkspaceOptions = {
	key: string;
	/**
	 * Название пространства, если его заводит прогон. Им же называется и процесс:
	 * прогон заводит их парой, с общим ключом.
	 *
	 * `null` — пространство кладёт миграция (`b2b`, `b2c`): за такими закреплены
	 * виды контрагента, и завести их своими руками нельзя — форма создания
	 * взаимодействия пространство без вида не нашла бы. Поэтому отсутствие такого
	 * пространства это ошибка стенда, а не повод его создать.
	 */
	name: string | null;
	description?: string;
	/** Название первой редакции; на экране процесса оно и видно. */
	revisionName: string;
	revisionNote?: string | null;
	stages: readonly SeedStage[];
	transitions?: readonly SeedTransition[];
	/**
	 * Чистый лист вместо идемпотентности: пространство сносится вместе с
	 * процессом, его редакциями, реестром ключей и своими взаимодействиями и
	 * заводится заново.
	 *
	 * Нужен там, где проверка меняет процесс: изменение необратимо — удалённый
	 * ключ стадии остаётся занятым за процессом навсегда, — и второй прогон
	 * начинался бы уже с другого состояния.
	 */
	reset?: {
		/**
		 * Шаблон `like` для названий записей прошлого прогона. Они сносятся помимо
		 * пространства: взаимодействие могло переехать в другое, а его записи
		 * стадий продолжали бы держать стадии этого, и процесс не удалился бы.
		 */
		interactionTitleLike: string;
	};
};

export type SeededWorkspace = {
	workspaceId: string;
	/** Действующая редакция процесса: заведённая здесь или уже стоявшая. */
	revisionId: string;
	/** Идентификаторы стадий действующей редакции по ключу стадии. */
	stageIds: Map<string, string>;
};

/**
 * Пространство прогона с назначенным процессом, его действующей редакцией и
 * стадиями — идемпотентно и под общим замком.
 *
 * Идемпотентность здесь означает «повторный вызов оставляет то же состояние»:
 * пространство и процесс заводятся, если их нет, редакция — если у процесса нет
 * действующей. Файл, которому нужен чистый лист, просит `reset`.
 *
 * Вызывается внутри транзакции самого файла: заведённые записи ссылаются на
 * пространство, и разрывать это на две транзакции значило бы пускать соседей в
 * промежуток. Замок берётся первым же запросом, поэтому вызов стоит в начале
 * транзакции — всё, что файл заводит дальше, оказывается под ним же.
 */
export async function seedWorkspace(
	tx: postgres.TransactionSql,
	options: SeedWorkspaceOptions
): Promise<SeededWorkspace> {
	await tx`select pg_advisory_xact_lock(${WORKSPACE_LOCK})`;

	if (options.reset !== undefined) {
		await dropWorkspace(tx, options.key, options.reset.interactionTitleLike);
	}

	if (options.name !== null) {
		// Процесс заводится первым: пространство на него ссылается, и без него
		// ссылку было бы некуда поставить. Ключ у них общий — тот же, каким
		// сшивала их миграция выделения процесса.
		await tx`
			insert into workflows (key, name, description)
			values (${options.key}, ${options.name}, ${options.description ?? null})
			on conflict (key) do nothing
		`;

		// Место считается от занятых, а не берётся числом: пространства заводят и
		// миграции, и соседние файлы прогона, и любое число рано или поздно
		// совпадёт с чужим. Под замком счёт верен: следующий желающий увидит уже
		// записанную строку.
		await tx`
			insert into workspaces (key, name, description, position, workflow_id)
			select
				${options.key},
				${options.name},
				${options.description ?? null},
				coalesce(max(position), 0) + 1,
				(select id from workflows where key = ${options.key})
			from workspaces
			on conflict (key) do nothing
		`;
	}

	const [workspace] = await tx<{ id: string; workflow_id: string | null }[]>`
		select id, workflow_id from workspaces where key = ${options.key}
	`;

	if (workspace === undefined) {
		throw new Error(`Пространство «${options.key}» не заведено миграцией`);
	}

	if (workspace.workflow_id === null) {
		throw new Error(`Пространству «${options.key}» не назначен процесс`);
	}

	// Действующая редакция — свойство процесса, а не места: один процесс можно
	// назначить нескольким пространствам, и переключать её на каждом из них
	// порознь было бы нечем.
	const [workflow] = await tx<{ active_revision_id: string | null }[]>`
		select active_revision_id from workflows where id = ${workspace.workflow_id}
	`;

	const revisionId =
		workflow?.active_revision_id ?? (await publishRevision(tx, workspace.workflow_id, options));

	const stageRows = await tx<{ id: string; key: string }[]>`
		select id, key from stages where revision_id = ${revisionId}
	`;

	return {
		workspaceId: workspace.id,
		revisionId,
		stageIds: new Map(stageRows.map((row) => [row.key, row.id]))
	};
}

/** Пространство прошлого прогона со всем, что за ним держится. */
async function dropWorkspace(
	tx: postgres.TransactionSql,
	key: string,
	interactionTitleLike: string
): Promise<void> {
	await tx`delete from interactions where title like ${interactionTitleLike}`;

	const [workspace] = await tx<{ id: string }[]>`
		select id from workspaces where key = ${key}
	`;

	if (workspace !== undefined) {
		await tx`delete from interactions where workspace_id = ${workspace.id}`;
		await tx`delete from workspaces where id = ${workspace.id}`;
	}

	// Процесс сносится после места: ссылка `workspaces.workflow_id` запрещает
	// удаление, пока место стоит. Порядок внутри тот же по той же причине —
	// процесс держит свою действующую редакцию, и снять её нужно до того, как
	// редакции удалятся.
	const [workflow] = await tx<{ id: string }[]>`
		select id from workflows where key = ${key}
	`;

	if (workflow === undefined) {
		return;
	}

	await tx`update workflows set active_revision_id = null where id = ${workflow.id}`;
	await tx`delete from process_revisions where workflow_id = ${workflow.id}`;
	await tx`delete from process_stage_keys where workflow_id = ${workflow.id}`;
	await tx`delete from workflows where id = ${workflow.id}`;
}

/** Первая редакция процесса: стадии, переходы, реестр ключей и переключение. */
async function publishRevision(
	tx: postgres.TransactionSql,
	workflowId: string,
	options: SeedWorkspaceOptions
): Promise<string> {
	const [revision] = await tx<{ id: string }[]>`
		insert into process_revisions ${tx({
			workflow_id: workflowId,
			version: 1,
			name: options.revisionName,
			note: options.revisionNote ?? null,
			published_at: new Date()
		})}
		returning id
	`;

	const stageIds = new Map<string, string>();

	for (const [index, stage] of options.stages.entries()) {
		const [row] = await tx<{ id: string }[]>`
			insert into stages ${tx({
				revision_id: revision.id,
				position: index + 1,
				key: stage.key,
				name: stage.name,
				category: stage.category,
				sla_days: stage.slaDays,
				stale_after_days: stage.staleAfterDays ?? null,
				requires_result: stage.requiresResult ?? false,
				requires_confirmation: stage.requiresConfirmation ?? false,
				requires_lms_data: stage.requiresLmsData ?? false,
				requires_document_mark: stage.requiresDocumentMark ?? null,
				is_final: stage.isFinal ?? false,
				// Готовой строкой: массив драйвер положил бы массивом Postgres, а
				// колонка — `jsonb`.
				checklist: JSON.stringify(stage.checklist ?? [])
			})}
			returning id
		`;

		stageIds.set(stage.key, row.id);

		// Реестр ключей заводится вместе с первой редакцией: без него применение
		// изменений посчитало бы все ключи новыми.
		await tx`
			insert into process_stage_keys ${tx({ workflow_id: workflowId, key: stage.key })}
			on conflict do nothing
		`;
	}

	for (const transition of options.transitions ?? []) {
		await tx`
			insert into stage_transitions ${tx({
				revision_id: revision.id,
				from_stage_id: stageIds.get(transition.fromStageKey) ?? null,
				to_stage_id: stageIds.get(transition.toStageKey) ?? null,
				kind: transition.kind,
				required_permission_key: transition.requiredPermissionKey,
				requires_reason: transition.requiresReason ?? false
			})}
		`;
	}

	await tx`update workflows set active_revision_id = ${revision.id} where id = ${workflowId}`;

	return revision.id;
}
