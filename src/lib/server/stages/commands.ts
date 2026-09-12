/**
 * Команды, которые двигают взаимодействие по маршруту.
 *
 * Каждая команда атомарна и начинается одинаково: строка взаимодействия
 * блокируется `SELECT … FOR UPDATE`, и только после этого читается открытая
 * запись стадии. Без блокировки две команды, отданные одновременно, прочитали
 * бы одно и то же состояние и обе сочли бы себя правыми — в истории появилось
 * бы два перехода с одной стадии. С блокировкой вторая команда ждёт первую,
 * видит уже сдвинутое состояние и честно отказывает.
 *
 * Можно ли переход вообще, решает `evaluateTransition` — та же функция, что
 * рисует кнопки в карточке. Команда не повторяет её правил.
 */
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type {
	AdvanceStageInput,
	ConfirmStageInput,
	CreateCommentInput,
	PauseStageInput,
	RaiseBlockerInput,
	ResolveBlockerInput,
	ResumeStageInput,
	ReturnStageInput,
	SetChecklistItemInput,
	SetResponsibleInput,
	SetStageResultInput,
	SkipStageInput,
	StageConfirmation,
	StageSnapshot,
	StageTransitionKind,
	StageTransitionView
} from '$lib/contracts/interactions';
import type { AuditEventType } from '$lib/contracts/audit';
import type { ActorContext } from '../actor';
import { recordAuditEvent } from '../audit';
import {
	blockers,
	comments,
	documents,
	interactionChanges,
	interactions,
	stageEntries,
	stagePauses,
	stages,
	stageTransitions
} from '../db/schema';
import { withTransaction, type Tx } from '../db/transaction';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../errors';
import { can, requirePermission } from '../rbac';
import { interactionScopeFilter } from '../interactions/access';
import { evaluateTransition, transitionPermission, type StageState } from './transitions';

/** Момент, который ставит база: часы приложения и базы могут расходиться. */
const now = sql`now()`;

/**
 * Пользователь, от чьего имени идёт действие. Фоновой задаче здесь не место:
 * у записи о помехе, комментарии и отметке подтверждения есть автор, и это не
 * «система».
 */
function actingUserId(ctx: ActorContext): string {
	if (ctx.user === null) {
		throw new ForbiddenError('Это действие выполняет пользователь, а не фоновая задача');
	}

	return ctx.user.id;
}

type LockedInteraction = { id: string; routeId: string; ownerUserId: string };

/**
 * Блокировка строки взаимодействия на время команды. Область доступа проверяется
 * тем же запросом: чужую запись нельзя ни увидеть, ни сдвинуть.
 */
async function lockInteraction(
	ctx: ActorContext,
	tx: Tx,
	interactionId: string
): Promise<LockedInteraction> {
	const [row] = await tx
		.select({
			id: interactions.id,
			routeId: interactions.routeId,
			ownerUserId: interactions.ownerUserId
		})
		.from(interactions)
		.where(and(eq(interactions.id, interactionId), interactionScopeFilter(ctx)))
		.for('update');

	if (row === undefined) {
		throw new NotFoundError('Взаимодействие не найдено');
	}

	return row;
}

/** Открытая запись стадии. Её отсутствие — это состояние, а не поломка. */
async function readOpenEntryRow(
	tx: Tx,
	interactionId: string
): Promise<typeof stageEntries.$inferSelect | null> {
	const [row] = await tx
		.select()
		.from(stageEntries)
		.where(and(eq(stageEntries.interactionId, interactionId), isNull(stageEntries.leftAt)))
		.limit(1);

	return row ?? null;
}

/** Та же запись, но её отсутствие — отказ: команда обращена к текущей стадии. */
async function requireOpenEntry(
	tx: Tx,
	interactionId: string
): Promise<typeof stageEntries.$inferSelect> {
	const entry = await readOpenEntryRow(tx, interactionId);

	if (entry === null) {
		throw new ConflictError('Взаимодействие не стоит ни на одной стадии');
	}

	return entry;
}

async function hasOpenPause(tx: Tx, stageEntryId: string): Promise<boolean> {
	const [row] = await tx
		.select({ id: stagePauses.id })
		.from(stagePauses)
		.where(and(eq(stagePauses.stageEntryId, stageEntryId), isNull(stagePauses.endedAt)))
		.limit(1);

	return row !== undefined;
}

