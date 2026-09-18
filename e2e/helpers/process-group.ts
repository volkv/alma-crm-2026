import type postgres from 'postgres';
import type { DocumentStatusFact } from '$lib/contracts/documents';
import type {
	ChecklistItem,
	StageCategory,
	StageTransitionKind
} from '$lib/contracts/interactions';

/**
 * Замок, под которым прогон заводит группы процесса. Один на все файлы, и это
 * главное в нём.
 *
 * Место группы в списке уникально (`process_groups_position_key`), а свободное
 * считается от занятых. Два файла, считающие его одновременно, получают одно и
 * то же число, и второй падает на вставке; фиксированные номера сталкиваются
 * ещё проще — файл, заводящий группу заново, освобождает своё место, и сосед
 * успевает его занять. Замок на файл от этого не спасает: сталкиваются как раз
 * разные файлы.
 *
 * Число произвольное, но общее: `pg_advisory_xact_lock` различает замки только
 * по нему.
 */
const PROCESS_GROUP_LOCK = 918273640;

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

export type SeedProcessGroupOptions = {
	key: string;
	/**
	 * Название группы, если её заводит прогон. `null` — группу кладёт миграция
	 * (`b2b`, `b2c`): за такой закреплены виды контрагента, и завести её своими
	 * руками нельзя — форма создания взаимодействия группу без вида не нашла бы.
	 * Поэтому отсутствие такой группы это ошибка стенда, а не повод её создать.
	 */
	name: string | null;
	description?: string;
	/** Название первой редакции; на экране процесса оно и видно. */
	revisionName: string;
	revisionNote?: string | null;
	stages: readonly SeedStage[];
	transitions?: readonly SeedTransition[];
	/**
	 * Чистый лист вместо идемпотентности: группа сносится вместе с редакциями,
	 * реестром ключей и своими взаимодействиями и заводится заново.
	 *
	 * Нужен там, где проверка меняет процесс: изменение необратимо — удалённый
	 * ключ стадии остаётся занятым за группой навсегда, — и второй прогон
	 * начинался бы уже с другого состояния.
	 */
	reset?: {
		/**
		 * Шаблон `like` для названий записей прошлого прогона. Они сносятся помимо
		 * группы: взаимодействие могло переехать в другую, а его записи стадий
		 * продолжали бы держать стадии этой, и группа не удалилась бы.
		 */
		interactionTitleLike: string;
	};
};

export type SeededProcessGroup = {
	groupId: string;
	/** Действующая редакция группы: заведённая здесь или уже стоявшая. */
	revisionId: string;
	/** Идентификаторы стадий действующей редакции по ключу стадии. */
	stageIds: Map<string, string>;
};

/**
 * Группа процесса прогона с действующей редакцией и стадиями — идемпотентно и
 * под общим замком.
 *
 * Идемпотентность здесь означает «повторный вызов оставляет то же состояние»:
 * группа заводится, если её нет, редакция — если у группы нет действующей.
 * Файл, которому нужен чистый лист, просит `reset`.
 *
 * Вызывается внутри транзакции самого файла: заведённые записи ссылаются на
 * группу, и разрывать это на две транзакции значило бы пускать соседей в
 * промежуток. Замок берётся первым же запросом, поэтому вызов стоит в начале
 * транзакции — всё, что файл заводит дальше, оказывается под ним же.
 */
export async function seedProcessGroup(
	tx: postgres.TransactionSql,
	options: SeedProcessGroupOptions
): Promise<SeededProcessGroup> {
	await tx`select pg_advisory_xact_lock(${PROCESS_GROUP_LOCK})`;

	if (options.reset !== undefined) {
		await dropGroup(tx, options.key, options.reset.interactionTitleLike);
	}

	if (options.name !== null) {
		// Место считается от занятых, а не берётся числом: группы заводят и
		// миграции, и соседние файлы прогона, и любое число рано или поздно
		// совпадёт с чужим. Под замком счёт верен: следующий желающий увидит уже
		// записанную строку.
		await tx`
			insert into process_groups (key, name, description, position)
			select
				${options.key},
				${options.name},
				${options.description ?? null},
				coalesce(max(position), 0) + 1
			from process_groups
			on conflict (key) do nothing
		`;
	}

	const [group] = await tx<{ id: string; active_revision_id: string | null }[]>`
		select id, active_revision_id from process_groups where key = ${options.key}
	`;

	if (group === undefined) {
		throw new Error(`Группа процесса «${options.key}» не заведена миграцией`);
	}

	const revisionId = group.active_revision_id ?? (await publishRevision(tx, group.id, options));

	const stageRows = await tx<{ id: string; key: string }[]>`
		select id, key from stages where revision_id = ${revisionId}
	`;

	return {
		groupId: group.id,
		revisionId,
		stageIds: new Map(stageRows.map((row) => [row.key, row.id]))
	};
}

/** Группа прошлого прогона со всем, что за ней держится. */
async function dropGroup(
	tx: postgres.TransactionSql,
	key: string,
	interactionTitleLike: string
): Promise<void> {
	await tx`delete from interactions where title like ${interactionTitleLike}`;

	const [group] = await tx<{ id: string }[]>`
		select id from process_groups where key = ${key}
	`;

	if (group === undefined) {
		return;
	}

	await tx`delete from interactions where process_group_id = ${group.id}`;
	await tx`update process_groups set active_revision_id = null where id = ${group.id}`;
	await tx`delete from process_revisions where group_id = ${group.id}`;
	await tx`delete from process_stage_keys where group_id = ${group.id}`;
	await tx`delete from process_groups where id = ${group.id}`;
}

/** Первая редакция группы: стадии, переходы, реестр ключей и переключение. */
async function publishRevision(
	tx: postgres.TransactionSql,
	groupId: string,
	options: SeedProcessGroupOptions
): Promise<string> {
	const [revision] = await tx<{ id: string }[]>`
		insert into process_revisions ${tx({
			group_id: groupId,
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
			insert into process_stage_keys ${tx({ group_id: groupId, key: stage.key })}
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

	await tx`update process_groups set active_revision_id = ${revision.id} where id = ${groupId}`;

	return revision.id;
}
