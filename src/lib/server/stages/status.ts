/**
 * Где взаимодействие стоит и сколько у него осталось времени.
 *
 * Часы стадии считает база — представление `stage_entry_status`: окно записи,
 * вычтенные паузы, срок и просрочка. Здесь эти числа только собираются вместе с
 * записями стадий, паузами и помехами в состояние, которое показывает карточка.
 *
 * Протухание считается отдельно и не здесь: оно про тишину вокруг записи
 * (`interactions.last_activity_at`), а не про часы на стадии.
 */
import { and, desc, eq, inArray, type SQL } from 'drizzle-orm';
import type {
	BlockerView,
	ProcessRevisionView,
	StageEntryView,
	StagePauseView,
	StageProgressItem,
	StageCategory,
	StageView,
	InteractionStatusView
} from '$lib/contracts/interactions';
import type { ActorContext } from '../actor';
import { getDb } from '../db';
import {
	blockers,
	documents,
	processStageKeys,
	stageEntries,
	stageEntryDocuments,
	stageEntryStatus,
	stagePauses,
	users
} from '../db/schema';
import type { Tx } from '../db/transaction';
import { requirePermission } from '../rbac';
import { assertInteractionVisible } from '../interactions/access';
import { checkFacts, frozenFacts, type EntryFacts } from './facts';
import { requireActiveRevisionForWorkspace } from './process';

type Executor = Tx | ReturnType<typeof getDb>;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Строка записи стадии вместе со сроком из представления. */
const entryColumns = {
	entry: stageEntries,
	status: {
		dueAt: stageEntryStatus.dueAt,
		pausedSeconds: stageEntryStatus.pausedSeconds,
		activeSeconds: stageEntryStatus.activeSeconds,
		remainingSeconds: stageEntryStatus.remainingSeconds,
		overdueSeconds: stageEntryStatus.overdueSeconds,
		isOverdue: stageEntryStatus.isOverdue,
		isPaused: stageEntryStatus.isPaused
	},
	responsibleName: users.fullName
};

type EntryRow = {
	entry: typeof stageEntries.$inferSelect;
	status: {
		dueAt: Date;
		pausedSeconds: number;
		activeSeconds: number;
		remainingSeconds: number;
		overdueSeconds: number;
		isOverdue: boolean;
		isPaused: boolean;
	};
	responsibleName: string | null;
};

function toPauseView(row: typeof stagePauses.$inferSelect): StagePauseView {
	return {
		id: row.id,
		reason: row.reason,
		waitingPartyId: row.waitingPartyId,
		nextAction: row.nextAction,
		note: row.note,
		startedAt: row.startedAt,
		endedAt: row.endedAt
	};
}

function toEntryView(
	row: EntryRow,
	pauses: StagePauseView[],
	documents: StageEntryView['documents'],
	facts: EntryFacts
): StageEntryView {
	return {
		id: row.entry.id,
		stageId: row.entry.stageId,
		snapshot: row.entry.stageSnapshot,
		enteredAt: row.entry.enteredAt,
		leftAt: row.entry.leftAt,
		outcome: row.entry.outcome,
		outcomeReason: row.entry.outcomeReason,
		responsibleUserId: row.entry.responsibleUserId,
		responsibleName: row.responsibleName,
		waitingPartyId: row.entry.waitingPartyId,
		resultText: row.entry.resultText,
		confirmation: row.entry.confirmation,
		confirmedAt: row.entry.confirmedAt,
		lmsEvidence: row.entry.lmsEvidence,
		documentMarkEvidence: row.entry.documentMarkEvidence,
		checklistState: row.entry.checklistState,
		facts,
		documents,
		dueAt: row.status.dueAt,
		pausedSeconds: row.status.pausedSeconds,
		activeSeconds: row.status.activeSeconds,
		remainingSeconds: row.status.remainingSeconds,
		overdueSeconds: row.status.overdueSeconds,
		isOverdue: row.status.isOverdue,
		isPaused: row.status.isPaused,
		pauses
	};
}

