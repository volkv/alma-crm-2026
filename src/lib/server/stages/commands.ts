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
 *
 * Эти же команды и помеха несут запись стадии, открытую у человека в форме
 * (`stageEntryId`), и сверяют её с открытой под блокировкой: результат,
 * набранный на прежней стадии, не ложится в новую, даже если это возврат на ту
 * же самую стадию.
 */
import { and, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type {
	AdvanceStageInput,
	CancelInteractionInput,
	ChecklistState,
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
import { isFactItem } from '$lib/contracts/interactions';
import { checklistRule } from '$lib/platform/checklist-rules';
import type { AuditEventType } from '$lib/contracts/audit';
import {
	DOCUMENT_STATUS_FACT_LABELS,
	type DocumentMarkEvidence,
	type DocumentTemplateKey
} from '$lib/contracts/documents';
import {
	isTrainingCompleted,
	LEARNING_PURPOSE_LABELS,
	type LmsEvidence
} from '$lib/contracts/exchange';
import { PAYMENT_CHECKLIST_KEY } from '$lib/contracts/payments';
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
import { assertMayWorkIn } from '../rbac/workspaces';
import { withTransaction, type Tx } from '../db/transaction';
import { queueStageEnterNotice } from '../notifications/stage-enter';
import { publishAfterCommit } from '../live/publish';
import { checkMentions, queueMentions } from '../mentions';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../errors';
import { readDocumentMark } from '../documents/evidence';
import { groupCountsForStage, readLmsEvidence } from '../integrations/exchange/evidence';
import { enqueueApplicationStatus } from '../integrations/exchange/outbox';
import { hasPaymentFact } from '../integrations/exchange/payments';
import { can, requirePermission } from '../rbac';
import { interactionScopeFilter } from '../interactions/access';
import { nextEdit } from '../interactions/edit-version';
import { recordModuleFactIn } from '../platform/module-facts';
import { checkEntryFacts, type EntryFacts } from './facts';
import {
	firstStage,
	keptChecklistMarks,
	requireActiveRevisionForWorkspace,
	stageSnapshot
} from './process';
import {
	evaluateTransition,
	LMS_NOT_COMPLETED,
	transitionPermission,
	type StageState
} from './transitions';

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

type LockedInteraction = { id: string; workspaceId: string; ownerUserId: string | null };

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

/**
 * Отказ команде, отданной по записи стадии, которой уже нет. Введённое остаётся
 * в форме: теряется только нажатие кнопки.
 */
const STAGE_CHANGED = 'Стадия уже сменилась — обновите карточку, ваш ввод сохранён';

/**
 * Открытая запись стадии — ровно та, что была открыта у человека в форме.
 * Читается под блокировкой строки взаимодействия: переход коллеги, прошедший
 * раньше, уже закрыл прежнюю запись.
 */
async function requireExpectedEntry(
	tx: Tx,
	interactionId: string,
	stageEntryId: string
): Promise<typeof stageEntries.$inferSelect> {
	const entry = await requireOpenEntry(tx, interactionId);

	if (entry.id !== stageEntryId) {
		throw new ConflictError(STAGE_CHANGED);
	}

	return entry;
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

/**
 * Что команда перехода кладёт в запись вместе с уходом: ручные отметки и
 * результат. Пункты-факты считаются уже с ними — результат, записанный той же
 * командой, закрывает «Зафиксированы договорённости», а отметка об оплате —
 * «Договор заключён».
 */
type EntryOverrides = { checklistState: ChecklistState; resultText: string | null };

function overridesOf(entry: typeof stageEntries.$inferSelect): EntryOverrides {
	return { checklistState: entry.checklistState, resultText: entry.resultText };
}

/** Пункты-факты открытой записи с данными дела на момент вопроса. */
function readEntryFacts(
	executor: Executor,
	entry: typeof stageEntries.$inferSelect,
	overrides: EntryOverrides = overridesOf(entry)
): Promise<EntryFacts> {
	return checkEntryFacts(executor, {
		id: entry.id,
		interactionId: entry.interactionId,
		enteredAt: entry.enteredAt,
		resultText: overrides.resultText,
		checklistState: overrides.checklistState,
		snapshot: entry.stageSnapshot
	});
}

/**
 * Отметки, с которыми запись закрывается: ручные и результат проверки каждого
 * пункта-факта. Закрытую запись больше не пересчитывают (`frozenFacts`).
 */
function withFrozenFacts(marks: ChecklistState, facts: EntryFacts): ChecklistState {
	return {
		...marks,
		...Object.fromEntries(Object.entries(facts).map(([key, fact]) => [key, fact.done]))
	};
}

/** Состояние стадии в объёме правил перехода. */
async function readStageState(
	tx: Tx,
	entry: typeof stageEntries.$inferSelect,
	overrides: EntryOverrides = overridesOf(entry)
): Promise<StageState> {
	const [paused, blocking, evidence, mark, facts] = await Promise.all([
		hasOpenPause(tx, entry.id),
		countBlockingBlockers(tx, entry.interactionId),
		// Факт, пришедший до входа на стадию, засчитывается: система обучения
		// присылает результат по своему расписанию, а не по нашему процессу
		// (`docs/exchange-contract.md`, раздел 6). Снимок записи сильнее: он уже
		// объяснил подтверждение именно этой стадии.
		entry.lmsEvidence === null
			? readLmsEvidence(tx, entry.interactionId, entry.stageSnapshot.lmsGroupPurposes)
			: null,
		// То же и с отметкой по документу. Снимок на записи есть почти всегда —
		// его кладут и вход на стадию, и сама отметка, — а прочитать заново
		// приходится там, где требование включили публикацией уже под открытой
		// записью: документ отмечен, а снимка на ней нет.
		readCurrentDocumentMark(tx, entry),
		readEntryFacts(tx, entry, overrides)
	]);

	return {
		stageId: entry.stageId,
		snapshot: entry.stageSnapshot,
		checklistState: overrides.checklistState,
		facts,
		resultText: overrides.resultText,
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
	entry: {
		interactionId: string;
		stageSnapshot: StageSnapshot;
		documentMarkEvidence: DocumentMarkEvidence | null;
	}
): Promise<DocumentMarkEvidence | null> {
	const requiredMark = entry.stageSnapshot.requiresDocumentMark;

	if (requiredMark === null) {
		return entry.documentMarkEvidence;
	}

	// Снимок на записи кладут только те, кто уже сверил шаблон: вход на стадию,
	// сама отметка и публикация процесса.
	if (entry.documentMarkEvidence?.mark === requiredMark) {
		return entry.documentMarkEvidence;
	}

	return readDocumentMark(
		executor,
		entry.interactionId,
		requiredMark,
		entry.stageSnapshot.requiresDocumentTemplate
	);
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

	await queueStageEnterNotice(ctx, tx, {
		interactionId: interaction.id,
		stageEntryId: entry.id,
		stageName: stage.name,
		target: stage.onEnterNotify,
		ownerUserId: interaction.ownerUserId
	});

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

		rejectFactMarks(entry.stageSnapshot, input.checklistState ?? {});

		const checklistState = { ...entry.checklistState, ...(input.checklistState ?? {}) };
		const resultText =
			input.resultText !== null && input.resultText !== undefined && input.resultText !== ''
				? input.resultText
				: entry.resultText;
		const state = await readStageState(tx, entry, { checklistState, resultText });
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
				: await readDocumentMark(
						tx,
						input.interactionId,
						target.requiresDocumentMark,
						target.requiresDocumentTemplate
					);
		const [left] = await tx
			.update(stageEntries)
			.set({
				// Со стадии уходят с тем, что на ней было: ручные отметки и
				// результат проверки каждого пункта-факта. Закрытая запись дальше
				// не пересчитывается — данные дела могут измениться, а история
				// стадии нет (`frozenFacts` в `facts.ts`).
				checklistState: withFrozenFacts(checklistState, state.facts),
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
				documentMarkEvidence: targetMark,
				...(await lmsEntryPatch(tx, input.interactionId, stageSnapshot(target))),
				checklistState: {
					...(await earlierMarks(tx, input.interactionId, stageSnapshot(target))),
					...(await paymentEntryPatch(tx, input.interactionId, stageSnapshot(target)))
				}
			})
			.returning({ id: stageEntries.id });

		await touchInteraction(tx, input.interactionId);
		publishAfterCommit(tx, input.interactionId, { type: 'interaction.changed' });

		// Уведомление при входе — той же транзакцией, что и сам вход: откатится
		// переход, не останется и письма о нём.
		await queueStageEnterNotice(ctx, tx, {
			interactionId: input.interactionId,
			stageEntryId: next.id,
			stageName: target.name,
			target: target.onEnterNotify,
			ownerUserId: interaction.ownerUserId
		});

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
		const entry = await requireExpectedEntry(tx, input.interactionId, input.stageEntryId);

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
		publishAfterCommit(tx, input.interactionId, { type: 'interaction.changed' });

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
		const entry = await requireExpectedEntry(tx, input.interactionId, input.stageEntryId);

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
		publishAfterCommit(tx, input.interactionId, { type: 'interaction.changed' });

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

/**
 * Отметка по пункту чек-листа открытой записи стадии — на транзакции вызывающего.
 *
 * `stageEntryId` — запись, которая была открыта у человека в форме: отметка,
 * поставленная на прежней стадии, в новую не ложится. Без него отметка
 * ложится на ту запись, что открыта сейчас, — так её ставит факт, пришедший
 * из обмена, у которого формы нет.
 */
async function writeChecklistItem(
	ctx: ActorContext,
	tx: Tx,
	input: {
		interactionId: string;
		key: string;
		done: boolean;
		stageEntryId: string | null;
		/**
		 * Что делать с пунктом-фактом: отметка человека на него — отказ
		 * (`reject`), машинная отметка по факту обмена — не нужна вовсе (`skip`):
		 * такой пункт уже закрывают данные дела.
		 */
		onFact: 'reject' | 'skip';
	}
): Promise<void> {
	requirePermission(ctx, 'stages.transition');

	await lockInteractionOnSameRevision(ctx, tx, input.interactionId);
	const entry =
		input.stageEntryId === null
			? await requireOpenEntry(tx, input.interactionId)
			: await requireExpectedEntry(tx, input.interactionId, input.stageEntryId);

	// Пункт берётся из слепка стадии: чек-лист, который можно дополнить из
	// браузера произвольным ключом, ничего не гарантирует.
	if (!entry.stageSnapshot.checklist.some((item) => item.key === input.key)) {
		throw new ValidationError('В чек-листе стадии нет такого пункта', [input.key]);
	}

	if (
		input.onFact === 'skip' &&
		entry.stageSnapshot.checklist.some((item) => item.key === input.key && isFactItem(item))
	) {
		return;
	}

	rejectFactMarks(entry.stageSnapshot, { [input.key]: input.done });

	await tx
		.update(stageEntries)
		.set({
			checklistState: { ...entry.checklistState, [input.key]: input.done },
			updatedAt: now
		})
		.where(eq(stageEntries.id, entry.id));

	await touchInteraction(tx, input.interactionId);
	publishAfterCommit(tx, input.interactionId, { type: 'interaction.changed' });

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
}

/** Отметка по пункту чек-листа текущей стадии. */
export async function setChecklistItem(
	ctx: ActorContext,
	input: SetChecklistItemInput
): Promise<void> {
	await withTransaction(ctx, async (tx) => {
		const before = await readOpenChecklistMark(tx, input.interactionId, input.key);

		await writeChecklistItem(ctx, tx, {
			interactionId: input.interactionId,
			key: input.key,
			done: input.done,
			stageEntryId: input.stageEntryId,
			onFact: 'reject'
		});

		// Оплата, отмеченная рукой, — деньги, а не галочка процесса: в ленте она
		// стоит рядом с оплатой с сайта, с автором и временем. Строку истории
		// пишет только человек, как и у правки плана.
		if (input.key === PAYMENT_CHECKLIST_KEY && before !== input.done && ctx.user !== null) {
			await recordModuleFactIn(ctx, tx, {
				interactionId: input.interactionId,
				module: 'payment',
				fact: 'manual_mark',
				text: input.done
					? 'Оплата отмечена вручную: «Оплата получена»'
					: 'Отметка «Оплата получена» снята'
			});
		}
	});
}

/** Отметка пункта на открытой записи до правки; `false` — не отмечен. */
async function readOpenChecklistMark(tx: Tx, interactionId: string, key: string): Promise<boolean> {
	const [entry] = await tx
		.select({ state: stageEntries.checklistState })
		.from(stageEntries)
		.where(and(eq(stageEntries.interactionId, interactionId), isNull(stageEntries.leftAt)))
		.limit(1);

	return entry?.state[key] === true;
}

/**
 * Отметить пункт чек-листа открытой стадии в транзакции вызывающего: факт,
 * пришедший не из формы карточки (оплата с сайта), и отметка о нём обязаны
 * случиться вместе или не случиться вовсе. Пункта нет в чек-листе открытой
 * стадии — отказ, как у отметки из карточки. Процесс сделал пункт фактом —
 * отметка не ставится: его закрывают данные дела, а не обмен.
 */
export async function markChecklistItemIn(
	ctx: ActorContext,
	tx: Tx,
	interactionId: string,
	key: string
): Promise<void> {
	await writeChecklistItem(ctx, tx, {
		interactionId,
		key,
		done: true,
		stageEntryId: null,
		onFact: 'skip'
	});
}

export async function setStageResult(ctx: ActorContext, input: SetStageResultInput): Promise<void> {
	requirePermission(ctx, 'stages.transition');

	await withTransaction(ctx, async (tx) => {
		await lockInteractionOnSameRevision(ctx, tx, input.interactionId);
		const entry = await requireExpectedEntry(tx, input.interactionId, input.stageEntryId);

		await tx
			.update(stageEntries)
			.set({ resultText: input.resultText, updatedAt: now })
			.where(eq(stageEntries.id, entry.id));

		await touchInteraction(tx, input.interactionId);
		publishAfterCommit(tx, input.interactionId, { type: 'interaction.changed' });

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
		const entry = await requireExpectedEntry(tx, input.interactionId, input.stageEntryId);

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
		publishAfterCommit(tx, input.interactionId, { type: 'interaction.changed' });

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
 * Подтверждение, которое ставит сам факт обучения: итог из системы обучения —
 * запись в ней (`lms_record`), отметка сотрудника — отметка ответственного.
 * Другого способа объяснить, чем подтверждена стадия, в записи нет.
 */
function lmsConfirmation(evidence: LmsEvidence): StageConfirmation {
	return evidence.kind === 'result'
		? {
				kind: 'lms_record',
				source: `${evidence.system}:${evidence.instance}`,
				recordId: evidence.groupExternalId
			}
		: { kind: 'mark', byUserId: evidence.markedByUserId, at: evidence.markedAt };
}

/**
 * Снимок факта обучения для записи, на которую взаимодействие входит.
 *
 * Итог, пришедший до входа на стадию, засчитывается сразу при входе: система
 * обучения присылает результат по своему расписанию, а не по нашему процессу.
 * Снимок кладётся в запись, а не только вычисляется на лету, — иначе сводка и
 * доска, читающие запись, показывали бы «обучение не завершено» там, где
 * переход уже разрешён.
 */
async function lmsEntryPatch(
	tx: Tx,
	interactionId: string,
	snapshot: StageSnapshot
): Promise<{
	lmsEvidence?: LmsEvidence;
	confirmation?: StageConfirmation;
	confirmedAt?: typeof now;
	confirmedBy?: string;
}> {
	if (!snapshot.requiresLmsData) {
		return {};
	}

	const evidence = await readLmsEvidence(tx, interactionId, snapshot.lmsGroupPurposes);

	if (evidence === null) {
		return {};
	}

	if (!snapshot.requiresConfirmation) {
		return { lmsEvidence: evidence };
	}

	// Итог из системы обучения подписывает не человек; отметку — её автор.
	return {
		lmsEvidence: evidence,
		confirmation: lmsConfirmation(evidence),
		confirmedAt: now,
		...(evidence.kind === 'manual' ? { confirmedBy: evidence.markedByUserId } : {})
	};
}

/**
 * Отметка об оплате для записи, на которую взаимодействие входит.
 *
 * Оплата с сайта приходит тогда, когда её загрузили, а не когда дело дошло до
 * стадии договора: загрузка стадию не двигает (стадию меняет только человек) и
 * хранит сам факт. Засчитывается он при входе — пункт `payment_received`
 * новой записи уже отмечен, если в её чек-листе такой пункт есть, а факт оплаты
 * по делу сохранён.
 */
async function paymentEntryPatch(
	tx: Tx,
	interactionId: string,
	snapshot: StageSnapshot
): Promise<ChecklistState> {
	if (!snapshot.checklist.some((item) => item.key === PAYMENT_CHECKLIST_KEY)) {
		return {};
	}

	return (await hasPaymentFact(tx, interactionId)) ? { [PAYMENT_CHECKLIST_KEY]: true } : {};
}

/**
 * Ручные отметки, с которыми дело возвращается на стадию, где уже было.
 *
 * Возврат — выход из тупика, а не отмена сделанного: пункты, которые отметили
 * при прошлом проходе, остаются отмеченными, если стадия спрашивает о той же
 * работе — тот же ключ, та же подпись и тот же способ закрытия
 * (`keptChecklistMarks`). Изменённый публикацией пункт начинается заново:
 * отметка отвечала на другой вопрос. Пункты-факты не переносятся — их считают
 * данные дела.
 */
async function earlierMarks(
	tx: Tx,
	interactionId: string,
	snapshot: StageSnapshot
): Promise<ChecklistState> {
	const [earlier] = await tx
		.select({ snapshot: stageEntries.stageSnapshot, checklistState: stageEntries.checklistState })
		.from(stageEntries)
		.where(
			and(
				eq(stageEntries.interactionId, interactionId),
				isNotNull(stageEntries.leftAt),
				sql`${stageEntries.stageSnapshot}->>'key' = ${snapshot.key}`
			)
		)
		.orderBy(desc(stageEntries.leftAt))
		.limit(1);

	return earlier === undefined
		? {}
		: keptChecklistMarks(earlier.snapshot.checklist, snapshot.checklist, earlier.checklistState);
}

/**
 * Пункт-факт закрывают данные дела, и отметка на него — не выполнение, а
 * подмена: отказ, а не молчаливый пропуск, иначе форма, приславшая отметку,
 * считала бы пункт закрытым.
 */
function rejectFactMarks(snapshot: StageSnapshot, marks: ChecklistState): void {
	const facts = snapshot.checklist.filter(
		(item) => isFactItem(item) && marks[item.key] !== undefined
	);

	if (facts.length > 0) {
		throw new ValidationError('Этот пункт закрывают данные дела, а не отметка', [
			...facts.map(
				(item) => `«${item.label}» выполняется данными дела, отметить его вручную нельзя`
			)
		]);
	}
}

/**
 * Факт завершения обучения ложится на открытую запись стадии.
 *
 * Засчитывается не всякий факт, а только тот, что **завершает** обучение по
 * **нужной группе**: итоговый результат (завершили больше нуля и есть дата
 * окончания) или отметка сотрудника — по группе этого взаимодействия, чья
 * программа входит в его программы. Промежуточный результат — это «данные
 * получены»: он сохранён историей и виден на карточке, но стадию не
 * подтверждает.
 *
 * Стадию это подтверждает, но никуда не двигает: переход — решение сотрудника,
 * и права `stages.transition` у машинного субъекта нет вовсе. Если открыта
 * другая стадия, факт всё равно сохранён и засчитается, когда взаимодействие
 * дойдёт до нужной стадии (`lmsEntryPatch`, `readStageState`).
 *
 * Стадия, уже подтверждённая итогом обучения, второй раз не подтверждается:
 * повтор результата и следующий итог по другому потоку не плодят ни записей
 * журнала, ни новых снимков — снимок объясняет, чем стадию закрыли первым.
 *
 * Зовётся из транзакции приёмника или отметки вместе с записью факта: «факт
 * сохранён» и «стадия подтверждена» обязаны случиться вместе или не случиться
 * вовсе.
 */
export async function applyLmsEvidence(
	ctx: ActorContext,
	tx: Tx,
	input: { interactionId: string; evidence: LmsEvidence }
): Promise<LmsEvidenceOutcome> {
	requirePermission(ctx, 'stages.confirm');

	await lockInteraction(ctx, tx, input.interactionId);

	if (!isTrainingCompleted(input.evidence)) {
		return {
			confirmed: false,
			note: 'Данные обучения получены, но обучение не завершено: нет завершивших или даты окончания — стадию подтвердит итоговый результат'
		};
	}

	if (!(await groupCountsForStage(tx, input.interactionId, input.evidence.learningGroupId, null))) {
		return {
			confirmed: false,
			note: 'Стадия не подтверждена: программа группы не входит в программы взаимодействия'
		};
	}

	const entry = await readOpenEntryRow(tx, input.interactionId);

	if (entry === null) {
		return {
			confirmed: false,
			note: 'Взаимодействие не стоит ни на одной стадии: факт сохранён'
		};
	}

	if (!entry.stageSnapshot.requiresLmsData) {
		const closed = await awaitedStreamItems(tx, input, entry.stageSnapshot);

		return {
			confirmed: false,
			note:
				closed.length === 0
					? `Стадия не подтверждена: взаимодействие на стадии «${entry.stageSnapshot.name}», данные обучения ей не требуются`
					: `Итог принят: закрыт пункт ${closed.map((label) => `«${label}»`).join(', ')} стадии «${entry.stageSnapshot.name}». Стадию подтверждает ответственный — итог обучения её не заменяет`
		};
	}

	if (entry.lmsEvidence !== null) {
		return {
			confirmed: false,
			note: `Стадия «${entry.stageSnapshot.name}» уже подтверждена итогом обучения: факт сохранён, подтверждение прежнее`
		};
	}

	const purposes = entry.stageSnapshot.lmsGroupPurposes;

	if (
		purposes !== null &&
		!(await groupCountsForStage(tx, input.interactionId, input.evidence.learningGroupId, purposes))
	) {
		return {
			confirmed: false,
			note: `Стадия «${entry.stageSnapshot.name}» не подтверждена: её подтверждает итог группы с назначением «${purposes
				.map((purpose) => LEARNING_PURPOSE_LABELS[purpose])
				.join('» или «')}», а у этой группы назначение другое`
		};
	}

	const confirmation: StageConfirmation | null =
		entry.stageSnapshot.requiresConfirmation && entry.confirmation === null
			? lmsConfirmation(input.evidence)
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
			details: { stageEntryId: entry.id, learningGroupId: input.evidence.learningGroupId }
		},
		tx
	);

	return {
		confirmed: true,
		note: `Стадия «${entry.stageSnapshot.name}» подтверждена: обучение завершено`
	};
}

/**
 * Пункты-факты стадии, которые закрывает итог потока этой группы (правило с
 * `closedByResult`, например `teachers_training_completed`). Стадия без требования
 * данных обучения итогом не подтверждается, но её пункт итог закрывает — и
 * ответ системе обучения называет его, а не «данные не требуются».
 */
async function awaitedStreamItems(
	tx: Tx,
	input: { interactionId: string; evidence: LmsEvidence },
	snapshot: StageSnapshot
): Promise<string[]> {
	const labels: string[] = [];

	for (const item of snapshot.checklist) {
		const rule = isFactItem(item) ? checklistRule(item.completion.rule) : undefined;
		const purpose = rule?.closedByResult === true ? rule.purpose : undefined;

		if (
			purpose !== undefined &&
			(await groupCountsForStage(tx, input.interactionId, input.evidence.learningGroupId, [
				purpose
			]))
		) {
			labels.push(item.label);
		}
	}

	return labels;
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
	input: {
		interactionId: string;
		/** Шаблон отмеченного документа; `null` — загружен руками. */
		templateKey: DocumentTemplateKey | null;
		evidence: DocumentMarkEvidence;
	}
): Promise<void> {
	await lockInteraction(ctx, tx, input.interactionId);

	const entry = await readOpenEntryRow(tx, input.interactionId);

	if (entry === null || entry.stageSnapshot.requiresDocumentMark !== input.evidence.mark) {
		return;
	}

	const requiredTemplate = entry.stageSnapshot.requiresDocumentTemplate;

	if (requiredTemplate !== null && requiredTemplate !== input.templateKey) {
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
		// Запись стадии сверяется: помеха о прежней стадии на новой — ложь.
		await lockInteraction(ctx, tx, input.interactionId);
		const entry = await requireExpectedEntry(tx, input.interactionId, input.stageEntryId);

		const [blocker] = await tx
			.insert(blockers)
			.values({
				interactionId: input.interactionId,
				stageEntryId: entry.id,
				reasonCode: input.reasonCode,
				description: input.description,
				blocksTransition: input.blocksTransition,
				raisedBy: userId,
				assigneeUserId: input.assigneeUserId
			})
			.returning({ id: blockers.id });

		await touchInteraction(tx, input.interactionId);
		publishAfterCommit(tx, input.interactionId, { type: 'interaction.changed' });

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
		publishAfterCommit(tx, existing.interactionId, { type: 'interaction.changed' });

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

			// Новый владелец обязан работать в пространстве записи: иначе работа
			// уходит к тому, кто её не видит.
			const [workspace] = await executor
				.select({ id: workspaces.id, name: workspaces.name })
				.from(workspaces)
				.where(eq(workspaces.id, interaction.workspaceId));

			await assertMayWorkIn(executor, input.userId, workspace);

			await executor
				.update(interactions)
				.set({
					ownerUserId: input.userId,
					// Ответственный — поле плана: открытая форма, отправленная после
					// передачи, получит отказ, а не вернёт прежнего владельца.
					...nextEdit(interactions.editVersion, { via: 'user', userId: authorId }),
					lastActivityAt: now,
					updatedAt: now
				})
				.where(eq(interactions.id, interactionId));
			publishAfterCommit(executor, interactionId, { type: 'interaction.changed' });

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
	const source = input.source ?? 'manual';

	const write = async (executor: Tx): Promise<{ id: string }> => {
		await lockInteraction(ctx, executor, input.interactionId);

		// Повтор того же черновика: блокировка дела выстроила повторы в очередь,
		// и второй видит записанный первым комментарий — возвращается он, без
		// второй строки и второго письма упомянутым.
		if (input.requestKey !== undefined) {
			const [repeated] = await executor
				.select({ id: comments.id })
				.from(comments)
				.where(
					and(
						eq(comments.requestKey, input.requestKey),
						eq(comments.interactionId, input.interactionId),
						eq(comments.authorId, authorId)
					)
				)
				.limit(1);

			if (repeated !== undefined) {
				return repeated;
			}
		}

		// Упоминания разбираются только в тексте сотрудника: заявитель с сайта
		// не может никого позвать, даже если в его тексте похожая разметка.
		const mentioned =
			source === 'manual' ? await checkMentions(input.interactionId, input.body, authorId) : [];

		const [comment] = await executor
			.insert(comments)
			.values({
				interactionId: input.interactionId,
				authorId,
				body: input.body,
				source,
				requestKey: input.requestKey ?? null
			})
			.returning({ id: comments.id });

		const mentionCount = await queueMentions(executor, {
			commentId: comment.id,
			interactionId: input.interactionId,
			userIds: mentioned
		});

		await touchInteraction(executor, input.interactionId);
		publishAfterCommit(executor, input.interactionId, {
			type: 'comment.added',
			commentId: comment.id
		});

		await recordAuditEvent(
			ctx,
			{
				type: 'interactions.commented',
				outcome: 'success',
				subject: { type: 'interaction', id: input.interactionId },
				details: { commentId: comment.id, mentionCount }
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
 * «Обязательства исполнены» не должно доказываться нажатием кнопки: штатное
 * завершение с финальной стадии спрашивает то же, что шаг вперёд, — закрыт ли
 * обязательный чек-лист (ручные пункты — отметкой, пункты-факты — данными
 * дела), записан ли результат, есть ли подтверждение и данные обучения, — и
 * отказывает теми же словами. Отмена и досрочное закрытие — закрытие не с
 * финальной стадии — признают, что обязательства не исполнены, и доказательств
 * исполнения не требуют; досрочное разрешает только право настраивать процесс
 * и только с объяснением.
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
	checklistState: ChecklistState;
	/** Пункты-факты записи: результат проверки данными дела. */
	facts: EntryFacts;
	resultText: string | null;
	confirmation: StageConfirmation | null;
	/** Снимок записи стадии либо факт по взаимодействию, если снимка ещё нет. */
	lmsEvidence: unknown;
	/** Отметка по документу дела — так же: снимок записи либо отметка по делу. */
	documentMarkEvidence: DocumentMarkEvidence | null;
}): string[] {
	const missing: string[] = [];

	for (const item of entry.stageSnapshot.checklist) {
		if (!item.required) {
			continue;
		}

		if (isFactItem(item)) {
			if (entry.facts[item.key]?.done !== true) {
				missing.push(`Не выполнен пункт чек-листа «${item.label}»: его закрывают данные дела`);
			}
		} else if (entry.checklistState[item.key] !== true) {
			missing.push(`Не закрыт обязательный пункт чек-листа: «${item.label}»`);
		}
	}

	if (entry.stageSnapshot.requiresResult && (entry.resultText ?? '').trim() === '') {
		missing.push('У стадии не записан результат');
	}

	if (entry.stageSnapshot.requiresConfirmation && entry.confirmation === null) {
		missing.push('Стадия не подтверждена');
	}

	if (entry.stageSnapshot.requiresLmsData && entry.lmsEvidence === null) {
		missing.push(LMS_NOT_COMPLETED);
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
			: await readLmsEvidence(executor, interaction.id, entry.stageSnapshot.lmsGroupPurposes);
	const mark = entry === null ? null : await readCurrentDocumentMark(executor, entry);
	const facts = entry === null ? {} : await readEntryFacts(executor, entry);

	return {
		status: row.status,
		openStage: entry === null ? null : entry.stageSnapshot.isFinal ? 'final' : 'earlier',
		missingEvidence:
			entry === null
				? []
				: missingStageEvidence({
						...entry,
						facts,
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

/**
 * Закрывает открытую запись стадии вместе с её паузой. Результат проверки
 * пунктов-фактов остаётся в записи, как и при переходе: закрытая запись не
 * пересчитывается.
 */
async function closeOpenStage(
	tx: Tx,
	entry: typeof stageEntries.$inferSelect,
	outcome: 'completed' | null,
	outcomeReason: string | null
): Promise<void> {
	const facts = await readEntryFacts(tx, entry);

	await tx
		.update(stageEntries)
		.set({
			leftAt: now,
			outcome,
			outcomeReason,
			checklistState: withFrozenFacts(entry.checklistState, facts),
			updatedAt: now
		})
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
		publishAfterCommit(tx, input.interactionId, { type: 'interaction.changed' });

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
		publishAfterCommit(tx, input.interactionId, { type: 'interaction.changed' });

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