async function countBlockingBlockers(tx: Tx, interactionId: string): Promise<number> {
	const rows = await tx
		.select({ id: blockers.id })
		.from(blockers)
		.where(
			and(
				eq(blockers.interactionId, interactionId),
				isNull(blockers.resolvedAt),
				eq(blockers.blocksTransition, true)
			)
		);

	return rows.length;
}

/** Состояние стадии в объёме правил перехода. */
async function readStageState(
	tx: Tx,
	entry: typeof stageEntries.$inferSelect
): Promise<StageState> {
	const [paused, blocking] = await Promise.all([
		hasOpenPause(tx, entry.id),
		countBlockingBlockers(tx, entry.interactionId)
	]);

	return {
		stageId: entry.stageId,
		snapshot: entry.stageSnapshot,
		checklistState: entry.checklistState,
		resultText: entry.resultText,
		confirmation: entry.confirmation,
		isPaused: paused,
		blockingBlockers: blocking
	};
}

/**
 * Слепок стадии на момент входа. Маршрут могут переиздать, а норматив и
 * чек-лист уже пройденной стадии обязаны остаться такими, какими их видел
 * исполнитель.
 */
function toSnapshot(stage: typeof stages.$inferSelect): StageSnapshot {
	return {
		key: stage.key,
		name: stage.name,
		position: stage.position,
		category: stage.category,
		slaDays: stage.slaDays,
		staleAfterDays: stage.staleAfterDays,
		requiresResult: stage.requiresResult,
		requiresConfirmation: stage.requiresConfirmation,
		checklist: stage.checklist
	};
}

/** Взаимодействие ожило: по этому моменту считается протухание. */
async function touchInteraction(tx: Tx, interactionId: string): Promise<void> {
	await tx
		.update(interactions)
		.set({ lastActivityAt: now, updatedAt: now })
		.where(eq(interactions.id, interactionId));
}

async function readStage(tx: Tx, stageId: string): Promise<typeof stages.$inferSelect> {
	const [stage] = await tx.select().from(stages).where(eq(stages.id, stageId)).limit(1);

	if (stage === undefined) {
		throw new NotFoundError('Стадия не найдена');
	}

	return stage;
}

/** Первая стадия маршрута: с неё взаимодействие начинает путь. */
async function readFirstStage(tx: Tx, routeId: string): Promise<typeof stages.$inferSelect> {
	const [stage] = await tx
		.select()
		.from(stages)
		.where(eq(stages.routeId, routeId))
		.orderBy(asc(stages.position))
		.limit(1);

	if (stage === undefined) {
		throw new ConflictError('В маршруте нет ни одной стадии');
	}

	return stage;
}

/**
 * Открывает первую стадию. Выделена отдельно от `startInteraction`, потому что
 * создание взаимодействия делает это внутри своей транзакции: запись без стадии
 * не должна существовать даже мгновение.
 */
export async function startInteractionIn(
	ctx: ActorContext,
	tx: Tx,
	interaction: LockedInteraction
): Promise<string> {
	if ((await readOpenEntryRow(tx, interaction.id)) !== null) {
		throw new ConflictError('Взаимодействие уже идёт по маршруту');
	}

	const stage = await readFirstStage(tx, interaction.routeId);

	const [entry] = await tx
		.insert(stageEntries)
		.values({
			interactionId: interaction.id,
			stageId: stage.id,
			stageSnapshot: toSnapshot(stage),
			responsibleUserId: interaction.ownerUserId
		})
		.returning({ id: stageEntries.id });

	await touchInteraction(tx, interaction.id);

	await recordAuditEvent(
		ctx,
		{
			type: 'interactions.started',
			outcome: 'success',
			subject: { type: 'interaction', id: interaction.id },
			details: { stageId: stage.id, stageEntryId: entry.id }
		},
		tx
	);

	return entry.id;
}

export async function startInteraction(ctx: ActorContext, interactionId: string): Promise<void> {
	requirePermission(ctx, 'stages.transition');

	await withTransaction(ctx, async (tx) => {
		const interaction = await lockInteraction(ctx, tx, interactionId);

		await startInteractionIn(ctx, tx, interaction);
	});
}

