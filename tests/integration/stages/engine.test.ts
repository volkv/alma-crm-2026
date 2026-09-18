/**
 * Движок стадий на настоящей базе: блокировки, частичные индексы и
 * представление со сроком — это и есть то, что проверяется. На заглушке гонка
 * двух команд и сдвиг срока паузой не воспроизводятся вовсе.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProcessRevisionView } from '$lib/contracts/interactions';
import { auditEvents, processRevisions, stageEntries } from '$lib/server/db/schema';
import { ConflictError, ForbiddenError } from '$lib/server/errors';
import { getInteractionSummary } from '$lib/server/interactions/summary';
import {
	advanceStage,
	cancelInteraction,
	completeInteraction,
	confirmStage,
	getInteractionClosing,
	pauseStage,
	raiseBlocker,
	resolveBlocker,
	resumeStage,
	returnStage,
	setStageResult,
	skipStage
} from '$lib/server/stages/commands';
import { createDraft, discardDraft, publishProcess } from '$lib/server/stages/process';
import { getInteractionStatus } from '$lib/server/stages/status';
import type { ActorContext } from '$lib/server/actor';
import {
	failureCode,
	startTestDatabase,
	testActor,
	TEST_USER_IDS,
	type TestDatabase
} from '../helpers/db';
import {
	advanceTo as walkTo,
	B2B_GROUP_KEY,
	B2B_PROCESS,
	B2C_GROUP_KEY,
	closeRequiredChecklist,
	createInteractionOn,
	provideDocumentMark,
	provideLmsEvidence,
	seedProcess,
	stageId,
	twoStageProcess
} from './fixture';

// См. комментарий в `helpers/db.ts`: без этого сервисы пойдут в базу разработчика.
vi.mock('$env/dynamic/private', () => ({ env: process.env }));

let database: TestDatabase;

beforeAll(async () => {
	database = await startTestDatabase();
}, 300_000);

afterAll(async () => {
	await database?.stop();
});

beforeEach(async () => {
	await database.reset();
});

const admin = (): ActorContext => testActor({ roleId: 'admin' });

type Fixture = {
	ctx: ActorContext;
	revision: ProcessRevisionView;
	interactionId: string;
	organizationId: string;
};

/** Взаимодействие на процессе учебных заведений: четырнадцать стадий. */
async function createFixture(): Promise<Fixture> {
	const ctx = admin();
	const revision = await seedProcess(database, B2B_GROUP_KEY, B2B_PROCESS);
	const { interactionId, organizationId } = await createInteractionOn(ctx, database, {
		title: 'Подготовка специалистов'
	});

	return { ctx, revision, interactionId, organizationId };
}

/**
 * Процесс из двух стадий, у которого шаг вперёд требует объяснения, и
 * взаимодействие на нём.
 *
 * В процессе учебных заведений такого перехода нет, а правило «причина
 * обязательна» описано у перехода, а не у его вида: настроенное на шаге вперёд,
 * оно обязано быть выполнимым, а не запирать стадию навсегда. Требований стадии
 * здесь нет намеренно — проверяется ровно причина. Группа другая (`b2c`),
 * потому что в одной группе действует ровно один процесс.
 */
async function createReasonFixture(): Promise<Fixture> {
	const ctx = admin();
	const revision = await seedProcess(
		database,
		B2C_GROUP_KEY,
		twoStageProcess({ name: 'Процесс с объяснением шага вперёд', requiresReason: true })
	);

	const { interactionId, organizationId } = await createInteractionOn(ctx, database, {
		title: 'Переход с объяснением',
		kind: 'legal_entity'
	});

	return { ctx, revision, interactionId, organizationId };
}

