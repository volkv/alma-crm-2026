/**
 * Команды, которые двигают взаимодействие по процессу.
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
 *
 * Переход вдобавок сверяет номер редакции процесса: стадия с тем же
 * идентификатором после публикации принадлежит прежней редакции, поэтому одной
 * сверки `fromStageId` мало. Несовпадение — отказ до единой записи; введённое
 * человеком остаётся в форме, теряется только нажатие кнопки. Тот же номер
 * несут завершение и отмена: обе команды принимают решение по финальной стадии
 * и её требованиям, а публикация меняет и то и другое. Команды, которые номера
 * в запросе не несут — пауза и её снятие, отметка чек-листа, результат и
 * подтверждение, — сверяют его вокруг блокировки: публикация, прошедшая, пока
 * команда ждала, получает тот же отказ теми же словами.
 */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type {
	AdvanceStageInput,
	CancelInteractionInput,
	CommentSource,
	CompleteInteractionInput,
	ConfirmStageInput,
	CreateCommentInput,
	InteractionClosingView,
	InteractionStatus,
	PauseStageInput,
	RaiseBlockerInput,
	ResolveBlockerInput,
	ResumeStageInput,
	ReturnStageInput,
	SetChecklistItemInput,
	SetResponsibleInput,
	SetStageResultInput,
	SkipStageInput,
	ProcessRevisionView,
	StageConfirmation,
	StageSnapshot,
	StageTransitionKind,
	StageTransitionView
} from '$lib/contracts/interactions';
import type { AuditEventType } from '$lib/contracts/audit';
import {
	DOCUMENT_STATUS_FACT_LABELS,
	type DocumentMarkEvidence,
	type DocumentStatusFact
} from '$lib/contracts/documents';
import type { LmsEvidence } from '$lib/contracts/exchange';
import type { ActorContext } from '../actor';
import { recordAuditEvent } from '../audit';
import { getDb } from '../db';
import {
	blockers,
	comments,
	documents,
	interactionChanges,
	interactions,
	workspaces,
	workflows,
	processRevisions,
	stageEntries,
	stageEntryDocuments,
	stagePauses,
	stages,
	stageTransitions
} from '../db/schema';
import { withTransaction, type Tx } from '../db/transaction';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../errors';
import { readDocumentMark } from '../documents/evidence';
import { readLmsEvidence } from '../integrations/exchange/evidence';
import { enqueueApplicationStatus } from '../integrations/exchange/outbox';
import { can, requirePermission } from '../rbac';
import { interactionScopeFilter } from '../interactions/access';
import { firstStage, requireActiveRevisionForWorkspace, stageSnapshot } from './process';
import { evaluateTransition, transitionPermission, type StageState } from './transitions';

/**
 * Момент, который ставит база: часы приложения и базы могут расходиться.
 *
 * Именно `clock_timestamp()`, а не `now()`. `now()` в PostgreSQL — это начало
 * транзакции, а каждая команда до первой записи ждёт блокировку строки
 * взаимодействия. Публикация изменения процесса, прошедшая за это время,
 * открывает переехавшим записям стадий свой, более поздний момент; `left_at =
 * now()` у такой записи оказался бы раньше её `entered_at`, база отказала бы
 * проверкой `stage_entries_left_after_entered`, и человек увидел бы пятисотую
 * вместо ответа по существу. Момент после блокировок не бывает раньше ничего,
 * что зафиксировано до них.
 */
const now = sql`clock_timestamp()`;

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

type LockedInteraction = { id: string; workspaceId: string; ownerUserId: string };

/** Кто выполняет запрос: транзакция команды или общий пул для чтения. */
type Executor = Tx | ReturnType<typeof getDb>;

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
			workspaceId: interactions.workspaceId,
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

/**
 * Номер действующей редакции процесса, по которому идёт взаимодействие.
 * Без блокировки: значение спрашивают дважды — до ожидания и после него.
 */
async function readRevisionVersion(tx: Tx, interactionId: string): Promise<number | null> {
	const [row] = await tx
		.select({ version: processRevisions.version })
		.from(interactions)
		.innerJoin(workspaces, eq(workspaces.id, interactions.workspaceId))
		.innerJoin(workflows, eq(workflows.id, workspaces.workflowId))
		.innerJoin(processRevisions, eq(processRevisions.id, workflows.activeRevisionId))
		.where(eq(interactions.id, interactionId))
		.limit(1);

	return row?.version ?? null;
}

/**
 * Блокировка строки для команд стадии, которые номера редакции в запросе не
 * несут: пауза и её снятие, отметка чек-листа, результат и подтверждение. Все
 * они обращены к текущей стадии, а не к переходу, и выбора стадии в них нет.
 *
 * Сверка всё равно нужна: пока команда ждала блокировку, публикация могла
 * перенести взаимодействие на другую стадию — и тогда команда работает уже не с
 * той записью, которую человек видел в карточке. Сверки `fromStageId` мало: она
 * отвечает «взаимодействие уже на другой стадии», а произошло другое — процесс
 * изменился, и карточку надо перечитать. Номер читается до блокировки и
 * сверяется после неё; несовпадение — тот же отказ, что у перехода, и до единой
 * записи.
 */