async function readTransition(
	tx: Tx,
	routeId: string,
	fromStageId: string,
	toStageId: string,
	kind: StageTransitionKind
): Promise<StageTransitionView> {
	const [row] = await tx
		.select()
		.from(stageTransitions)
		.where(
			and(
				eq(stageTransitions.routeId, routeId),
				eq(stageTransitions.fromStageId, fromStageId),
				eq(stageTransitions.toStageId, toStageId),
				eq(stageTransitions.kind, kind)
			)
		)
		.limit(1);

	if (row === undefined) {
		throw new ValidationError('В маршруте нет такого перехода', [
			'Переход между этими стадиями не описан в конфигурации маршрута'
		]);
	}

	return {
		id: row.id,
		fromStageId: row.fromStageId,
		toStageId: row.toStageId,
		kind: row.kind,
		requiredPermissionKey: row.requiredPermissionKey,
		requiresReason: row.requiresReason
	};
}

const OUTCOME_BY_KIND = {
	forward: 'completed',
	return: 'returned',
	skip: 'skipped'
} as const;

const EVENT_BY_KIND: Record<StageTransitionKind, AuditEventType> = {
	forward: 'interactions.stage_advanced',
	return: 'interactions.stage_returned',
	skip: 'interactions.stage_skipped'
};

type MoveInput = {
	interactionId: string;
	fromStageId: string;
	toStageId: string;
	kind: StageTransitionKind;
	reason?: string | null;
	resultText?: string | null;
	checklistState?: Record<string, boolean>;
};

/** Один переход: общая часть шага вперёд, возврата и пропуска. */
async function moveStage(ctx: ActorContext, input: MoveInput): Promise<void> {
	await withTransaction(ctx, async (tx) => {
		const interaction = await lockInteraction(ctx, tx, input.interactionId);
		const entry = await requireOpenEntry(tx, input.interactionId);
		const transition = await readTransition(
			tx,
			interaction.routeId,
			input.fromStageId,
			input.toStageId,
			input.kind
		);

		const permission = transitionPermission(transition);

		// Отказ по правам — это «нельзя вам», а не «нельзя сейчас»: наблюдатель
		// не должен получать ответ, из которого следует, что дело в состоянии.
		if (permission === null || !can(ctx, permission)) {
			throw new ForbiddenError(
				`Недостаточно прав: требуется «${transition.requiredPermissionKey}»`
			);
		}

		const state = await readStageState(tx, entry);
		const verdict = evaluateTransition(ctx, state, transition, {
			reason: input.reason ?? null,
			resultText: input.resultText ?? null,
			checklistState: input.checklistState ?? {}
		});

		if (!verdict.allowed) {
			throw new ConflictError(`Переход невозможен. ${verdict.reasons.join('; ')}`);
		}

		const target = await readStage(tx, input.toStageId);
		const checklistState = { ...entry.checklistState, ...(input.checklistState ?? {}) };
		const resultText =
			input.resultText !== null && input.resultText !== undefined && input.resultText !== ''
				? input.resultText
				: entry.resultText;

		await tx
			.update(stageEntries)
			.set({
				checklistState,
				resultText,
				leftAt: now,
				outcome: OUTCOME_BY_KIND[input.kind],
				outcomeReason: input.reason ?? null,
				updatedAt: now
			})
			.where(eq(stageEntries.id, entry.id));

		// Пауза принадлежит записи стадии: уходя со стадии, её закрывают, иначе
		// в истории останется пауза, которая никогда не кончилась.
		await tx
			.update(stagePauses)
			.set({ endedAt: now, updatedAt: now })
			.where(and(eq(stagePauses.stageEntryId, entry.id), isNull(stagePauses.endedAt)));

		const [next] = await tx
			.insert(stageEntries)
			.values({
				interactionId: input.interactionId,
				stageId: target.id,
				stageSnapshot: toSnapshot(target),
				responsibleUserId: entry.responsibleUserId ?? interaction.ownerUserId
			})
			.returning({ id: stageEntries.id });

		await touchInteraction(tx, input.interactionId);

		await recordAuditEvent(
			ctx,
			{
				type: EVENT_BY_KIND[input.kind],
				outcome: 'success',
				subject: { type: 'interaction', id: input.interactionId },
				details: {
					fromStageId: input.fromStageId,
					stageId: target.id,
					stageEntryId: next.id
				}
			},
			tx
		);
	});
}