/** Проводит взаимодействие вперёд до стадии с нужным ключом. */
async function advanceTo(fixture: Fixture, key: string): Promise<void> {
	await walkTo(fixture.ctx, database, fixture.interactionId, key);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('начало пути', () => {
	it('ставит взаимодействие на первую стадию процесса', async () => {
		const fixture = await createFixture();
		const status = await getInteractionStatus(fixture.ctx, fixture.interactionId);

		expect(status.current?.snapshot.key).toBe('contact_search');
		expect(status.current?.snapshot.position).toBe(1);
		expect(status.history).toEqual([]);
		expect(status.progress[0].state).toBe('current');
		expect(status.progress[1].state).toBe('pending');
		// Слепок стадии лежит в записи: процесс могут изменить, а срок пройденной
		// стадии обязан остаться прежним.
		expect(status.current?.snapshot.slaDays).toBe(7);
	});

	it('не даёт появиться второй открытой записи стадии', async () => {
		const fixture = await createFixture();

		const [open] = await database.db
			.select()
			.from(stageEntries)
			.where(
				and(eq(stageEntries.interactionId, fixture.interactionId), isNull(stageEntries.leftAt))
			);

		// Своей команды «начать путь» нет — путь начинается вместе с заведением
		// записи. Поэтому вопрос «где мы стоим» защищён не проверкой в коде, а
		// частичным уникальным индексом: вторая открытая запись не ложится даже
		// в обход движка.
		const code = await failureCode(
			database.db.insert(stageEntries).values({
				interactionId: fixture.interactionId,
				stageId: open.stageId,
				stageSnapshot: open.stageSnapshot
			})
		);

		expect(code).toBe('23505');
	});
});

describe('шаг вперёд', () => {
	it('не пускает, пока не закрыт обязательный пункт чек-листа', async () => {
		const fixture = await createFixture();

		const command = {
			interactionId: fixture.interactionId,
			revision: fixture.revision.version,
			fromStageId: stageId(fixture.revision, 'contact_search'),
			toStageId: stageId(fixture.revision, 'communication'),
			reason: null,
			resultText: null,
			checklistState: {}
		};

		await expect(advanceStage(fixture.ctx, command)).rejects.toSatisfy(
			(error: unknown) =>
				error instanceof ConflictError && /обязательный пункт чек-листа/.test(error.message)
		);

		const summary = await getInteractionSummary(fixture.ctx, fixture.interactionId);
		const forward = summary.canDo.transitions.find(
			(option) => option.transition.kind === 'forward'
		);

		expect(forward?.allowed).toBe(false);
		expect(forward?.reasons.join('; ')).toMatch(/Найдено профильное подразделение/);

		await closeRequiredChecklist(fixture.ctx, fixture.interactionId);
		await advanceStage(fixture.ctx, command);

		const status = await getInteractionStatus(fixture.ctx, fixture.interactionId);

		expect(status.current?.snapshot.key).toBe('communication');
		expect(status.history).toHaveLength(1);
		expect(status.history[0].outcome).toBe('completed');
		expect(status.history[0].snapshot.name).toBe('Поиск контактных лиц');
		expect(status.history[0].leftAt).not.toBeNull();
		expect(status.progress[0].state).toBe('done');
	});

	it('оставляет ровно одну открытую запись при одновременных командах', async () => {
		const fixture = await createFixture();
		await closeRequiredChecklist(fixture.ctx, fixture.interactionId);

		const command = {
			interactionId: fixture.interactionId,
			revision: fixture.revision.version,
			fromStageId: stageId(fixture.revision, 'contact_search'),
			toStageId: stageId(fixture.revision, 'communication'),
			reason: null,
			resultText: null,
			checklistState: {}
		};

		const outcomes = await Promise.allSettled([
			advanceStage(fixture.ctx, command),
			advanceStage(fixture.ctx, command)
		]);

		expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);

		const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
		expect(rejected?.status === 'rejected' && rejected.reason).toBeInstanceOf(ConflictError);

		const open = await database.db
			.select({ id: stageEntries.id })
			.from(stageEntries)
			.where(
				and(eq(stageEntries.interactionId, fixture.interactionId), isNull(stageEntries.leftAt))
			);

		expect(open).toHaveLength(1);
	});

	it('требует объяснение, когда его требует переход процесса', async () => {
		const fixture = await createReasonFixture();

		const command = {
			interactionId: fixture.interactionId,
			revision: fixture.revision.version,
			fromStageId: stageId(fixture.revision, 'first'),
			toStageId: stageId(fixture.revision, 'second'),
			reason: null,
			resultText: null,
			checklistState: {}
		};

		await expect(advanceStage(fixture.ctx, command)).rejects.toSatisfy(
			(error: unknown) =>
				error instanceof ConflictError && /Нужно объяснить причину/.test(error.message)
		);

		// Сводка причину заранее не требует: её вводят в момент нажатия, и отказ
		// до ввода сделал бы переход недоступным на вид.
		const summary = await getInteractionSummary(fixture.ctx, fixture.interactionId);
		const forward = summary.canDo.transitions.find(
			(option) => option.transition.kind === 'forward'
		);

		expect(forward?.transition.requiresReason).toBe(true);
		expect(forward?.allowed).toBe(true);

		await advanceStage(fixture.ctx, { ...command, reason: 'Программа согласована деканатом' });

		const status = await getInteractionStatus(fixture.ctx, fixture.interactionId);

		expect(status.current?.snapshot.key).toBe('second');
		expect(status.history[0].outcome).toBe('completed');
		// Объяснение остаётся в истории стадии — иначе требовать его незачем.
		expect(status.history[0].outcomeReason).toBe('Программа согласована деканатом');
	});

	it('закрывает прежнюю запись и открывает новую одним моментом', async () => {
		const fixture = await createFixture();

		await closeRequiredChecklist(fixture.ctx, fixture.interactionId);
		await advanceStage(fixture.ctx, {
			interactionId: fixture.interactionId,
			revision: fixture.revision.version,
			fromStageId: stageId(fixture.revision, 'contact_search'),
			toStageId: stageId(fixture.revision, 'communication'),
			reason: null,
			resultText: null,
			checklistState: {}
		});

		const entries = await database.db
			.select({
				enteredAt: stageEntries.enteredAt,
				leftAt: stageEntries.leftAt
			})
			.from(stageEntries)
			.where(eq(stageEntries.interactionId, fixture.interactionId))
			.orderBy(stageEntries.enteredAt);

		// Между окнами двух записей нет ни дыры, ни нахлёста: срез на прошлую
		// дату иначе увидел бы взаимодействие сразу на двух стадиях или ни на
		// одной. Отметку ставит база, и момент берётся после блокировки строки —
		// умолчание столбца («начало транзакции») у команды, простоявшей в
		// очереди, оказалось бы раньше выхода с прежней стадии.
		expect(entries).toHaveLength(2);
		expect(entries[0].leftAt?.getTime()).toBe(entries[1].enteredAt.getTime());
	});
});

