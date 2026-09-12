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
import { desc, eq, inArray, type SQL } from 'drizzle-orm';
import type {
	BlockerView,
	StageEntryView,
	StagePauseView,
	StageProgressItem,
	StageView,
	InteractionStatusView
} from '$lib/contracts/interactions';
import type { ActorContext } from '../actor';
import { getDb } from '../db';
import { blockers, stageEntries, stageEntryStatus, stagePauses, users } from '../db/schema';
import type { Tx } from '../db/transaction';
import { requirePermission } from '../rbac';
import { assertInteractionVisible } from '../interactions/access';
import { readRoute } from './routes';

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

function toEntryView(row: EntryRow, pauses: StagePauseView[]): StageEntryView {
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
		checklistState: row.entry.checklistState,
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

/** Записи стадий взаимодействия вместе со сроками и паузами, новые сверху. */
async function readEntries(
	executor: Executor,
	condition: SQL
): Promise<{ rows: EntryRow[]; pauses: Map<string, StagePauseView[]> }> {
	const rows = (await executor
		.select(entryColumns)
		.from(stageEntries)
		.innerJoin(stageEntryStatus, eq(stageEntryStatus.stageEntryId, stageEntries.id))
		.leftJoin(users, eq(users.id, stageEntries.responsibleUserId))
		.where(condition)
		.orderBy(desc(stageEntries.enteredAt))) as EntryRow[];

	const pauses = new Map<string, StagePauseView[]>();

	if (rows.length > 0) {
		const pauseRows = await executor
			.select()
			.from(stagePauses)
			.where(
				inArray(
					stagePauses.stageEntryId,
					rows.map((row) => row.entry.id)
				)
			)
			.orderBy(desc(stagePauses.startedAt));

		for (const pause of pauseRows) {
			const list = pauses.get(pause.stageEntryId) ?? [];
			list.push(toPauseView(pause));
			pauses.set(pause.stageEntryId, list);
		}
	}

	return { rows, pauses };
}

/**
 * Лента маршрута: каким состоянием показать каждую стадию. Стадия, которую
 * перешагнули (записи нет, а процесс уже дальше), показывается пропущенной —
 * иначе пропуск был бы виден только в истории.
 */
export function buildProgress(
	routeStages: StageView[],
	entries: { stageId: string; leftAt: Date | null }[],
	current: { stageId: string; dueAt: Date; isOverdue: boolean; isPaused: boolean } | null,
	hasBlockingBlockers: boolean
): StageProgressItem[] {
	const visited = new Set(entries.map((entry) => entry.stageId));
	const currentStage = routeStages.find((stage) => stage.id === current?.stageId);
	const currentPosition = currentStage?.position ?? 0;

	return routeStages.map((stage) => {
		const base = {
			stageId: stage.id,
			key: stage.key,
			name: stage.name,
			position: stage.position,
			category: stage.category
		};

		if (current !== null && stage.id === current.stageId) {
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

		if (visited.has(stage.id)) {
			return { ...base, state: 'done' as const, dueAt: null, note: null };
		}

		if (stage.position < currentPosition) {
			return { ...base, state: 'skipped' as const, dueAt: null, note: 'перешагнули' };
		}

		return { ...base, state: 'pending' as const, dueAt: null, note: null };
	});
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

	const [{ rows, pauses }, route, blockerList] = await Promise.all([
		readEntries(db, eq(stageEntries.interactionId, interactionId)),
		readRoute(db, interaction.routeId),
		readBlockers(db, interactionId)
	]);

	const views = rows.map((row) => toEntryView(row, pauses.get(row.entry.id) ?? []));
	const current = views.find((view) => view.leftAt === null) ?? null;
	const openBlocking = blockerList.filter(
		(blocker) => blocker.resolvedAt === null && blocker.blocksTransition
	);

	return {
		interactionId,
		routeId: interaction.routeId,
		current,
		history: views.filter((view) => view.leftAt !== null),
		progress: buildProgress(
			route.stages,
			rows.map((row) => ({ stageId: row.entry.stageId, leftAt: row.entry.leftAt })),
			current === null
				? null
				: {
						stageId: current.stageId,
						dueAt: current.dueAt,
						isOverdue: current.isOverdue,
						isPaused: current.isPaused
					},
			openBlocking.length > 0
		),
		blockers: blockerList,
		isStale: isStale(current?.snapshot ?? null, interaction.lastActivityAt),
		lastActivityAt: interaction.lastActivityAt
	};
}