export async function advanceStage(ctx: ActorContext, input: AdvanceStageInput): Promise<void> {
	await moveStage(ctx, {
		interactionId: input.interactionId,
		fromStageId: input.fromStageId,
		toStageId: input.toStageId,
		kind: 'forward',
		resultText: input.resultText,
		checklistState: input.checklistState
	});
}

export async function returnStage(ctx: ActorContext, input: ReturnStageInput): Promise<void> {
	await moveStage(ctx, {
		interactionId: input.interactionId,
		fromStageId: input.fromStageId,
		toStageId: input.toStageId,
		kind: 'return',
		reason: input.reason
	});
}

export async function skipStage(ctx: ActorContext, input: SkipStageInput): Promise<void> {
	await moveStage(ctx, {
		interactionId: input.interactionId,
		fromStageId: input.fromStageId,
		toStageId: input.toStageId,
		kind: 'skip',
		reason: input.reason
	});
}

/** Часы стадии останавливаются: ждать ответа вуза и не успеть — разные вещи. */
export async function pauseStage(ctx: ActorContext, input: PauseStageInput): Promise<void> {
	requirePermission(ctx, 'stages.transition');

	await withTransaction(ctx, async (tx) => {
		await lockInteraction(ctx, tx, input.interactionId);
		const entry = await requireOpenEntry(tx, input.interactionId);

		if (entry.stageId !== input.fromStageId) {
			throw new ConflictError('Взаимодействие уже на другой стадии');
		}

		if (await hasOpenPause(tx, entry.id)) {
			throw new ConflictError('Стадия уже на паузе');
		}

		const [pause] = await tx
			.insert(stagePauses)
			.values({
				stageEntryId: entry.id,
				reason: input.reason,
				waitingPartyId: input.waitingPartyId,
				nextAction: input.nextAction,
				note: input.note
			})
			.returning({ id: stagePauses.id });

		// Кого ждём — часть состояния стадии, а не только записи о паузе: карточка
		// отвечает на вопрос «кто должен действовать» и в свёрнутом виде.
		await tx
			.update(stageEntries)
			.set({ waitingPartyId: input.waitingPartyId, updatedAt: now })
			.where(eq(stageEntries.id, entry.id));

		await touchInteraction(tx, input.interactionId);

		await recordAuditEvent(
			ctx,
			{
				type: 'interactions.paused',
				outcome: 'success',
				subject: { type: 'interaction', id: input.interactionId },
				details: { stageEntryId: entry.id, pauseId: pause.id }
			},
			tx
		);
	});
}

export async function resumeStage(ctx: ActorContext, input: ResumeStageInput): Promise<void> {
	requirePermission(ctx, 'stages.transition');

	await withTransaction(ctx, async (tx) => {
		await lockInteraction(ctx, tx, input.interactionId);
		const entry = await requireOpenEntry(tx, input.interactionId);

		if (entry.stageId !== input.fromStageId) {
			throw new ConflictError('Взаимодействие уже на другой стадии');
		}

		const [pause] = await tx
			.update(stagePauses)
			.set({ endedAt: now, updatedAt: now })
			.where(and(eq(stagePauses.stageEntryId, entry.id), isNull(stagePauses.endedAt)))
			.returning({ id: stagePauses.id });

		if (pause === undefined) {
			throw new ConflictError('Стадия не на паузе');
		}

		await tx
			.update(stageEntries)
			.set({ waitingPartyId: null, updatedAt: now })
			.where(eq(stageEntries.id, entry.id));

		await touchInteraction(tx, input.interactionId);

		await recordAuditEvent(
			ctx,
			{
				type: 'interactions.resumed',
				outcome: 'success',
				subject: { type: 'interaction', id: input.interactionId },
				details: { stageEntryId: entry.id, pauseId: pause.id }
			},
			tx
		);
	});
}

/** Отметка по пункту чек-листа текущей стадии. */
export async function setChecklistItem(
	ctx: ActorContext,
	input: SetChecklistItemInput
): Promise<void> {
	requirePermission(ctx, 'stages.transition');

	await withTransaction(ctx, async (tx) => {
		await lockInteraction(ctx, tx, input.interactionId);
		const entry = await requireOpenEntry(tx, input.interactionId);

		// Пункт берётся из слепка стадии: чек-лист, который можно дополнить из
		// браузера произвольным ключом, ничего не гарантирует.
		if (!entry.stageSnapshot.checklist.some((item) => item.key === input.key)) {
			throw new ValidationError('В чек-листе стадии нет такого пункта', [input.key]);
		}

		await tx
			.update(stageEntries)
			.set({
				checklistState: { ...entry.checklistState, [input.key]: input.done },
				updatedAt: now
			})
			.where(eq(stageEntries.id, entry.id));

		await touchInteraction(tx, input.interactionId);

		await recordAuditEvent(
			ctx,
			{
				type: 'interactions.checklist_changed',
				outcome: 'success',
				subject: { type: 'interaction', id: input.interactionId },
				details: { stageEntryId: entry.id }
			},
			tx
		);
	});
}