describe('пауза', () => {
	it('сдвигает срок, запрещает шаг вперёд и отпускает после снятия', async () => {
		const fixture = await createFixture();
		await closeRequiredChecklist(fixture.ctx, fixture.interactionId);

		const fromStageId = stageId(fixture.revision, 'contact_search');
		const before = await getInteractionStatus(fixture.ctx, fixture.interactionId);

		await pauseStage(fixture.ctx, {
			interactionId: fixture.interactionId,
			fromStageId,
			reason: 'waiting_counterparty',
			waitingPartyId: null,
			nextAction: 'Позвонить в приёмную',
			note: 'Ждём ответа вуза'
		});

		await sleep(1200);

		const paused = await getInteractionStatus(fixture.ctx, fixture.interactionId);

		expect(paused.current?.isPaused).toBe(true);
		// Часы стоят: срок уезжает ровно на длину паузы.
		expect(paused.current?.dueAt.getTime()).toBeGreaterThan(
			(before.current?.dueAt.getTime() ?? 0) + 900
		);

		const command = {
			interactionId: fixture.interactionId,
			revision: fixture.revision.version,
			fromStageId,
			toStageId: stageId(fixture.revision, 'communication'),
			reason: null,
			resultText: null,
			checklistState: {}
		};

		await expect(advanceStage(fixture.ctx, command)).rejects.toSatisfy(
			(error: unknown) => error instanceof ConflictError && /на паузе/.test(error.message)
		);

		await expect(
			pauseStage(fixture.ctx, {
				interactionId: fixture.interactionId,
				fromStageId,
				reason: 'other',
				waitingPartyId: null,
				nextAction: null,
				note: 'Вторая пауза'
			})
		).rejects.toBeInstanceOf(ConflictError);

		await resumeStage(fixture.ctx, {
			interactionId: fixture.interactionId,
			fromStageId,
			note: null
		});
		await advanceStage(fixture.ctx, command);

		const status = await getInteractionStatus(fixture.ctx, fixture.interactionId);

		expect(status.current?.snapshot.key).toBe('communication');
		expect(status.history[0].pauses[0].endedAt).not.toBeNull();
		expect(status.history[0].pausedSeconds).toBeGreaterThan(0);
	});
});