function toBlockerView(
	row: typeof blockers.$inferSelect & { raisedByName: string | null }
): BlockerView {
	return {
		id: row.id,
		interactionId: row.interactionId,
		stageEntryId: row.stageEntryId,
		reasonCode: row.reasonCode,
		description: row.description,
		blocksTransition: row.blocksTransition,
		raisedBy: row.raisedBy,
		raisedByName: row.raisedByName ?? 'Неизвестный пользователь',
		assigneeUserId: row.assigneeUserId,
		raisedAt: row.raisedAt,
		resolvedAt: row.resolvedAt,
		resolvedBy: row.resolvedBy,
		resolution: row.resolution
	};
}

/**
 * Записи стадий взаимодействия вместе со сроками, паузами и вложениями, новые
 * сверху. Файл виден на той стадии, где его приложили, а не общим списком по
 * взаимодействию: иначе «чем подтверждена передача материалов» превращается в
 * перебор всех файлов карточки.
 */
async function readEntries(
	executor: Executor,
	condition: SQL
): Promise<{
	rows: EntryRow[];
	pauses: Map<string, StagePauseView[]>;
	attachments: Map<string, StageEntryView['documents']>;
}> {
	const rows = (await executor
		.select(entryColumns)
		.from(stageEntries)
		.innerJoin(stageEntryStatus, eq(stageEntryStatus.stageEntryId, stageEntries.id))
		.leftJoin(users, eq(users.id, stageEntries.responsibleUserId))
		.where(condition)
		.orderBy(desc(stageEntries.enteredAt))) as EntryRow[];

	const pauses = new Map<string, StagePauseView[]>();
	const attachments = new Map<string, StageEntryView['documents']>();

	if (rows.length > 0) {
		const entryIds = rows.map((row) => row.entry.id);

		const [pauseRows, attachmentRows] = await Promise.all([
			executor
				.select()
				.from(stagePauses)
				.where(inArray(stagePauses.stageEntryId, entryIds))
				.orderBy(desc(stagePauses.startedAt)),
			executor
				.select({
					stageEntryId: stageEntryDocuments.stageEntryId,
					id: documents.id,
					title: documents.title,
					mime: documents.mime,
					sizeBytes: documents.sizeBytes
				})
				.from(stageEntryDocuments)
				.innerJoin(documents, eq(documents.id, stageEntryDocuments.documentId))
				.where(inArray(stageEntryDocuments.stageEntryId, entryIds))
				.orderBy(desc(stageEntryDocuments.createdAt))
		]);

		for (const pause of pauseRows) {
			const list = pauses.get(pause.stageEntryId) ?? [];
			list.push(toPauseView(pause));
			pauses.set(pause.stageEntryId, list);
		}

		for (const attachment of attachmentRows) {
			const list = attachments.get(attachment.stageEntryId) ?? [];
			list.push({
				id: attachment.id,
				title: attachment.title,
				mime: attachment.mime,
				sizeBytes: attachment.sizeBytes
			});
			attachments.set(attachment.stageEntryId, list);
		}
	}

	return { rows, pauses, attachments };
}

/**
 * Пункты-факты по записям: у открытой — проверка данными дела сейчас, у
 * закрытых — результат, сохранённый при выходе.
 */
async function readFacts(executor: Executor, rows: EntryRow[]): Promise<Map<string, EntryFacts>> {
	const open = rows.filter((row) => row.entry.leftAt === null);
	const checked = await checkFacts(
		executor,
		open.map((row) => ({
			id: row.entry.id,
			interactionId: row.entry.interactionId,
			enteredAt: row.entry.enteredAt,
			resultText: row.entry.resultText,
			checklistState: row.entry.checklistState,
			snapshot: row.entry.stageSnapshot
		}))
	);

	for (const row of rows) {
		if (row.entry.leftAt !== null) {
			checked.set(row.entry.id, frozenFacts(row.entry.stageSnapshot, row.entry.checklistState));
		}
	}

	return checked;
}