export async function setStageResult(ctx: ActorContext, input: SetStageResultInput): Promise<void> {
	requirePermission(ctx, 'stages.transition');

	await withTransaction(ctx, async (tx) => {
		await lockInteraction(ctx, tx, input.interactionId);
		const entry = await requireOpenEntry(tx, input.interactionId);

		await tx
			.update(stageEntries)
			.set({ resultText: input.resultText, updatedAt: now })
			.where(eq(stageEntries.id, entry.id));

		await touchInteraction(tx, input.interactionId);

		await recordAuditEvent(
			ctx,
			{
				type: 'interactions.result_recorded',
				outcome: 'success',
				subject: { type: 'interaction', id: input.interactionId },
				details: { stageEntryId: entry.id }
			},
			tx
		);
	});
}

/** Подтверждение стадии: файлом, отметкой исполнителя или записью в LMS. */
export async function confirmStage(ctx: ActorContext, input: ConfirmStageInput): Promise<void> {
	requirePermission(ctx, 'stages.transition');

	const userId = actingUserId(ctx);

	await withTransaction(ctx, async (tx) => {
		await lockInteraction(ctx, tx, input.interactionId);
		const entry = await requireOpenEntry(tx, input.interactionId);

		if (entry.stageId !== input.fromStageId) {
			throw new ConflictError('Взаимодействие уже на другой стадии');
		}

		let confirmation: StageConfirmation;
		let documentId: string | null = null;

		if (input.confirmation.kind === 'file') {
			const [document] = await tx
				.select({ id: documents.id, interactionId: documents.interactionId })
				.from(documents)
				.where(eq(documents.id, input.confirmation.documentId))
				.limit(1);

			// Подтверждение чужим документом — это подтверждение ничем: файл обязан
			// принадлежать тому же взаимодействию.
			if (document === undefined || document.interactionId !== input.interactionId) {
				throw new ValidationError('Документ не относится к этому взаимодействию', [
					'Выберите документ, загруженный в карточку взаимодействия'
				]);
			}

			documentId = document.id;
			confirmation = { kind: 'file', documentId: document.id };
		} else if (input.confirmation.kind === 'mark') {
			// Автора и время отметки проставляет сервер: клиент не может назначить,
			// кто и когда подтвердил.
			confirmation = { kind: 'mark', byUserId: userId, at: new Date().toISOString() };
		} else {
			confirmation = {
				kind: 'lms_record',
				source: input.confirmation.source,
				recordId: input.confirmation.recordId
			};
		}

		await tx
			.update(stageEntries)
			.set({
				confirmation,
				confirmationDocumentId: documentId,
				confirmedAt: now,
				confirmedBy: userId,
				updatedAt: now
			})
			.where(eq(stageEntries.id, entry.id));

		await touchInteraction(tx, input.interactionId);

		await recordAuditEvent(
			ctx,
			{
				type: 'interactions.confirmed',
				outcome: 'success',
				subject: { type: 'interaction', id: input.interactionId },
				details:
					documentId === null ? { stageEntryId: entry.id } : { stageEntryId: entry.id, documentId }
			},
			tx
		);
	});
}

export async function raiseBlocker(
	ctx: ActorContext,
	input: RaiseBlockerInput
): Promise<{ id: string }> {
	requirePermission(ctx, 'interactions.write');

	const userId = actingUserId(ctx);

	return withTransaction(ctx, async (tx) => {
		await lockInteraction(ctx, tx, input.interactionId);
		const entry = await readOpenEntryRow(tx, input.interactionId);

		const [blocker] = await tx
			.insert(blockers)
			.values({
				interactionId: input.interactionId,
				stageEntryId: entry?.id ?? null,
				reasonCode: input.reasonCode,
				description: input.description,
				blocksTransition: input.blocksTransition,
				raisedBy: userId,
				assigneeUserId: input.assigneeUserId
			})
			.returning({ id: blockers.id });

		await touchInteraction(tx, input.interactionId);

		await recordAuditEvent(
			ctx,
			{
				type: 'interactions.blocker_raised',
				outcome: 'success',
				subject: { type: 'interaction', id: input.interactionId },
				details: { blockerId: blocker.id }
			},
			tx
		);

		return blocker;
	});
}