describe('помехи', () => {
	it('запрещают переход, пока не сняты', async () => {
		const fixture = await createFixture();
		await closeRequiredChecklist(fixture.ctx, fixture.interactionId);

		const blocker = await raiseBlocker(fixture.ctx, {
			interactionId: fixture.interactionId,
			reasonCode: 'no-contact',
			description: 'Координатор не отвечает',
			blocksTransition: true,
			assigneeUserId: null
		});

		const command = {
			interactionId: fixture.interactionId,
			revision: fixture.revision.version,
			fromStageId: stageId(fixture.revision, 'contact_search'),
			toStageId: stageId(fixture.revision, 'communication'),
			reason: null,
			resultText: null,
			checklistState: {}
		};

		await expect(advanceStage(fixture.ctx, command)).rejects.toSatisfy(
			(error: unknown) => error instanceof ConflictError && /помех/.test(error.message)
		);

		const blocked = await getInteractionStatus(fixture.ctx, fixture.interactionId);
		expect(blocked.progress[0].state).toBe('blocked');

		await resolveBlocker(fixture.ctx, {
			blockerId: blocker.id,
			resolution: 'Связались через приёмную ректора'
		});

		await expect(
			resolveBlocker(fixture.ctx, { blockerId: blocker.id, resolution: 'Ещё раз' })
		).rejects.toBeInstanceOf(ConflictError);

		await advanceStage(fixture.ctx, command);

		const status = await getInteractionStatus(fixture.ctx, fixture.interactionId);
		expect(status.current?.snapshot.key).toBe('communication');
	});
});

describe('возврат и пропуск', () => {
	it('возврат пишет исход и причину', async () => {
		const fixture = await createFixture();
		await closeRequiredChecklist(fixture.ctx, fixture.interactionId);

		await advanceStage(fixture.ctx, {
			interactionId: fixture.interactionId,
			revision: fixture.revision.version,
			fromStageId: stageId(fixture.revision, 'contact_search'),
			toStageId: stageId(fixture.revision, 'communication'),
			reason: null,
			resultText: null,
			checklistState: {}
		});

		await returnStage(fixture.ctx, {
			interactionId: fixture.interactionId,
			revision: fixture.revision.version,
			fromStageId: stageId(fixture.revision, 'communication'),
			toStageId: stageId(fixture.revision, 'contact_search'),
			reason: 'Контакт оказался не тот'
		});

		const status = await getInteractionStatus(fixture.ctx, fixture.interactionId);
		const returned = status.history.find((entry) => entry.snapshot.key === 'communication');

		expect(status.current?.snapshot.key).toBe('contact_search');
		expect(returned?.outcome).toBe('returned');
		expect(returned?.outcomeReason).toBe('Контакт оказался не тот');
		// Отметки чек-листа первой стадии — в её прежней записи; новая начинается
		// с чистого листа, потому что стадию проходят заново.
		expect(status.current?.checklistState).toEqual({});
	});

	it('пропуск перешагивает стадию, и она видна пропущенной', async () => {
		const fixture = await createFixture();
		await advanceTo(fixture, 'document_exchange');
		await closeRequiredChecklist(fixture.ctx, fixture.interactionId);

		await skipStage(fixture.ctx, {
			interactionId: fixture.interactionId,
			revision: fixture.revision.version,
			fromStageId: stageId(fixture.revision, 'document_exchange'),
			toStageId: stageId(fixture.revision, 'signing'),
			reason: 'Замечаний к документам нет'
		});

		const status = await getInteractionStatus(fixture.ctx, fixture.interactionId);
		const revision = status.progress.find((item) => item.key === 'document_revision');

		expect(status.current?.snapshot.key).toBe('signing');
		expect(revision?.state).toBe('skipped');
		expect(
			status.history.find((entry) => entry.snapshot.key === 'document_exchange')?.outcome
		).toBe('skipped');
	});
});