/** Запись стадии в объёме, который нужен ленте процесса. */
export type ProgressEntry = {
	stageId: string;
	stageKey: string;
	/** Название и номер стадии из снимка записи — такими её проходили. */
	name: string;
	position: number;
	category: StageCategory;
	enteredAt: Date;
	leftAt: Date | null;
};

/**
 * Лента процесса: каким состоянием показать каждую стадию.
 *
 * Стадии и записи сопоставляются **по ключу**, а не по `stage_id`: строка
 * `stages` живёт внутри редакции и меняется с каждой публикацией, а закрытые
 * записи остаются на стадиях своих редакций. По идентификатору лента карточки
 * после первого же изменения процесса показала бы пустую историю.
 *
 * Стадия, которую перешагнули (записи нет, а дело уже дальше), показывается
 * пропущенной — иначе пропуск был бы виден только в истории. «Дальше» у
 * открытого дела — его текущая стадия, у закрытого — самая дальняя из
 * пройденных: у завершённого дела впереди ничего нет, и стадия, которую
 * вставили в процесс после того, как дело её место миновало, — не «впереди», а
 * «добавлена после прохождения» (`introducedAt` — когда ключ стадии впервые
 * появился в процессе).
 *
 * Пройденная стадия, которую потом убрали из процесса, остаётся в пути дела —
 * названием и номером из снимка записи, отметкой «удалена из процесса», на том
 * месте, где её проходили. Иначе шкала завершённого дела после правки процесса
 * теряла бы часть истории.
 *
 * Стадия дальше текущей, пройденная до возврата, снова впереди: дело вернулось,
 * и идти через неё придётся заново. Отметкой «пройдена» она уводила бы
 * «Дальше» на стадию через одну.
 */
export function buildProgress(
	revisionStages: StageView[],
	entries: readonly ProgressEntry[],
	current: { stageKey: string; dueAt: Date; isOverdue: boolean; isPaused: boolean } | null,
	hasBlockingBlockers: boolean,
	introducedAt: ReadonlyMap<string, Date>
): StageProgressItem[] {
	const visited = new Set(entries.map((entry) => entry.stageKey));
	const positionByKey = new Map(revisionStages.map((stage) => [stage.key, stage.position]));
	const currentPosition =
		current === null
			? Math.max(
					0,
					...revisionStages.filter((stage) => visited.has(stage.key)).map((stage) => stage.position)
				)
			: (positionByKey.get(current.stageKey) ?? 0);

	/** Когда дело впервые ушло дальше этой позиции: после этого вставленная стадия — уже позади. */
	function passedBeyond(position: number): Date | null {
		const later = entries.filter((entry) => (positionByKey.get(entry.stageKey) ?? 0) > position);

		return later.length === 0
			? null
			: new Date(Math.min(...later.map((entry) => entry.enteredAt.getTime())));
	}

	const items: StageProgressItem[] = revisionStages.map((stage) => {
		const base = {
			stageId: stage.id,
			key: stage.key,
			name: stage.name,
			position: stage.position,
			category: stage.category,
			checklist: stage.checklist,
			removed: false
		};

		if (current !== null && stage.key === current.stageKey) {
			const state = hasBlockingBlockers
				? 'blocked'
				: current.isPaused
					? 'paused'
					: current.isOverdue
						? 'overdue'
						: 'current';

			return {
				...base,
				state,
				dueAt: current.dueAt,
				note: hasBlockingBlockers ? 'есть помеха' : current.isPaused ? 'часы стоят' : null
			};
		}

		if (visited.has(stage.key) && current !== null && stage.position > currentPosition) {
			return { ...base, state: 'pending' as const, dueAt: null, note: 'пройдена до возврата' };
		}

		if (visited.has(stage.key)) {
			return { ...base, state: 'done' as const, dueAt: null, note: null };
		}

		if (stage.position < currentPosition) {
			const introduced = introducedAt.get(stage.key);
			const passed = passedBeyond(stage.position);
			const addedLater = introduced !== undefined && passed !== null && introduced > passed;

			return {
				...base,
				state: 'skipped' as const,
				dueAt: null,
				note: addedLater ? 'добавлена в процесс после прохождения' : 'перешагнули'
			};
		}

		return { ...base, state: 'pending' as const, dueAt: null, note: null };
	});

	return withRemovedStages(items, entries, positionByKey);
}

