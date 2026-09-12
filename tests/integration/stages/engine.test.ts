/**
 * Движок стадий на настоящей базе: блокировки, частичные индексы и
 * представление со сроком — это и есть то, что проверяется. На заглушке гонка
 * двух команд и сдвиг срока паузой не воспроизводятся вовсе.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	createInteractionSchema,
	type CreateInteractionInput,
	type StageRouteView
} from '$lib/contracts/interactions';
import { auditEvents, stageEntries, stageRoutes } from '$lib/server/db/schema';
import { ConflictError, ForbiddenError } from '$lib/server/errors';
import { createInteraction } from '$lib/server/interactions/write';
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
	setChecklistItem,
	setStageResult,
	skipStage,
	startInteraction
} from '$lib/server/stages/commands';
import { DEMO_ROUTE } from '$lib/server/stages/demo-route';
import {
	createRoute,
	ensureDemoRoute,
	getRoute,
	publishRoute,
	updateRoute
} from '$lib/server/stages/routes';
import { getInteractionStatus } from '$lib/server/stages/status';
import type { ActorContext } from '$lib/server/actor';
import {
	insertOrganization,
	startTestDatabase,
	testActor,
	TEST_USER_IDS,
	type TestDatabase
} from '../helpers/db';

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
	route: StageRouteView;
	interactionId: string;
	organizationId: string;
};

async function createFixture(): Promise<Fixture> {
	const ctx = admin();
	const routeId = await database.db.transaction((tx) => ensureDemoRoute(tx));
	const organizationId = await insertOrganization(database.db, { shortName: 'Вуз для движка' });
	const route = await getRoute(ctx, routeId);

	// В `parse` едет вход схемы: остальные поля схема заполнит умолчаниями.
	const input: CreateInteractionInput = createInteractionSchema.parse({
		title: 'Подготовка специалистов',
		routeId,
		ownerUserId: TEST_USER_IDS.admin,
		parties: [{ organizationId, partyRole: 'educational_institution', isPrimary: true }]
	});

	const interaction = await createInteraction(ctx, input);

	return { ctx, route, interactionId: interaction.id, organizationId };
}

/** Стадия маршрута по ключу: тесты адресуют стадии именами, а не номерами. */
function stageId(route: StageRouteView, key: string): string {
	const stage = route.stages.find((item) => item.key === key);

	if (stage === undefined) {
		throw new Error(`В маршруте нет стадии «${key}»`);
	}

	return stage.id;
}

/** Закрывает обязательные пункты чек-листа текущей стадии. */
async function closeRequiredChecklist(ctx: ActorContext, interactionId: string): Promise<void> {
	const status = await getInteractionStatus(ctx, interactionId);
	const current = status.current;

	if (current === null) {
		throw new Error('Взаимодействие не стоит ни на одной стадии');
	}

	for (const item of current.snapshot.checklist) {
		if (item.required) {
			await setChecklistItem(ctx, { interactionId, key: item.key, done: true });
		}
	}
}