describe('подтверждение стадии', () => {
	it('требуется там, где стадия его требует', async () => {
		const fixture = await createFixture();
		await advanceTo(fixture, 'materials_handover');
		await closeRequiredChecklist(fixture.ctx, fixture.interactionId);

		const fromStageId = stageId(fixture.revision, 'materials_handover');
		const command = {
			interactionId: fixture.interactionId,
			revision: fixture.revision.version,
			fromStageId,
			toStageId: stageId(fixture.revision, 'implementation_support'),
			reason: null,
			resultText: null,
			checklistState: {}
		};

		await expect(advanceStage(fixture.ctx, command)).rejects.toSatisfy(
			(error: unknown) =>
				error instanceof ConflictError && /не записан результат/.test(error.message)
		);

		await setStageResult(fixture.ctx, {
			interactionId: fixture.interactionId,
			resultText: 'Материалы и лицензии переданы'
		});

		await expect(advanceStage(fixture.ctx, command)).rejects.toSatisfy(
			(error: unknown) => error instanceof ConflictError && /не подтверждена/.test(error.message)
		);

		await confirmStage(fixture.ctx, {
			interactionId: fixture.interactionId,
			fromStageId,
			confirmation: { kind: 'mark' }
		});

		const confirmed = await getInteractionStatus(fixture.ctx, fixture.interactionId);
		expect(confirmed.current?.confirmation).toEqual({
			kind: 'mark',
			byUserId: TEST_USER_IDS.admin,
			at: expect.any(String)
		});

		await advanceStage(fixture.ctx, command);

		const status = await getInteractionStatus(fixture.ctx, fixture.interactionId);
		expect(status.current?.snapshot.key).toBe('implementation_support');
	});

	it('стадию занятий закрывает результат системы обучения, и он же её подтверждает', async () => {
		const fixture = await createFixture();
		await advanceTo(fixture, 'classes');
		await closeRequiredChecklist(fixture.ctx, fixture.interactionId);
		await setStageResult(fixture.ctx, {
			interactionId: fixture.interactionId,
			resultText: 'Занятия проведены по расписанию'
		});

		const command = {
			interactionId: fixture.interactionId,
			revision: fixture.revision.version,
			fromStageId: stageId(fixture.revision, 'classes'),
			toStageId: stageId(fixture.revision, 'documentation_update'),
			reason: null,
			resultText: null,
			checklistState: {}
		};

		// Отметка ответственного стадию не закрывает: занятия идут в чужой
		// системе, и подтверждает их её результат, а не подпись исполнителя.
		await confirmStage(fixture.ctx, {
			interactionId: fixture.interactionId,
			fromStageId: command.fromStageId,
			confirmation: { kind: 'mark' }
		});

		await expect(advanceStage(fixture.ctx, command)).rejects.toSatisfy(
			(error: unknown) =>
				error instanceof ConflictError && /не получены данные системы обучения/.test(error.message)
		);

		const evidence = await provideLmsEvidence(fixture.ctx, database, fixture.interactionId);

		await advanceStage(fixture.ctx, command);

		const status = await getInteractionStatus(fixture.ctx, fixture.interactionId);
		const classes = status.history.find((entry) => entry.snapshot.key === 'classes');

		expect(status.current?.snapshot.key).toBe('documentation_update');
		expect(classes?.lmsEvidence).toMatchObject({
			groupExternalId: evidence.groupExternalId,
			completed: evidence.completed
		});
	});

	it('стадию подписания закрывает отметка «Утверждён» по документу дела', async () => {
		const fixture = await createFixture();
		await advanceTo(fixture, 'signing');
		await closeRequiredChecklist(fixture.ctx, fixture.interactionId);

		const command = {
			interactionId: fixture.interactionId,
			revision: fixture.revision.version,
			fromStageId: stageId(fixture.revision, 'signing'),
			toStageId: stageId(fixture.revision, 'materials_handover'),
			reason: null,
			resultText: null,
			checklistState: {}
		};

		await expect(advanceStage(fixture.ctx, command)).rejects.toSatisfy(
			(error: unknown) =>
				error instanceof ConflictError && /нет документа с отметкой «Утверждён»/.test(error.message)
		);

		// Отметка ответственного стадию не закрывает: подписан документ или нет —
		// это факт по документу, а не слово исполнителя.
		await confirmStage(fixture.ctx, {
			interactionId: fixture.interactionId,
			fromStageId: command.fromStageId,
			confirmation: { kind: 'mark' }
		});

		await expect(advanceStage(fixture.ctx, command)).rejects.toSatisfy(
			(error: unknown) =>
				error instanceof ConflictError && /нет документа с отметкой «Утверждён»/.test(error.message)
		);

		// Согласование — не утверждение: отметка другого вида требование не
		// закрывает.
		await provideDocumentMark(
			fixture.ctx,
			database,
			fixture.interactionId,
			'agreed',
			'Протокол разногласий'
		);

		await expect(advanceStage(fixture.ctx, command)).rejects.toSatisfy(
			(error: unknown) =>
				error instanceof ConflictError && /нет документа с отметкой «Утверждён»/.test(error.message)
		);

		const documentId = await provideDocumentMark(
			fixture.ctx,
			database,
			fixture.interactionId,
			'approved'
		);

		await advanceStage(fixture.ctx, command);

		const status = await getInteractionStatus(fixture.ctx, fixture.interactionId);
		const signing = status.history.find((entry) => entry.snapshot.key === 'signing');

		expect(status.current?.snapshot.key).toBe('materials_handover');
		// Факт остаётся в закрытой записи: она обязана объяснять, чем стадия
		// подтверждена, и после того, как с неё ушли.
		expect(signing?.documentMarkEvidence).toMatchObject({
			documentId,
			mark: 'approved',
			title: 'Соглашение о сотрудничестве'
		});
	});

	it('отметка, поставленная до входа на стадию, засчитывается при входе', async () => {
		const fixture = await createFixture();
		await advanceTo(fixture, 'document_revision');

		// Подписанный экземпляр приходит тогда, когда его подписали, а не тогда,
		// когда дело дошло до стадии подписания.
		const documentId = await provideDocumentMark(
			fixture.ctx,
			database,
			fixture.interactionId,
			'approved'
		);

		await closeRequiredChecklist(fixture.ctx, fixture.interactionId);
		await advanceStage(fixture.ctx, {
			interactionId: fixture.interactionId,
			revision: fixture.revision.version,
			fromStageId: stageId(fixture.revision, 'document_revision'),
			toStageId: stageId(fixture.revision, 'signing'),
			reason: null,
			resultText: null,
			checklistState: {}
		});

		const entered = await getInteractionStatus(fixture.ctx, fixture.interactionId);

		// Требование выполнено уже на входе, и карточка это показывает: иначе она
		// объявляла бы стадию незакрытой, а переход при этом проходил бы.
		expect(entered.current?.documentMarkEvidence).toMatchObject({ documentId, mark: 'approved' });

		await closeRequiredChecklist(fixture.ctx, fixture.interactionId);
		await advanceStage(fixture.ctx, {
			interactionId: fixture.interactionId,
			revision: fixture.revision.version,
			fromStageId: stageId(fixture.revision, 'signing'),
			toStageId: stageId(fixture.revision, 'materials_handover'),
			reason: null,
			resultText: null,
			checklistState: {}
		});

		const status = await getInteractionStatus(fixture.ctx, fixture.interactionId);

		expect(status.current?.snapshot.key).toBe('materials_handover');
	});
});