/**
 * Пройденные стадии, которых в процессе больше нет, — на своих местах пути:
 * сразу за стадией процесса, пройденной перед ними.
 */
function withRemovedStages(
	items: StageProgressItem[],
	entries: readonly ProgressEntry[],
	positionByKey: ReadonlyMap<string, number>
): StageProgressItem[] {
	const chronological = [...entries].sort(
		(left, right) => left.enteredAt.getTime() - right.enteredAt.getTime()
	);
	const placed = new Set<string>();
	const result = [...items];

	for (const [index, entry] of chronological.entries()) {
		if (positionByKey.has(entry.stageKey) || placed.has(entry.stageKey)) {
			continue;
		}

		placed.add(entry.stageKey);

		// Последний проход стадии: её название и номер — такими, как их видели.
		const last = chronological.findLast((candidate) => candidate.stageKey === entry.stageKey);
		const anchor = chronological
			.slice(0, index)
			.findLast((candidate) => positionByKey.has(candidate.stageKey));
		const anchorIndex =
			anchor === undefined ? -1 : result.findIndex((item) => item.key === anchor.stageKey);
		// За стадией-якорем могли уже встать другие удалённые: новая — после них.
		let insertAt = anchorIndex + 1;

		while (insertAt < result.length && result[insertAt].removed) {
			insertAt += 1;
		}

		result.splice(insertAt, 0, {
			stageId: (last ?? entry).stageId,
			key: entry.stageKey,
			name: (last ?? entry).name,
			position: (last ?? entry).position,
			category: (last ?? entry).category,
			checklist: [],
			removed: true,
			state: 'done',
			dueAt: null,
			note: 'удалена из процесса'
		});
	}

	return result;
}

/**
 * Протухание: вокруг записи тихо дольше, чем допускает текущая стадия. Считается
 * по последней активности взаимодействия, а не по часам стадии, — стоять на
 * долгой стадии нормально, молчать неделями нет.
 */
export function isStale(
	snapshot: { staleAfterDays: number | null } | null,
	lastActivityAt: Date,
	now: Date = new Date()
): boolean {
	if (snapshot === null || snapshot.staleAfterDays === null) {
		return false;
	}

	return now.getTime() - lastActivityAt.getTime() > snapshot.staleAfterDays * DAY_MS;
}

/** Помехи взаимодействия, новые сверху: и открытые, и уже снятые. */
async function readBlockers(executor: Executor, interactionId: string): Promise<BlockerView[]> {
	const rows = await executor
		.select({ blocker: blockers, raisedByName: users.fullName })
		.from(blockers)
		.leftJoin(users, eq(users.id, blockers.raisedBy))
		.where(eq(blockers.interactionId, interactionId))
		.orderBy(desc(blockers.raisedAt));

	return rows.map((row) => toBlockerView({ ...row.blocker, raisedByName: row.raisedByName }));
}

/** Запись стадии для ленты процесса — ключом, названием и номером из её снимка. */
function progressEntry(row: EntryRow): ProgressEntry {
	return {
		stageId: row.entry.stageId,
		stageKey: row.entry.stageSnapshot.key,
		name: row.entry.stageSnapshot.name,
		position: row.entry.stageSnapshot.position,
		category: row.entry.stageSnapshot.category,
		enteredAt: row.entry.enteredAt,
		leftAt: row.entry.leftAt
	};
}