export async function resolveBlocker(ctx: ActorContext, input: ResolveBlockerInput): Promise<void> {
	requirePermission(ctx, 'interactions.write');

	const userId = actingUserId(ctx);

	await withTransaction(ctx, async (tx) => {
		const [existing] = await tx
			.select({ interactionId: blockers.interactionId })
			.from(blockers)
			.where(eq(blockers.id, input.blockerId))
			.limit(1);

		if (existing === undefined) {
			throw new NotFoundError('Помеха не найдена');
		}

		await lockInteraction(ctx, tx, existing.interactionId);

		// Условие «ещё не снята» живёт в самом UPDATE: между чтением и записью
		// помеху мог закрыть кто-то другой.
		const [resolved] = await tx
			.update(blockers)
			.set({
				resolvedAt: now,
				resolvedBy: userId,
				resolution: input.resolution,
				updatedAt: now
			})
			.where(and(eq(blockers.id, input.blockerId), isNull(blockers.resolvedAt)))
			.returning({ id: blockers.id });

		if (resolved === undefined) {
			throw new ConflictError('Помеха уже снята');
		}

		await touchInteraction(tx, existing.interactionId);

		await recordAuditEvent(
			ctx,
			{
				type: 'interactions.blocker_resolved',
				outcome: 'success',
				subject: { type: 'interaction', id: existing.interactionId },
				details: { blockerId: input.blockerId }
			},
			tx
		);
	});
}

/**
 * Смена ответственного, в том числе сразу по нескольким взаимодействиям из
 * списка. Идентификаторы блокируются в одном порядке: иначе две такие команды,
 * отданные навстречу друг другу, встали бы во взаимный замок.
 */
export async function setResponsible(
	ctx: ActorContext,
	input: SetResponsibleInput
): Promise<number> {
	requirePermission(ctx, 'interactions.write');

	const authorId = actingUserId(ctx);
	const ids = [...new Set(input.interactionIds)].sort();

	return withTransaction(ctx, async (tx) => {
		let changed = 0;

		for (const interactionId of ids) {
			const interaction = await lockInteraction(ctx, tx, interactionId);

			if (interaction.ownerUserId === input.userId) {
				continue;
			}

			await tx
				.update(interactions)
				.set({ ownerUserId: input.userId, lastActivityAt: now, updatedAt: now })
				.where(eq(interactions.id, interactionId));

			const entry = await readOpenEntryRow(tx, interactionId);

			if (entry !== null) {
				await tx
					.update(stageEntries)
					.set({ responsibleUserId: input.userId, updatedAt: now })
					.where(eq(stageEntries.id, entry.id));
			}

			await tx.insert(interactionChanges).values({
				interactionId,
				authorId,
				field: 'ownerUserId',
				oldValue: interaction.ownerUserId,
				newValue: input.userId
			});

			await recordAuditEvent(
				ctx,
				{
					type: 'interactions.responsible_changed',
					outcome: 'success',
					subject: { type: 'interaction', id: interactionId },
					details: { userId: input.userId }
				},
				tx
			);

			changed += 1;
		}

		return changed;
	});
}

export async function addComment(
	ctx: ActorContext,
	input: CreateCommentInput
): Promise<{ id: string }> {
	requirePermission(ctx, 'interactions.write');

	const authorId = actingUserId(ctx);

	return withTransaction(ctx, async (tx) => {
		await lockInteraction(ctx, tx, input.interactionId);

		const [comment] = await tx
			.insert(comments)
			.values({ interactionId: input.interactionId, authorId, body: input.body })
			.returning({ id: comments.id });

		await touchInteraction(tx, input.interactionId);

		await recordAuditEvent(
			ctx,
			{
				type: 'interactions.commented',
				outcome: 'success',
				subject: { type: 'interaction', id: input.interactionId },
				details: { commentId: comment.id }
			},
			tx
		);

		return comment;
	});
}