describe('закрытие взаимодействия', () => {
	it('завершает с последней стадии и записывает итог', async () => {
		const fixture = await createFixture();
		await advanceTo(fixture, 'execution_control');
		await closeRequiredChecklist(fixture.ctx, fixture.interactionId);

		const before = await getInteractionClosing(fixture.ctx, fixture.interactionId);

		expect(before.complete.allowed).toBe(true);
		expect(before.complete.requiresForce).toBe(false);

		await completeInteraction(fixture.ctx, {
			interactionId: fixture.interactionId,
			revision: fixture.revision.version,
			summary: 'Отчёт принят заказчиком',
			force: false
		});

		const status = await getInteractionStatus(fixture.ctx, fixture.interactionId);
		const last = status.history[0];

		// Закрытое взаимодействие не стоит ни на одной стадии, поэтому команд
		// стадий сводка больше не предлагает — двигать нечего.
		expect(status.current).toBeNull();
		expect(last.snapshot.key).toBe('execution_control');
		expect(last.outcome).toBe('completed');
		expect(last.outcomeReason).toBe('Отчёт принят заказчиком');

		const summary = await getInteractionSummary(fixture.ctx, fixture.interactionId);
		expect(summary.canDo.transitions).toStrictEqual([]);

		const after = await getInteractionClosing(fixture.ctx, fixture.interactionId);
		expect(after.complete.allowed).toBe(false);
		expect(after.complete.reasons.join('; ')).toMatch(/уже завершено/);

		// Повторное завершение — не «ещё раз получилось», а конфликт состояния.
		await expect(
			completeInteraction(fixture.ctx, {
				interactionId: fixture.interactionId,
				revision: fixture.revision.version,
				summary: null,
				force: false
			})
		).rejects.toBeInstanceOf(ConflictError);

		const events = await database.db
			.select({ type: auditEvents.eventType })
			.from(auditEvents)
			.where(eq(auditEvents.subjectId, fixture.interactionId));

		expect(events.map((event) => event.type)).toContain('interactions.completed');
	});

	it('не завершает с середины процесса без явного досрочного закрытия', async () => {
		const fixture = await createFixture();

		const verdict = await getInteractionClosing(fixture.ctx, fixture.interactionId);

		expect(verdict.complete.allowed).toBe(true);
		expect(verdict.complete.requiresForce).toBe(true);

		await expect(
			completeInteraction(fixture.ctx, {
				interactionId: fixture.interactionId,
				revision: fixture.revision.version,
				summary: 'Вуз передумал',
				force: false
			})
		).rejects.toSatisfy(
			(error: unknown) =>
				error instanceof ConflictError && /не на финальной стадии/.test(error.message)
		);

		// Досрочное закрытие — отступление от процесса: менеджеру оно недоступно,
		// и отказ объясняет почему.
		const manager = testActor({ roleId: 'manager' });
		const forManager = await getInteractionClosing(manager, fixture.interactionId);

		expect(forManager.complete.allowed).toBe(false);
		expect(forManager.complete.reasons.join('; ')).toMatch(/настраивает процесс/);

		await expect(
			completeInteraction(manager, {
				interactionId: fixture.interactionId,
				revision: fixture.revision.version,
				summary: 'Вуз передумал',
				force: true
			})
		).rejects.toBeInstanceOf(ConflictError);

		await completeInteraction(fixture.ctx, {
			interactionId: fixture.interactionId,
			revision: fixture.revision.version,
			summary: 'Вуз передумал: программа закрыта на его стороне',
			force: true
		});

		const status = await getInteractionStatus(fixture.ctx, fixture.interactionId);

		expect(status.current).toBeNull();
		expect(status.history[0].snapshot.key).toBe('contact_search');
	});

	it('отмена закрывает запись с причиной и снимает паузу', async () => {
		const fixture = await createFixture();
		const fromStageId = stageId(fixture.revision, 'contact_search');

		await pauseStage(fixture.ctx, {
			interactionId: fixture.interactionId,
			fromStageId,
			reason: 'waiting_counterparty',
			waitingPartyId: null,
			nextAction: null,
			note: 'Ждём ответа вуза'
		});

		await cancelInteraction(fixture.ctx, {
			interactionId: fixture.interactionId,
			revision: fixture.revision.version,
			reason: 'Вуз отказался от сотрудничества в этом учебном году'
		});

		const status = await getInteractionStatus(fixture.ctx, fixture.interactionId);
		const last = status.history[0];

		expect(status.current).toBeNull();
		// Стадию не прошли и не пропустили — исхода у записи нет, есть причина.
		expect(last.outcome).toBeNull();
		expect(last.outcomeReason).toBe('Вуз отказался от сотрудничества в этом учебном году');
		expect(last.pauses[0].endedAt).not.toBeNull();

		// Взаимодействие ушло с процесса: двигать его больше нечем.
		await expect(
			advanceStage(fixture.ctx, {
				interactionId: fixture.interactionId,
				revision: fixture.revision.version,
				fromStageId,
				toStageId: stageId(fixture.revision, 'communication'),
				reason: null,
				resultText: null,
				checklistState: {}
			})
		).rejects.toBeInstanceOf(ConflictError);

		const verdict = await getInteractionClosing(fixture.ctx, fixture.interactionId);
		expect(verdict.cancel.allowed).toBe(false);
	});
});