/** Когда каждый ключ стадии редакции впервые появился в её процессе. */
export async function readStageIntroductions(
	executor: Executor,
	revision: Pick<ProcessRevisionView, 'workflowId' | 'stages'>
): Promise<Map<string, Date>> {
	if (revision.stages.length === 0) {
		return new Map();
	}

	const rows = await executor
		.select({ key: processStageKeys.key, firstSeenAt: processStageKeys.firstSeenAt })
		.from(processStageKeys)
		.where(
			and(
				eq(processStageKeys.workflowId, revision.workflowId),
				inArray(
					processStageKeys.key,
					revision.stages.map((stage) => stage.key)
				)
			)
		);

	return new Map(rows.map((row) => [row.key, row.firstSeenAt]));
}

/**
 * Состояние взаимодействия целиком: текущая запись стадии, история с паузами,
 * помехи и лента маршрута.
 */
export async function getInteractionStatus(
	ctx: ActorContext,
	interactionId: string
): Promise<InteractionStatusView> {
	requirePermission(ctx, 'interactions.read');

	const interaction = await assertInteractionVisible(ctx, interactionId);
	const db = getDb();

	const [{ rows, pauses, attachments }, revision, blockerList] = await Promise.all([
		readEntries(db, eq(stageEntries.interactionId, interactionId)),
		requireActiveRevisionForWorkspace(db, interaction.workspaceId),
		readBlockers(db, interactionId)
	]);

	const [facts, introduced] = await Promise.all([
		readFacts(db, rows),
		readStageIntroductions(db, revision)
	]);
	const views = rows.map((row) =>
		toEntryView(
			row,
			pauses.get(row.entry.id) ?? [],
			attachments.get(row.entry.id) ?? [],
			facts.get(row.entry.id) ?? {}
		)
	);
	const current = views.find((view) => view.leftAt === null) ?? null;
	const currentRow = rows.find((row) => row.entry.leftAt === null) ?? null;
	const openBlocking = blockerList.filter(
		(blocker) => blocker.resolvedAt === null && blocker.blocksTransition
	);

	return {
		interactionId,
		workspaceId: interaction.workspaceId,
		revision: revision.version,
		current,
		history: views.filter((view) => view.leftAt !== null),
		progress: buildProgress(
			revision.stages,
			rows.map(progressEntry),
			current === null
				? null
				: {
						stageKey: current.snapshot.key,
						dueAt: current.dueAt,
						isOverdue: current.isOverdue,
						isPaused: current.isPaused
					},
			openBlocking.length > 0,
			introduced
		),
		blockers: blockerList,
		isStale: isStale(current?.snapshot ?? null, interaction.lastActivityAt),
		lastActivityAt: interaction.lastActivityAt,
		migratedFrom: migrationNotice(currentRow, rows)
	};
}

/**
 * Уведомление «стадия перенесена при изменении процесса». Рисуется из отметок
 * переезда открытой записи и отдельного состояния не заводит: закрылась запись
 * — уведомления больше нет, потому что дальше человек шёл сам.
 *
 * Прежняя стадия исчезла из процесса — на то её и переносили, — поэтому её
 * название берётся из снимка той записи, которую переезд закрыл: в текущей
 * структуре процесса его уже нет, а ключ стадии человеку ничего не говорит.
 */
function migrationNotice(
	row: EntryRow | null,
	rows: readonly EntryRow[]
): { stageKey: string; stageName: string; at: Date } | null {
	const key = row?.entry.migratedFromStageKey ?? null;
	const at = row?.entry.migratedAt ?? null;

	if (key === null || at === null) {
		return null;
	}

	const left = rows.find(
		(candidate) =>
			candidate.entry.outcome === 'migrated' && candidate.entry.stageSnapshot.key === key
	);

	if (left === undefined) {
		throw new Error(`Запись перенесена со стадии «${key}», а закрытой записи о ней нет`);
	}

	return { stageKey: key, stageName: left.entry.stageSnapshot.name, at };
}