async function lockInteractionOnSameRevision(
	ctx: ActorContext,
	tx: Tx,
	interactionId: string
): Promise<LockedInteraction> {
	const before = await readRevisionVersion(tx, interactionId);
	const interaction = await lockInteraction(ctx, tx, interactionId);

	if ((await readRevisionVersion(tx, interactionId)) !== before) {
		throw new ConflictError(
			'Процесс изменился, пока вы работали с карточкой. Обновите страницу и повторите'
		);
	}

	return interaction;
}

/** Открытая запись стадии. Её отсутствие — это состояние, а не поломка. */
async function readOpenEntryRow(
	executor: Executor,
	interactionId: string
): Promise<typeof stageEntries.$inferSelect | null> {
	const [row] = await executor
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
	const requiredMark = entry.stageSnapshot.requiresDocumentMark;

	const [paused, blocking, evidence, mark] = await Promise.all([
		hasOpenPause(tx, entry.id),
		countBlockingBlockers(tx, entry.interactionId),
		// Факт, пришедший до входа на стадию, засчитывается: система обучения
		// присылает результат по своему расписанию, а не по нашему процессу
		// (`docs/exchange-contract.md`, раздел 6). Снимок записи сильнее: он уже
		// объяснил подтверждение именно этой стадии.
		entry.lmsEvidence === null ? readLmsEvidence(tx, entry.interactionId) : null,
		// То же и с отметкой по документу. Снимок на записи есть почти всегда —
		// его кладут и вход на стадию, и сама отметка, — а прочитать заново
		// приходится там, где требование включили публикацией уже под открытой
		// записью: документ отмечен, а снимка на ней нет.
		readCurrentDocumentMark(tx, entry, requiredMark)
	]);

	return {
		stageId: entry.stageId,
		snapshot: entry.stageSnapshot,
		checklistState: entry.checklistState,
		resultText: entry.resultText,
		confirmation: entry.confirmation,
		lmsEvidence: entry.lmsEvidence ?? evidence,
		documentMarkEvidence: mark,
		isPaused: paused,
		blockingBlockers: blocking
	};
}

/**
 * Отметка, которой подтверждена открытая запись: снимок на ней либо отметка по
 * делу, если снимка ещё нет. Отметка не того вида, что требует стадия, не
 * считается вовсе — требование обязано остаться невыполненным.
 */
async function readCurrentDocumentMark(
	executor: Executor,
	entry: { interactionId: string; documentMarkEvidence: DocumentMarkEvidence | null },
	requiredMark: DocumentStatusFact | null
): Promise<DocumentMarkEvidence | null> {
	if (requiredMark === null) {
		return entry.documentMarkEvidence;
	}

	if (entry.documentMarkEvidence?.mark === requiredMark) {
		return entry.documentMarkEvidence;
	}

	return readDocumentMark(executor, entry.interactionId, requiredMark);
}

/**
 * Закрывает открытую паузу записи стадии. Пауза принадлежит записи: со стадии
 * уходят и по переходу, и закрывая взаимодействие, — и в обоих случаях
 * незакрытая пауза в истории означала бы, что ждать не перестали никогда.
 */
async function closeOpenPause(tx: Tx, stageEntryId: string): Promise<void> {
	await tx
		.update(stagePauses)
		.set({ endedAt: now, updatedAt: now })
		.where(and(eq(stagePauses.stageEntryId, stageEntryId), isNull(stagePauses.endedAt)));
}

/**
 * Взаимодействие ожило: по этому моменту считается протухание.
 *
 * Зовут не только команды движка: документ, загруженный или собранный по
 * взаимодействию, — такая же работа по нему, как комментарий, и оставлять
 * запись «протухшей» после неё значит подсказывать менеджеру помешать тому,
 * кто как раз занят делом.
 */