describe('журнал действий', () => {
	it('записывает каждую команду движка', async () => {
		const fixture = await createFixture();
		const fromStageId = stageId(fixture.revision, 'contact_search');

		await closeRequiredChecklist(fixture.ctx, fixture.interactionId);
		await setStageResult(fixture.ctx, {
			interactionId: fixture.interactionId,
			resultText: 'Контакт найден'
		});
		await pauseStage(fixture.ctx, {
			interactionId: fixture.interactionId,
			fromStageId,
			reason: 'waiting_internal',
			waitingPartyId: null,
			nextAction: null,
			note: 'Ждём юристов'
		});
		await resumeStage(fixture.ctx, {
			interactionId: fixture.interactionId,
			fromStageId,
			note: null
		});
		await advanceStage(fixture.ctx, {
			interactionId: fixture.interactionId,
			revision: fixture.revision.version,
			fromStageId,
			toStageId: stageId(fixture.revision, 'communication'),
			reason: null,
			resultText: null,
			checklistState: {}
		});

		const events = await database.db
			.select({ type: auditEvents.eventType })
			.from(auditEvents)
			.where(eq(auditEvents.subjectId, fixture.interactionId));

		expect(new Set(events.map((event) => event.type))).toEqual(
			new Set([
				'interactions.created',
				'interactions.started',
				'interactions.checklist_changed',
				'interactions.result_recorded',
				'interactions.paused',
				'interactions.resumed',
				'interactions.stage_advanced'
			])
		);
	});

	it('записывает отказ настроить процесс', async () => {
		await seedProcess(database, B2B_GROUP_KEY, B2B_PROCESS);

		const manager = testActor({ roleId: 'manager' });

		// Процесс — это устройство работы: он меняет правила для всех взаимодействий
		// сразу, и попытка его тронуть без права должна остаться в журнале, а не
		// только в ответе тому, кто её сделал.
		await expect(createDraft(manager, B2B_GROUP_KEY)).rejects.toBeInstanceOf(ForbiddenError);
		await expect(discardDraft(manager, B2B_GROUP_KEY)).rejects.toBeInstanceOf(ForbiddenError);
		await expect(publishProcess(manager, B2B_GROUP_KEY)).rejects.toBeInstanceOf(ForbiddenError);

		const denied = await database.db
			.select({ type: auditEvents.eventType, actorUserId: auditEvents.actorUserId })
			.from(auditEvents)
			.where(eq(auditEvents.outcome, 'denied'));

		expect(denied).toEqual([
			{ type: 'stages.draft_created', actorUserId: TEST_USER_IDS.manager },
			{ type: 'stages.draft_discarded', actorUserId: TEST_USER_IDS.manager },
			{ type: 'stages.process_published', actorUserId: TEST_USER_IDS.manager }
		]);

		// Черновика после отказа не появилось: у группы осталась одна редакция.
		const revisions = await database.db.select({ id: processRevisions.id }).from(processRevisions);
		expect(revisions).toHaveLength(1);
	});
});