/** Проводит взаимодействие вперёд до стадии с нужным ключом. */
async function advanceTo(fixture: Fixture, key: string): Promise<void> {
	for (let step = 0; step < fixture.route.stages.length; step += 1) {
		const status = await getInteractionStatus(fixture.ctx, fixture.interactionId);
		const current = status.current;

		if (current === null || current.snapshot.key === key) {
			return;
		}

		await closeRequiredChecklist(fixture.ctx, fixture.interactionId);

		if (current.snapshot.requiresResult) {
			await setStageResult(fixture.ctx, {
				interactionId: fixture.interactionId,
				resultText: `Результат стадии «${current.snapshot.name}»`
			});
		}

		if (current.snapshot.requiresConfirmation) {
			await confirmStage(fixture.ctx, {
				interactionId: fixture.interactionId,
				fromStageId: current.stageId,
				confirmation: { kind: 'mark' }
			});
		}

		const next = fixture.route.transitions.find(
			(transition) => transition.fromStageId === current.stageId && transition.kind === 'forward'
		);

		if (next === undefined) {
			throw new Error(`С стадии «${current.snapshot.key}» нет шага вперёд`);
		}

		await advanceStage(fixture.ctx, {
			interactionId: fixture.interactionId,
			fromStageId: current.stageId,
			toStageId: next.toStageId,
			resultText: null,
			checklistState: {}
		});
	}

	throw new Error(`Не удалось дойти до стадии «${key}»`);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('начало пути', () => {
	it('ставит взаимодействие на первую стадию маршрута', async () => {
		const fixture = await createFixture();
		const status = await getInteractionStatus(fixture.ctx, fixture.interactionId);

		expect(status.current?.snapshot.key).toBe('contact_search');
		expect(status.current?.snapshot.position).toBe(1);
		expect(status.history).toEqual([]);
		expect(status.progress[0].state).toBe('current');
		expect(status.progress[1].state).toBe('pending');
		// Слепок стадии лежит в записи: маршрут могут переиздать, а срок пройденной
		// стадии обязан остаться прежним.
		expect(status.current?.snapshot.slaDays).toBe(7);
	});

	it('не начинает путь во второй раз', async () => {
		const fixture = await createFixture();

		// Взаимодействие начинается вместе с заведением; повторный старт открыл бы
		// вторую запись стадии и сделал бы вопрос «где мы стоим» бессмысленным.
		await expect(startInteraction(fixture.ctx, fixture.interactionId)).rejects.toBeInstanceOf(
			ConflictError
		);
	});
});

describe('шаг вперёд', () => {
	it('не пускает, пока не закрыт обязательный пункт чек-листа', async () => {
		const fixture = await createFixture();

		const command = {
			interactionId: fixture.interactionId,
			fromStageId: stageId(fixture.route, 'contact_search'),
			toStageId: stageId(fixture.route, 'communication'),
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
			fromStageId: stageId(fixture.route, 'contact_search'),
			toStageId: stageId(fixture.route, 'communication'),
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
});

describe('пауза', () => {
	it('сдвигает срок, запрещает шаг вперёд и отпускает после снятия', async () => {
		const fixture = await createFixture();
		await closeRequiredChecklist(fixture.ctx, fixture.interactionId);

		const fromStageId = stageId(fixture.route, 'contact_search');
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
			fromStageId,
			toStageId: stageId(fixture.route, 'communication'),
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
			fromStageId: stageId(fixture.route, 'contact_search'),
			toStageId: stageId(fixture.route, 'communication'),
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
			fromStageId: stageId(fixture.route, 'contact_search'),
			toStageId: stageId(fixture.route, 'communication'),
			resultText: null,
			checklistState: {}
		});

		await returnStage(fixture.ctx, {
			interactionId: fixture.interactionId,
			fromStageId: stageId(fixture.route, 'communication'),
			toStageId: stageId(fixture.route, 'contact_search'),
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
			fromStageId: stageId(fixture.route, 'document_exchange'),
			toStageId: stageId(fixture.route, 'signing'),
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

		const fromStageId = stageId(fixture.route, 'materials_handover');
		const command = {
			interactionId: fixture.interactionId,
			fromStageId,
			toStageId: stageId(fixture.route, 'implementation_support'),
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

	it('не завершает с середины маршрута без явного досрочного закрытия', async () => {
		const fixture = await createFixture();

		const verdict = await getInteractionClosing(fixture.ctx, fixture.interactionId);

		expect(verdict.complete.allowed).toBe(true);
		expect(verdict.complete.requiresForce).toBe(true);

		await expect(
			completeInteraction(fixture.ctx, {
				interactionId: fixture.interactionId,
				summary: 'Вуз передумал',
				force: false
			})
		).rejects.toSatisfy(
			(error: unknown) =>
				error instanceof ConflictError && /не на последней стадии/.test(error.message)
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
				summary: 'Вуз передумал',
				force: true
			})
		).rejects.toBeInstanceOf(ConflictError);

		await completeInteraction(fixture.ctx, {
			interactionId: fixture.interactionId,
			summary: 'Вуз передумал: программа закрыта на его стороне',
			force: true
		});

		const status = await getInteractionStatus(fixture.ctx, fixture.interactionId);

		expect(status.current).toBeNull();
		expect(status.history[0].snapshot.key).toBe('contact_search');
	});

	it('отмена закрывает запись с причиной и снимает паузу', async () => {
		const fixture = await createFixture();
		const fromStageId = stageId(fixture.route, 'contact_search');

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
			reason: 'Вуз отказался от сотрудничества в этом учебном году'
		});

		const status = await getInteractionStatus(fixture.ctx, fixture.interactionId);
		const last = status.history[0];

		expect(status.current).toBeNull();
		// Стадию не прошли и не пропустили — исхода у записи нет, есть причина.
		expect(last.outcome).toBeNull();
		expect(last.outcomeReason).toBe('Вуз отказался от сотрудничества в этом учебном году');
		expect(last.pauses[0].endedAt).not.toBeNull();

		// Взаимодействие ушло с маршрута: двигать его больше нечем.
		await expect(
			advanceStage(fixture.ctx, {
				interactionId: fixture.interactionId,
				fromStageId,
				toStageId: stageId(fixture.route, 'communication'),
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
		const fromStageId = stageId(fixture.route, 'contact_search');

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
			fromStageId,
			toStageId: stageId(fixture.route, 'communication'),
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

	it('записывает отказ настроить маршрут стадий', async () => {
		const manager = testActor({ roleId: 'manager' });
		const definition = { ...DEMO_ROUTE, key: `mimo-prav-${crypto.randomUUID().slice(0, 8)}` };

		// Маршрут — это устройство процесса: он меняет правила для всех
		// взаимодействий сразу, и попытка его тронуть без права должна остаться
		// в журнале, а не только в ответе тому, кто её сделал.
		await expect(createRoute(manager, definition)).rejects.toBeInstanceOf(ForbiddenError);
		await expect(
			updateRoute(manager, { ...definition, id: crypto.randomUUID() })
		).rejects.toBeInstanceOf(ForbiddenError);
		await expect(publishRoute(manager, crypto.randomUUID())).rejects.toBeInstanceOf(ForbiddenError);

		const denied = await database.db
			.select({ type: auditEvents.eventType, actorUserId: auditEvents.actorUserId })
			.from(auditEvents)
			.where(eq(auditEvents.outcome, 'denied'));

		expect(denied).toEqual([
			{ type: 'stages.route_created', actorUserId: TEST_USER_IDS.manager },
			{ type: 'stages.route_updated', actorUserId: TEST_USER_IDS.manager },
			{ type: 'stages.route_published', actorUserId: TEST_USER_IDS.manager }
		]);

		// Черновика после отказа не появилось.
		const drafts = await database.db
			.select({ id: stageRoutes.id })
			.from(stageRoutes)
			.where(eq(stageRoutes.key, definition.key));
		expect(drafts).toEqual([]);
	});
});