export async function touchInteraction(tx: Tx, interactionId: string): Promise<void> {
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

/**
 * Открывает первую стадию действующей редакции.
 *
 * Зовут её изнутри транзакции создания взаимодействия — своей команды у начала
 * пути нет: запись без стадии не должна существовать даже мгновение, а значит и
 * второго входа на первую стадию быть не может (его не даст и частичный
 * уникальный индекс `stage_entries_one_open_per_interaction`).
 *
 * Редакция приезжает параметром: её читает тот, кто уже держит разделяемую
 * блокировку пространства, — иначе взаимодействие, созданное в миллисекунду
 * публикации, встало бы на стадию редакции, которая уже не действует.
 */
export async function startInteractionIn(
	ctx: ActorContext,
	tx: Tx,
	interaction: LockedInteraction,
	revision: ProcessRevisionView
): Promise<string> {
	if ((await readOpenEntryRow(tx, interaction.id)) !== null) {
		throw new ConflictError('Взаимодействие уже идёт по процессу');
	}

	const stage = firstStage(revision);

	const [entry] = await tx
		.insert(stageEntries)
		.values({
			interactionId: interaction.id,
			stageId: stage.id,
			stageSnapshot: stageSnapshot(stage),
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

async function readTransition(
	tx: Tx,
	revisionId: string,
	fromStageId: string,
	toStageId: string,
	kind: StageTransitionKind
): Promise<StageTransitionView> {
	const [row] = await tx
		.select()
		.from(stageTransitions)
		.where(
			and(
				eq(stageTransitions.revisionId, revisionId),
				eq(stageTransitions.fromStageId, fromStageId),
				eq(stageTransitions.toStageId, toStageId),
				eq(stageTransitions.kind, kind)
			)
		)
		.limit(1);

	if (row === undefined) {
		throw new ValidationError('В процессе нет такого перехода', [
			'Переход между этими стадиями не описан в действующем процессе пространства'
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
	/** Редакция процесса, по которой собрана команда. */
	revision: number;
	kind: StageTransitionKind;
	reason?: string | null;
	resultText?: string | null;
	checklistState?: Record<string, boolean>;
	/** Документы, приложенные к покидаемой стадии вместе с переходом. */
	documentIds?: string[];
};

/**
 * Номер действующей редакции сверяется под блокировкой строки взаимодействия.
 *
 * Читается после `SELECT … FOR UPDATE`: если публикация успела раньше, команда
 * ждала на блокировке и теперь видит уже новую редакцию — и честно отказывает.
 * Несовпадение стоит пользователю нажатия кнопки, а не введённого: комментарий
 * и вложения остаются в форме.
 *
 * `repeat` — чем кончается фраза отказа: одно и то же правило отказывает и
 * переходу, и завершению, и отмене, а человеку надо сказать, что именно
 * повторить.
 */
async function requireCurrentRevision(
	tx: Tx,
	workspaceId: string,
	expected: number,
	repeat: string
): Promise<ProcessRevisionView> {
	const revision = await requireActiveRevisionForWorkspace(tx, workspaceId);

	if (revision.version !== expected) {
		throw new ConflictError(
			`Процесс изменился, пока вы работали с карточкой. Обновите страницу и повторите ${repeat}`
		);
	}

	return revision;
}

/**
 * Файлы, приложенные к записи стадии.
 *
 * Документ обязан принадлежать тому же взаимодействию: связь с чужим файлом —
 * это подтверждение ничем. Потолок в десять вложений на переход — граница из
 * задания; проверять содержимое архивов мы не будем ни при каком числе, но
 * неограниченный список превращает один переход в хранилище.
 */
const MAX_TRANSITION_DOCUMENTS = 10;

async function attachDocuments(
	tx: Tx,
	interactionId: string,
	stageEntryId: string,
	documentIds: readonly string[]
): Promise<void> {
	const unique = [...new Set(documentIds)];

	if (unique.length === 0) {
		return;
	}

	if (unique.length > MAX_TRANSITION_DOCUMENTS) {
		throw new ValidationError('Слишком много вложений на один переход', [
			`Приложено ${unique.length} файлов, потолок — ${MAX_TRANSITION_DOCUMENTS}`
		]);
	}

	const rows = await tx
		.select({ id: documents.id })
		.from(documents)
		.where(and(inArray(documents.id, unique), eq(documents.interactionId, interactionId)));

	if (rows.length !== unique.length) {
		throw new ValidationError('Документ не относится к этому взаимодействию', [
			'Приложите файлы, загруженные в карточку этого взаимодействия'
		]);
	}

	await tx
		.insert(stageEntryDocuments)
		.values(unique.map((documentId) => ({ stageEntryId, documentId })))
		.onConflictDoNothing();
}

/** Один переход: общая часть шага вперёд, возврата и пропуска. */
async function moveStage(ctx: ActorContext, input: MoveInput): Promise<void> {
	await withTransaction(ctx, async (tx) => {
		const interaction = await lockInteraction(ctx, tx, input.interactionId);
		const revision = await requireCurrentRevision(
			tx,
			interaction.workspaceId,
			input.revision,
			'переход'
		);
		const entry = await requireOpenEntry(tx, input.interactionId);
		const transition = await readTransition(
			tx,
			revision.id,
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
		// Отметка, поставленная до входа на стадию, засчитывается при входе:
		// документ утверждают тогда, когда его подписали, а не тогда, когда дело
		// дошло до стадии подписания. Без этого карточка объявляла бы требование
		// невыполненным, а переход при этом проходил бы.
		const targetMark =
			target.requiresDocumentMark === null
				? null
				: await readDocumentMark(tx, input.interactionId, target.requiresDocumentMark);
		const checklistState = { ...entry.checklistState, ...(input.checklistState ?? {}) };
		const resultText =
			input.resultText !== null && input.resultText !== undefined && input.resultText !== ''
				? input.resultText
				: entry.resultText;

		const [left] = await tx
			.update(stageEntries)
			.set({
				checklistState,
				resultText,
				leftAt: now,
				outcome: OUTCOME_BY_KIND[input.kind],
				outcomeReason: input.reason ?? null,
				updatedAt: now
			})
			.where(eq(stageEntries.id, entry.id))
			.returning({ leftAt: stageEntries.leftAt });

		await closeOpenPause(tx, entry.id);

		// Файлы привязываются к покидаемой записи: они доказывают работу на той
		// стадии, где их приложили, а не на той, куда переходят.
		await attachDocuments(tx, input.interactionId, entry.id, input.documentIds ?? []);

		const [next] = await tx
			.insert(stageEntries)
			.values({
				interactionId: input.interactionId,
				stageId: target.id,
				stageSnapshot: stageSnapshot(target),
				// Вход на новую стадию ровно тем же моментом, каким закрыта прежняя
				// запись: между окнами двух записей не должно быть ни дыры, ни
				// нахлёста — срез на прошлую дату иначе увидел бы взаимодействие
				// сразу на двух стадиях или ни на одной. Умолчание столбца тут не
				// годится: это `now()`, то есть начало транзакции, а команда до
				// первой записи ждала блокировку.
				enteredAt: left.leftAt ?? now,
				responsibleUserId: entry.responsibleUserId ?? interaction.ownerUserId,
				documentMarkEvidence: targetMark
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
					stageEntryId: next.id,
					versionCount: revision.version,
					documentCount: (input.documentIds ?? []).length
				}
			},
			tx
		);

		// Снимок статуса заявки — в той же транзакции, что и переход (outbox):
		// «отправить, потом записать» теряет уведомление при падении процесса
		// между двумя шагами.
		await enqueueApplicationStatus(tx, input.interactionId);
	});
}

/** Вложения приходят не из схемы команды, а от формы или API рядом с ней. */
export type TransitionAttachments = { documentIds?: string[] };

export async function advanceStage(
	ctx: ActorContext,
	input: AdvanceStageInput & TransitionAttachments
): Promise<void> {
	await moveStage(ctx, {
		interactionId: input.interactionId,
		fromStageId: input.fromStageId,
		toStageId: input.toStageId,
		revision: input.revision,
		kind: 'forward',
		// Объяснение едет и на шаге вперёд: процесс вправе потребовать его у любого
		// перехода, и команда, которая его теряет, делает такое правило невыполнимым.
		reason: input.reason,
		resultText: input.resultText,
		checklistState: input.checklistState,
		documentIds: input.documentIds
	});
}

export async function returnStage(
	ctx: ActorContext,
	input: ReturnStageInput & TransitionAttachments
): Promise<void> {
	await moveStage(ctx, {
		interactionId: input.interactionId,
		fromStageId: input.fromStageId,
		toStageId: input.toStageId,
		revision: input.revision,
		kind: 'return',
		reason: input.reason,
		documentIds: input.documentIds
	});
}

export async function skipStage(
	ctx: ActorContext,
	input: SkipStageInput & TransitionAttachments
): Promise<void> {
	await moveStage(ctx, {
		interactionId: input.interactionId,
		fromStageId: input.fromStageId,
		toStageId: input.toStageId,
		revision: input.revision,
		kind: 'skip',
		reason: input.reason,
		documentIds: input.documentIds
	});
}

/** Часы стадии останавливаются: ждать ответа вуза и не успеть — разные вещи. */
export async function pauseStage(ctx: ActorContext, input: PauseStageInput): Promise<void> {
	requirePermission(ctx, 'stages.transition');

	await withTransaction(ctx, async (tx) => {
		await lockInteractionOnSameRevision(ctx, tx, input.interactionId);
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
				note: input.note,
				// Тот же источник момента: пауза, начатая «в начале транзакции», у
				// команды, простоявшей на блокировке, началась бы раньше входа на
				// стадию, часы которой она останавливает.
				startedAt: now
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

		await enqueueApplicationStatus(tx, input.interactionId);
	});
}

export async function resumeStage(ctx: ActorContext, input: ResumeStageInput): Promise<void> {
	requirePermission(ctx, 'stages.transition');

	await withTransaction(ctx, async (tx) => {
		await lockInteractionOnSameRevision(ctx, tx, input.interactionId);
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

		await enqueueApplicationStatus(tx, input.interactionId);
	});
}

/** Отметка по пункту чек-листа текущей стадии. */
export async function setChecklistItem(
	ctx: ActorContext,
	input: SetChecklistItemInput
): Promise<void> {
	requirePermission(ctx, 'stages.transition');

	await withTransaction(ctx, async (tx) => {
		await lockInteractionOnSameRevision(ctx, tx, input.interactionId);
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
		await lockInteractionOnSameRevision(ctx, tx, input.interactionId);
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

/**
 * Подтверждение стадии: файлом, отметкой исполнителя или записью в LMS.
 *
 * Право отдельное от `stages.transition`: подтвердить стадию и двигать
 * взаимодействие — разные полномочия, и машинный субъект обмена имеет только
 * первое (`docs/access-matrix.md`, раздел 3).
 */
export async function confirmStage(ctx: ActorContext, input: ConfirmStageInput): Promise<void> {
	requirePermission(ctx, 'stages.confirm');

	const userId = actingUserId(ctx);

	await withTransaction(ctx, async (tx) => {
		await lockInteractionOnSameRevision(ctx, tx, input.interactionId);
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

/** Чем кончилась попытка засчитать факт обучения открытой стадии. */
export type LmsEvidenceOutcome = { confirmed: boolean; note: string };

/**
 * Факт системы обучения ложится на открытую запись стадии.
 *
 * Стадию это подтверждает, но никуда не двигает: переход — решение сотрудника,
 * и права `stages.transition` у машинного субъекта нет вовсе. Если открыта
 * другая стадия, сообщение всё равно принимается: факт уже сохранён историей
 * результатов и засчитается, когда взаимодействие дойдёт до нужной стадии
 * (`readStageState`).
 *
 * Зовётся из транзакции приёмника вместе с записью результата: «факт сохранён»
 * и «стадия подтверждена» обязаны случиться вместе или не случиться вовсе.
 */
export async function applyLmsEvidence(
	ctx: ActorContext,
	tx: Tx,
	input: { interactionId: string; evidence: LmsEvidence }
): Promise<LmsEvidenceOutcome> {
	requirePermission(ctx, 'stages.confirm');

	await lockInteraction(ctx, tx, input.interactionId);

	const entry = await readOpenEntryRow(tx, input.interactionId);

	if (entry === null) {
		return {
			confirmed: false,
			note: 'Взаимодействие не стоит ни на одной стадии: факт сохранён'
		};
	}

	if (!entry.stageSnapshot.requiresLmsData) {
		return {
			confirmed: false,
			note: `Стадия не подтверждена: взаимодействие на стадии «${entry.stageSnapshot.name}», данные обучения ей не требуются`
		};
	}

	// Подтверждение записью в системе обучения — то же самое, что ставит
	// сотрудник вручную видом `lms_record`: другого способа объяснить, чем
	// подтверждена стадия, в записи нет.
	const confirmation: StageConfirmation | null =
		entry.stageSnapshot.requiresConfirmation && entry.confirmation === null
			? {
					kind: 'lms_record',
					source: `${input.evidence.system}:${input.evidence.instance}`,
					recordId: input.evidence.groupExternalId
				}
			: entry.confirmation;

	await tx
		.update(stageEntries)
		.set({
			lmsEvidence: input.evidence,
			confirmation,
			...(confirmation !== null && entry.confirmation === null
				? { confirmedAt: now, confirmedBy: ctx.user?.id ?? null }
				: {}),
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
			details: { stageEntryId: entry.id }
		},
		tx
	);

	return {
		confirmed: true,
		note: `Стадия «${entry.stageSnapshot.name}» подтверждена данными системы обучения`
	};
}

/**
 * Отметка по документу ложится на открытую запись стадии.
 *
 * Стадию это подтверждает, но никуда не двигает: переход — отдельное решение
 * сотрудника. Если открыта другая стадия или отметка не та, которую стадия
 * ждёт, сообщение всё равно принимается: факт уже сохранён самим документом и
 * засчитается, когда взаимодействие дойдёт до нужной стадии
 * (`readCurrentDocumentMark`).
 *
 * Своей проверки прав здесь нет намеренно. Право произвести этот факт — это
 * право поставить отметку (`documents.write`), и оно уже проверено тем, кто
 * зовёт: иначе отметка по документу отказывала бы или нет в зависимости от
 * того, на какой стадии стоит дело, а ключ обмена с правом на документы не мог
 * бы отметить ни одного из них.
 *
 * Зовётся из транзакции отметки: «отметка поставлена» и «стадия подтверждена»
 * обязаны случиться вместе или не случиться вовсе.
 */
export async function applyDocumentMark(
	ctx: ActorContext,
	tx: Tx,
	input: { interactionId: string; evidence: DocumentMarkEvidence }
): Promise<void> {
	await lockInteraction(ctx, tx, input.interactionId);

	const entry = await readOpenEntryRow(tx, input.interactionId);

	if (entry === null || entry.stageSnapshot.requiresDocumentMark !== input.evidence.mark) {
		return;
	}

	// Подтверждение отметкой ставит движок, а не сотрудник: сам факт «документ
	// утверждён» и есть подтверждение стадии. Уже поставленное подтверждение не
	// переписывается — оно объясняет, чем стадию закрыли на самом деле.
	const confirmation: StageConfirmation | null =
		entry.stageSnapshot.requiresConfirmation && entry.confirmation === null
			? {
					kind: 'document_mark',
					documentId: input.evidence.documentId,
					mark: input.evidence.mark,
					markedAt: input.evidence.markedAt
				}
			: entry.confirmation;

	await tx
		.update(stageEntries)
		.set({
			documentMarkEvidence: input.evidence,
			confirmation,
			...(confirmation !== null && entry.confirmation === null
				? { confirmedAt: now, confirmedBy: ctx.user?.id ?? null }
				: {}),
			updatedAt: now
		})
		.where(eq(stageEntries.id, entry.id));

	await recordAuditEvent(
		ctx,
		{
			type: 'interactions.confirmed',
			outcome: 'success',
			subject: { type: 'interaction', id: input.interactionId },
			details: { stageEntryId: entry.id, documentId: input.evidence.documentId }
		},
		tx
	);
}

export async function raiseBlocker(
	ctx: ActorContext,
	input: RaiseBlockerInput
): Promise<{ id: string }> {
	requirePermission(ctx, 'interactions.write');

	const userId = actingUserId(ctx);

	return withTransaction(ctx, async (tx) => {
		// Помеха принадлежит взаимодействию, а не стадии: номер редакции здесь не
		// сверяется — публикация, прошедшая рядом, поводом отказать не является.
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
 * Смена владельца взаимодействия, в том числе сразу по нескольким записям из
 * списка. Идентификаторы блокируются в одном порядке: иначе две такие команды,
 * отданные навстречу друг другу, встали бы во взаимный замок.
 *
 * Право отдельное от `interactions.write`: передать чужую работу себе — не то
 * же самое, что вести свою, и решает это тот, кто отвечает за распределение
 * нагрузки. Исполнитель открытой записи стадии едет за владельцем: работа
 * перешла целиком, а не наполовину.
 *
 * `tx` передаёт тот, кто уже открыл транзакцию: передача незавершённых записей
 * при смене ответственного за вуз обязана происходить вместе с самой сменой, а
 * не рядом с ней.
 */
export async function setResponsible(
	ctx: ActorContext,
	input: SetResponsibleInput,
	tx?: Tx
): Promise<number> {
	requirePermission(ctx, 'interactions.reassign');

	const authorId = actingUserId(ctx);
	const ids = [...new Set(input.interactionIds)].sort();

	const write = async (executor: Tx): Promise<number> => {
		let changed = 0;

		for (const interactionId of ids) {
			const interaction = await lockInteraction(ctx, executor, interactionId);

			if (interaction.ownerUserId === input.userId) {
				continue;
			}

			await executor
				.update(interactions)
				.set({ ownerUserId: input.userId, lastActivityAt: now, updatedAt: now })
				.where(eq(interactions.id, interactionId));

			const entry = await readOpenEntryRow(executor, interactionId);

			if (entry !== null) {
				await executor
					.update(stageEntries)
					.set({ responsibleUserId: input.userId, updatedAt: now })
					.where(eq(stageEntries.id, entry.id));
			}

			await executor.insert(interactionChanges).values({
				interactionId,
				authorId,
				field: 'ownerUserId',
				oldValue: interaction.ownerUserId,
				newValue: input.userId
			});

			await recordAuditEvent(
				ctx,
				{
					type: 'interactions.owner_changed',
					outcome: 'success',
					subject: { type: 'interaction', id: interactionId },
					details: { userId: input.userId }
				},
				executor
			);

			// Ответственный виден заявителю на сайте: снимок статуса уходит той же
			// транзакцией, что и смена владельца.
			await enqueueApplicationStatus(executor, interactionId);

			changed += 1;
		}

		return changed;
	};

	return tx === undefined ? withTransaction(ctx, write) : write(tx);
}

/**
 * Комментарий к взаимодействию. `tx` передаёт тот, кто уже открыл транзакцию:
 * первый комментарий заявки с сайта пишется в той же операции, что и сама
 * заявка, — своей транзакции вложенный вызов не начинает.
 *
 * Источник текста в схему запроса не входит и прийти снаружи не может:
 * «это написал заявитель» — утверждение системы о происхождении текста, и
 * клиент, который выставил бы его себе сам, отдал бы чужой комментарий на
 * уничтожение вместе с данными человека.
 */
export async function addComment(
	ctx: ActorContext,
	input: CreateCommentInput & { source?: CommentSource },
	tx?: Tx
): Promise<{ id: string }> {
	requirePermission(ctx, 'interactions.write');

	const authorId = actingUserId(ctx);

	const write = async (executor: Tx): Promise<{ id: string }> => {
		await lockInteraction(ctx, executor, input.interactionId);

		const [comment] = await executor
			.insert(comments)
			.values({
				interactionId: input.interactionId,
				authorId,
				body: input.body,
				source: input.source ?? 'manual'
			})
			.returning({ id: comments.id });

		await touchInteraction(executor, input.interactionId);

		await recordAuditEvent(
			ctx,
			{
				type: 'interactions.commented',
				outcome: 'success',
				subject: { type: 'interaction', id: input.interactionId },
				details: { commentId: comment.id }
			},
			executor
		);

		return comment;
	};

	return tx === undefined ? withTransaction(ctx, write) : write(tx);
}

/**
 * Закрытие взаимодействия: завершение и отмена.
 *
 * Это не шаг по процессу, поэтому чек-лист здесь не проверяется: его проверяет
 * переход, а закрытие фиксирует исход. Но «обязательства исполнены» не должно
 * доказываться нажатием кнопки: если финальная стадия требует результата,
 * подтверждения или данных обучения, завершение без них отклоняется теми же
 * словами, что и переход вперёд. Досрочное закрытие — закрытие не с финальной
 * стадии — разрешает только право настраивать процесс и только с объяснением.
 */

type ClosingState = {
	status: InteractionStatus;
	/** Где стоим: на финальной стадии, раньше неё или нигде. */
	openStage: 'final' | 'earlier' | null;
	/** Чего не хватает финальной стадии — по фразе на требование. */
	missingEvidence: string[];
	canWrite: boolean;
	canForce: boolean;
};

/**
 * Правило закрытия в одном месте: его спрашивает карточка, чтобы нарисовать
 * кнопку и объяснить отказ, и оно же перепроверяется внутри команды под
 * блокировкой строки.
 */
function closingVerdict(state: ClosingState): InteractionClosingView {
	const shared: string[] = [];

	if (!state.canWrite) {
		shared.push('Недостаточно прав: требуется «interactions.write»');
	}

	if (state.status === 'completed') {
		shared.push('Взаимодействие уже завершено');
	} else if (state.status === 'cancelled') {
		shared.push('Взаимодействие уже отменено');
	}

	if (state.openStage === null) {
		shared.push('Взаимодействие не стоит ни на одной стадии');
	}

	const complete = [...shared];
	const requiresForce = state.openStage === 'earlier';

	if (requiresForce && !state.canForce) {
		complete.push(
			'Взаимодействие не дошло до финальной стадии процесса: закрыть его досрочно может только тот, кто настраивает процесс'
		);
	}

	// Требования финальной стадии проверяются только при штатном завершении:
	// досрочное закрытие — это признание, что обязательства не исполнены, и
	// требовать доказательств исполнения там значило бы запереть отказ.
	if (state.openStage === 'final') {
		complete.push(...state.missingEvidence);
	}

	return {
		complete: { allowed: complete.length === 0, requiresForce, reasons: complete },
		cancel: { allowed: shared.length === 0, reasons: shared }
	};
}

/**
 * Чего не хватает стадии, чтобы считать её исполненной. Те же вопросы, что
 * задаёт `evaluateTransition` на шаге вперёд, и теми же словами: доказательство
 * исполнения не зависит от того, уходят со стадии дальше или закрывают дело.
 */
export function missingStageEvidence(entry: {
	stageSnapshot: StageSnapshot;
	resultText: string | null;
	confirmation: StageConfirmation | null;
	/** Снимок записи стадии либо факт по взаимодействию, если снимка ещё нет. */
	lmsEvidence: unknown;
	/** Отметка по документу дела — так же: снимок записи либо отметка по делу. */
	documentMarkEvidence: DocumentMarkEvidence | null;
}): string[] {
	const missing: string[] = [];

	if (entry.stageSnapshot.requiresResult && (entry.resultText ?? '').trim() === '') {
		missing.push('У стадии не записан результат');
	}

	if (entry.stageSnapshot.requiresConfirmation && entry.confirmation === null) {
		missing.push('Стадия не подтверждена');
	}

	if (entry.stageSnapshot.requiresLmsData && entry.lmsEvidence === null) {
		missing.push('По стадии не получены данные системы обучения');
	}

	const requiredMark = entry.stageSnapshot.requiresDocumentMark;

	if (requiredMark !== null && entry.documentMarkEvidence?.mark !== requiredMark) {
		missing.push(
			`По стадии нет документа с отметкой «${DOCUMENT_STATUS_FACT_LABELS[requiredMark]}»`
		);
	}

	return missing;
}

async function readClosingState(
	ctx: ActorContext,
	executor: Executor,
	interaction: { id: string }
): Promise<ClosingState> {
	const [row] = await executor
		.select({ status: interactions.status })
		.from(interactions)
		.where(eq(interactions.id, interaction.id))
		.limit(1);

	if (row === undefined) {
		throw new NotFoundError('Взаимодействие не найдено');
	}

	const entry = await readOpenEntryRow(executor, interaction.id);
	// Тот же вопрос, что и у перехода: факт, пришедший из системы обучения до
	// входа на стадию, засчитывается и при закрытии. Отметка по документу — так
	// же.
	const evidence =
		entry === null || entry.lmsEvidence !== null
			? null
			: await readLmsEvidence(executor, interaction.id);
	const mark =
		entry === null
			? null
			: await readCurrentDocumentMark(executor, entry, entry.stageSnapshot.requiresDocumentMark);

	return {
		status: row.status,
		openStage: entry === null ? null : entry.stageSnapshot.isFinal ? 'final' : 'earlier',
		missingEvidence:
			entry === null
				? []
				: missingStageEvidence({
						...entry,
						lmsEvidence: entry.lmsEvidence ?? evidence,
						documentMarkEvidence: mark
					}),
		canWrite: can(ctx, 'interactions.write'),
		canForce: can(ctx, 'stages.configure')
	};
}

/** Приговор по закрытию для карточки. Ничего не меняет. */
export async function getInteractionClosing(
	ctx: ActorContext,
	interactionId: string
): Promise<InteractionClosingView> {
	requirePermission(ctx, 'interactions.read');

	const db = getDb();
	const [row] = await db
		.select({ id: interactions.id })
		.from(interactions)
		.where(and(eq(interactions.id, interactionId), interactionScopeFilter(ctx)))
		.limit(1);

	if (row === undefined) {
		throw new NotFoundError('Взаимодействие не найдено');
	}

	return closingVerdict(await readClosingState(ctx, db, row));
}

/** Закрывает открытую запись стадии вместе с её паузой. */
async function closeOpenStage(
	tx: Tx,
	entry: typeof stageEntries.$inferSelect,
	outcome: 'completed' | null,
	outcomeReason: string | null
): Promise<void> {
	await tx
		.update(stageEntries)
		.set({ leftAt: now, outcome, outcomeReason, updatedAt: now })
		.where(eq(stageEntries.id, entry.id));

	await closeOpenPause(tx, entry.id);
}

export async function completeInteraction(
	ctx: ActorContext,
	input: CompleteInteractionInput
): Promise<void> {
	requirePermission(ctx, 'interactions.write');

	await withTransaction(ctx, async (tx) => {
		const interaction = await lockInteraction(ctx, tx, input.interactionId);
		// Тот же механизм, что у перехода: «завершить» нажимают, посмотрев на
		// финальную стадию и её требования, и публикация, прошедшая до нажатия,
		// меняет и то и другое.
		await requireCurrentRevision(tx, interaction.workspaceId, input.revision, 'завершение');

		const state = await readClosingState(ctx, tx, interaction);
		const verdict = closingVerdict(state);

		if (!verdict.complete.allowed) {
			throw new ConflictError(`Завершить нельзя. ${verdict.complete.reasons.join('; ')}`);
		}

		// Досрочное закрытие обязано быть намеренным: право у вызывающего есть,
		// но команда всё равно требует сказать об этом явно.
		if (verdict.complete.requiresForce && !input.force) {
			throw new ConflictError(
				'Взаимодействие стоит не на финальной стадии процесса: закрыть его можно только досрочно, с объяснением'
			);
		}

		const entry = await requireOpenEntry(tx, input.interactionId);

		await closeOpenStage(tx, entry, 'completed', input.summary);

		await tx
			.update(interactions)
			.set({ status: 'completed', lastActivityAt: now, updatedAt: now })
			.where(eq(interactions.id, input.interactionId));

		await recordAuditEvent(
			ctx,
			{
				type: 'interactions.completed',
				outcome: 'success',
				subject: { type: 'interaction', id: input.interactionId },
				details: { stageEntryId: entry.id }
			},
			tx
		);

		await enqueueApplicationStatus(tx, input.interactionId);
	});
}

export async function cancelInteraction(
	ctx: ActorContext,
	input: CancelInteractionInput
): Promise<void> {
	requirePermission(ctx, 'interactions.write');

	await withTransaction(ctx, async (tx) => {
		const interaction = await lockInteraction(ctx, tx, input.interactionId);
		await requireCurrentRevision(tx, interaction.workspaceId, input.revision, 'отмену');

		const verdict = closingVerdict(await readClosingState(ctx, tx, interaction));

		if (!verdict.cancel.allowed) {
			throw new ConflictError(`Отменить нельзя. ${verdict.cancel.reasons.join('; ')}`);
		}

		const entry = await requireOpenEntry(tx, input.interactionId);

		// Исход записи остаётся пустым: стадию не прошли и не пропустили, работу
		// на ней прекратили. Почему — в причине рядом.
		await closeOpenStage(tx, entry, null, input.reason);

		await tx
			.update(interactions)
			.set({ status: 'cancelled', lastActivityAt: now, updatedAt: now })
			.where(eq(interactions.id, input.interactionId));

		await recordAuditEvent(
			ctx,
			{
				type: 'interactions.cancelled',
				outcome: 'success',
				subject: { type: 'interaction', id: input.interactionId },
				details: { stageEntryId: entry.id }
			},
			tx
		);

		await enqueueApplicationStatus(tx, input.interactionId);
	});
}
