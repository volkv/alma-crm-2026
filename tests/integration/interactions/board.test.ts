/**
 * Доска взаимодействий на настоящей базе: выборка, счётчики колонок и перевод
 * карточки.
 *
 * На заглушке это не проверить: срок и просрочку считает представление
 * `stage_entry_status`, число дел на стадии — оконная функция того же запроса, а
 * область доступа живёт в SQL. Перевод проверяется через действие страницы —
 * там, где доска встречается с движком: право и готовность перехода решает он,
 * а не интерфейс.
 */
import type { RequestEvent } from '@sveltejs/kit';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	createInteractionSchema,
	type InteractionBoardView,
	type ProcessRevisionView
} from '$lib/contracts/interactions';
import type { ActorContext } from '$lib/server/actor';
import { programs, stageEntries } from '$lib/server/db/schema';
import {
	CARDS_PER_COLUMN,
	getInteractionBoard,
	type BoardWorkspace,
	type InteractionBoardQuery
} from '$lib/server/interactions/board';
import { createInteraction } from '$lib/server/interactions/write';
import { pauseStage, setChecklistItem } from '$lib/server/stages/commands';
import { B2B_WORKSPACE_KEY, B2B_PROCESS, B2C_WORKSPACE_KEY } from '$lib/server/stages/definitions';
import {
	ensureWorkflow,
	readWorkspaceByKey,
	requireActiveRevisionForWorkspace
} from '$lib/server/stages/process';
import { getInteractionStatus } from '$lib/server/stages/status';
import { getDb } from '$lib/server/db';
import {
	daysFrom,
	insertOrganization,
	startTestDatabase,
	scopedActor,
	testActor,
	TEST_USER_IDS,
	type TestDatabase
} from '../helpers/db';
import type { PermissionKey } from '$lib/server/rbac/permissions';
import { pageEvent, sessionUser } from '../helpers/event';

// См. комментарий в `helpers/db.ts`: без этого сервисы пойдут в базу разработчика.
vi.mock('$env/dynamic/private', () => ({ env: process.env }));

/** Загрузчик и действие маршрута типизированы своим маршрутом; подделка — общим. */
type PageLoad = (event: RequestEvent) => Promise<unknown>;
type FormAction = (event: RequestEvent) => Promise<unknown>;

const listPage = await import('../../../src/routes/(app)/w/[workspace]/interactions/+page.server');

const loadList = listPage.load as unknown as PageLoad;
const transitionAction = listPage.actions.transition as unknown as FormAction;

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
const manager = (): ActorContext => testActor({ roleId: 'manager' });

const EMPTY_QUERY: InteractionBoardQuery = {
	status: null,
	stageCategory: null,
	overdue: false,
	ownerUserId: null,
	q: null
};

function query(overrides: Partial<InteractionBoardQuery> = {}): InteractionBoardQuery {
	return { ...EMPTY_QUERY, ...overrides };
}

/**
 * Пространство, чью доску собирают. Задаётся адресом — доска его больше не
 * выбирает, — поэтому тесты называют его так же явно, как маршрут.
 */
async function workspaceOf(key: string): Promise<BoardWorkspace> {
	const row = await readWorkspaceByKey(getDb(), key);

	return { id: row.id, key: row.key, name: row.name };
}

/** Процесс учебных заведений: четырнадцать стадий и его действующая редакция. */
async function demoRoute(): Promise<ProcessRevisionView> {
	await database.db.transaction((tx) => ensureWorkflow(tx, B2B_WORKSPACE_KEY, B2B_PROCESS));

	return requireActiveRevisionForWorkspace(
		getDb(),
		(await readWorkspaceByKey(getDb(), B2B_WORKSPACE_KEY)).id
	);
}

/**
 * Процесс из двух стадий, у которого объяснения требует именно шаг вперёд. В
 * процессе учебных заведений такого перехода нет, а доска обязана спрашивать
 * объяснение у любого перехода, который его требует, а не только у возврата.
 * Группа другая, потому что в одной группе действует ровно один процесс.
 */
async function reasonRoute(): Promise<ProcessRevisionView> {
	await database.db.transaction((tx) =>
		ensureWorkflow(tx, B2C_WORKSPACE_KEY, {
			name: 'Процесс с объяснением шага вперёд',
			note: null,
			migrationRules: [],
			stages: [
				{
					key: 'first',
					name: 'Первая стадия',
					category: 'contact',
					slaDays: 5,
					staleAfterDays: null,
					requiresResult: false,
					requiresConfirmation: false,
					requiresLmsData: false,
					requiresDocumentMark: null,
					isFinal: false,
					checklist: []
				},
				{
					key: 'second',
					name: 'Вторая стадия',
					category: 'control',
					slaDays: 5,
					staleAfterDays: null,
					requiresResult: false,
					requiresConfirmation: false,
					requiresLmsData: false,
					requiresDocumentMark: null,
					isFinal: true,
					checklist: []
				}
			],
			transitions: [
				{
					fromStageKey: 'first',
					toStageKey: 'second',
					kind: 'forward',
					requiredPermissionKey: 'stages.transition',
					requiresReason: true
				}
			]
		})
	);

	return requireActiveRevisionForWorkspace(
		getDb(),
		(await readWorkspaceByKey(getDb(), B2C_WORKSPACE_KEY)).id
	);
}

function stageIdOf(route: ProcessRevisionView, key: string): string {
	const stage = route.stages.find((candidate) => candidate.key === key);

	if (stage === undefined) {
		throw new Error(`В процессе нет стадии «${key}»`);
	}

	return stage.id;
}

function columnOf(board: InteractionBoardView, name: string) {
	const column = board.columns.find((candidate) => candidate.name === name);

	if (column === undefined) {
		throw new Error(`На доске нет колонки «${name}»`);
	}

	return column;
}

/**
 * Взаимодействие с одним контрагентом; процесс сразу ставит его на первую
 * стадию. Группа выводится из вида организации, а не задаётся параметром.
 */
async function makeInteraction(
	ctx: ActorContext,
	options: {
		title: string;
		organizationId: string;
		ownerUserId?: string;
		programIds?: string[];
		partyRole?: 'educational_institution' | 'customer';
	}
): Promise<string> {
	const created = await createInteraction(
		ctx,
		createInteractionSchema.parse({
			title: options.title,
			ownerUserId: options.ownerUserId ?? TEST_USER_IDS.admin,
			parties: [
				{
					organizationId: options.organizationId,
					partyRole: options.partyRole ?? 'educational_institution',
					isPrimary: true
				}
			],
			programs: (options.programIds ?? []).map((programId) => ({ programId }))
		})
	);

	return created.id;
}

/**
 * Сдвигает вход на текущую стадию в прошлое. Срок считает база от `entered_at`,
 * поэтому просрочку в тесте делают именно так, а не подменой часов процесса.
 */
async function enteredDaysAgo(interactionId: string, days: number): Promise<void> {
	await database.db
		.update(stageEntries)
		.set({ enteredAt: daysFrom(new Date(), -days) })
		.where(and(eq(stageEntries.interactionId, interactionId), isNull(stageEntries.leftAt)));
}

async function currentStageId(ctx: ActorContext, interactionId: string): Promise<string> {
	const status = await getInteractionStatus(ctx, interactionId);

	if (status.current === null) {
		throw new Error('У взаимодействия нет открытой стадии');
	}

	return status.current.stageId;
}

/** Закрывает обязательные пункты чек-листа текущей стадии. */
async function closeChecklist(ctx: ActorContext, interactionId: string): Promise<void> {
	const status = await getInteractionStatus(ctx, interactionId);

	if (status.current === null) {
		throw new Error('У взаимодействия нет открытой стадии');
	}

	for (const item of status.current.snapshot.checklist.filter((entry) => entry.required)) {
		await setChecklistItem(ctx, { interactionId, key: item.key, done: true });
	}
}

function transitionEvent(
	form: Record<string, string>,
	roleId = 'manager',
	permissions?: readonly PermissionKey[]
): RequestEvent {
	return pageEvent({ path: '/interactions', form, user: sessionUser(roleId, permissions) });
}

describe('выборка доски', () => {
	it('раскладывает взаимодействия по стадиям действующего процесса', async () => {
		const ctx = admin();
		const route = await demoRoute();
		const organizationId = await insertOrganization(database.db, { shortName: 'Первый вуз' });

		const first = await makeInteraction(ctx, {
			title: 'Первое взаимодействие',
			organizationId
		});
		await makeInteraction(ctx, {
			title: 'Второе взаимодействие',
			organizationId
		});

		await closeChecklist(ctx, first);

		const board = await getInteractionBoard(ctx, await workspaceOf(B2B_WORKSPACE_KEY), query());

		expect(board.workspaceKey).toBe(B2B_WORKSPACE_KEY);
		expect(board.columns).toHaveLength(route.stages.length);
		// Порядок колонок задаёт процесс: первая стадия слева, последняя справа.
		expect(board.columns.at(0)?.name).toBe('Поиск контактных лиц');
		expect(board.columns.at(-1)?.name).toBe('Контроль исполнения');

		const contacts = columnOf(board, 'Поиск контактных лиц');

		expect(contacts.count).toBe(2);
		expect(contacts.cards.map((card) => card.title).sort()).toEqual([
			'Второе взаимодействие',
			'Первое взаимодействие'
		]);
		// Стадия, на которой никого нет, остаётся колонкой: «здесь пусто» — это
		// ответ, а исчезнувшая колонка выглядит как исчезнувший участок процесса.
		expect(columnOf(board, 'Подписание соглашения')).toMatchObject({ count: 0, cards: [] });
	});

	it('считает просроченные и называет состояние карточки', async () => {
		const ctx = admin();
		await demoRoute();
		const organizationId = await insertOrganization(database.db, { shortName: 'Вуз со сроком' });

		const late = await makeInteraction(ctx, {
			title: 'Просроченное',
			organizationId
		});
		const paused = await makeInteraction(ctx, {
			title: 'На паузе',
			organizationId
		});
		await makeInteraction(ctx, { title: 'В срок', organizationId });

		// Норматив первой стадии — семь дней.
		await enteredDaysAgo(late, 30);
		await pauseStage(ctx, {
			interactionId: paused,
			fromStageId: await currentStageId(ctx, paused),
			reason: 'waiting_counterparty',
			waitingPartyId: null,
			nextAction: null,
			note: 'Ждём ответа приёмной комиссии'
		});

		const board = await getInteractionBoard(ctx, await workspaceOf(B2B_WORKSPACE_KEY), query());
		const contacts = columnOf(board, 'Поиск контактных лиц');
		const states = new Map(contacts.cards.map((card) => [card.title, card.state]));

		expect(contacts.count).toBe(3);
		expect(contacts.overdue).toBe(1);
		expect(states.get('Просроченное')).toBe('overdue');
		expect(states.get('На паузе')).toBe('paused');
		expect(states.get('В срок')).toBe('current');
	});

	it('говорит, сколько дел на стадии, даже когда показывает не все', async () => {
		const ctx = admin();
		await demoRoute();
		const organizationId = await insertOrganization(database.db, { shortName: 'Многолюдный вуз' });

		for (let index = 0; index < CARDS_PER_COLUMN + 3; index += 1) {
			await makeInteraction(ctx, {
				title: `Взаимодействие ${index}`,
				organizationId
			});
		}

		const contacts = columnOf(
			await getInteractionBoard(ctx, await workspaceOf(B2B_WORKSPACE_KEY), query()),
			'Поиск контактных лиц'
		);

		expect(contacts.count).toBe(CARDS_PER_COLUMN + 3);
		expect(contacts.cards).toHaveLength(CARDS_PER_COLUMN);
	});

	it('показывает на карточке организацию, программу и ответственного', async () => {
		const ctx = admin();
		await demoRoute();
		const organizationId = await insertOrganization(database.db, { shortName: 'Вуз с программой' });

		const [program] = await database.db
			.insert(programs)
			.values({ code: 'TEST-01', name: 'Прикладная информатика', level: 'bachelor' })
			.returning({ id: programs.id });

		const interactionId = await makeInteraction(ctx, {
			title: 'С программой',
			organizationId,
			ownerUserId: TEST_USER_IDS.manager,
			programIds: [program.id]
		});

		const board = await getInteractionBoard(ctx, await workspaceOf(B2B_WORKSPACE_KEY), query());
		const card = columnOf(board, 'Поиск контактных лиц').cards.find(
			(candidate) => candidate.id === interactionId
		);

		expect(card).toMatchObject({
			organizationName: 'Вуз с программой',
			offerings: ['Прикладная информатика'],
			ownerName: 'Тестовый Менеджер'
		});
	});

	it('держится области доступа: чужие записи не попадают ни в карточки, ни в счётчики', async () => {
		const ctx = admin();
		await demoRoute();
		const mine = await insertOrganization(database.db, { shortName: 'Мой вуз' });
		const foreign = await insertOrganization(database.db, { shortName: 'Чужой вуз' });

		await makeInteraction(ctx, { title: 'Моё', organizationId: mine });
		await makeInteraction(ctx, { title: 'Чужое', organizationId: foreign });

		const scoped = await scopedActor(database.db, { roleId: 'manager', organizationIds: [mine] });
		const contacts = columnOf(
			await getInteractionBoard(scoped, await workspaceOf(B2B_WORKSPACE_KEY), query()),
			'Поиск контактных лиц'
		);

		expect(contacts.count).toBe(1);
		expect(contacts.cards.map((card) => card.title)).toEqual(['Моё']);
	});

	it('применяет те же фильтры, что и список', async () => {
		const ctx = admin();
		await demoRoute();
		const first = await insertOrganization(database.db, { shortName: 'Северный институт' });
		const second = await insertOrganization(database.db, { shortName: 'Южный колледж' });

		const late = await makeInteraction(ctx, {
			title: 'Северное дело',
			organizationId: first
		});
		await makeInteraction(ctx, {
			title: 'Южное дело',
			organizationId: second,
			ownerUserId: TEST_USER_IDS.manager
		});

		await enteredDaysAgo(late, 30);

		const overdue = await getInteractionBoard(
			ctx,
			await workspaceOf(B2B_WORKSPACE_KEY),
			query({ overdue: true })
		);
		expect(overdue.total).toBe(1);
		expect(columnOf(overdue, 'Поиск контактных лиц').count).toBe(1);

		const searched = await getInteractionBoard(
			ctx,
			await workspaceOf(B2B_WORKSPACE_KEY),
			query({ q: 'Южный' })
		);
		expect(searched.columns.flatMap((column) => column.cards).map((card) => card.title)).toEqual([
			'Южное дело'
		]);

		const owned = await getInteractionBoard(
			ctx,
			await workspaceOf(B2B_WORKSPACE_KEY),
			query({ ownerUserId: TEST_USER_IDS.manager })
		);
		expect(owned.total).toBe(1);

		// Завершённых на доске нет: они не стоят ни на одной стадии.
		const completed = await getInteractionBoard(
			ctx,
			await workspaceOf(B2B_WORKSPACE_KEY),
			query({ status: 'completed' })
		);
		expect(completed.total).toBe(0);
	});

	it('несёт переходы с приговором движка', async () => {
		const ctx = manager();
		await demoRoute();
		const organizationId = await insertOrganization(database.db, { shortName: 'Вуз с чек-листом' });

		const interactionId = await makeInteraction(ctx, {
			title: 'С незакрытым чек-листом',
			organizationId,
			ownerUserId: TEST_USER_IDS.manager
		});

		const before = columnOf(
			await getInteractionBoard(ctx, await workspaceOf(B2B_WORKSPACE_KEY), query()),
			'Поиск контактных лиц'
		);
		const forward = before.cards[0].transitions.find((option) => option.kind === 'forward');

		expect(forward).toMatchObject({
			toStageName: 'Коммуникация и сверка программ',
			allowed: false
		});
		expect(forward?.reasons.join(' ')).toContain('чек-листа');

		await closeChecklist(ctx, interactionId);

		const after = columnOf(
			await getInteractionBoard(ctx, await workspaceOf(B2B_WORKSPACE_KEY), query()),
			'Поиск контактных лиц'
		);

		expect(after.cards[0].transitions.find((option) => option.kind === 'forward')?.allowed).toBe(
			true
		);
	});

	it('загрузчик раздела отдаёт доску по параметру адреса', async () => {
		const ctx = admin();
		await demoRoute();
		const organizationId = await insertOrganization(database.db, { shortName: 'Вуз раздела' });

		await makeInteraction(ctx, { title: 'Дело раздела', organizationId });

		const workspace = await workspaceOf(B2B_WORKSPACE_KEY);

		const data = (await loadList(
			pageEvent({
				path: `/w/${workspace.key}/interactions`,
				query: '?view=board',
				routeId: '/(app)/w/[workspace]/interactions',
				params: { workspace: workspace.key },
				parent: { workspace: { ...workspace, hasWorkflow: true } }
			})
		)) as {
			view: string;
			board: InteractionBoardView;
			canTransition: boolean;
		};

		expect(data.view).toBe('board');
		expect(data.canTransition).toBe(true);
		expect(columnOf(data.board, 'Поиск контактных лиц').count).toBe(1);
	});
});

describe('перевод карточки', () => {
	it('двигает взаимодействие в соседнюю колонку', async () => {
		const ctx = manager();
		const route = await demoRoute();
		const organizationId = await insertOrganization(database.db, { shortName: 'Вуз перевода' });

		const interactionId = await makeInteraction(ctx, {
			title: 'Готовое к переходу',
			organizationId,
			ownerUserId: TEST_USER_IDS.manager
		});

		await closeChecklist(ctx, interactionId);

		const moved = await transitionAction(
			transitionEvent({
				interactionId,
				fromStageId: stageIdOf(route, 'contact_search'),
				toStageId: stageIdOf(route, 'communication'),
				kind: 'forward',
				revision: String(route.version)
			})
		);

		expect(moved).toEqual({ moved: true });

		const board = await getInteractionBoard(ctx, await workspaceOf(B2B_WORKSPACE_KEY), query());

		expect(columnOf(board, 'Поиск контактных лиц').count).toBe(0);
		expect(columnOf(board, 'Коммуникация и сверка программ').cards.map((card) => card.id)).toEqual([
			interactionId
		]);
	});

	it('отказывает без права перевода и оставляет карточку на месте', async () => {
		const ctx = admin();
		const route = await demoRoute();
		const organizationId = await insertOrganization(database.db, { shortName: 'Вуз наблюдателя' });

		const interactionId = await makeInteraction(ctx, {
			title: 'Чужая работа',
			organizationId
		});

		await closeChecklist(ctx, interactionId);

		const result = await transitionAction(
			transitionEvent(
				{
					interactionId,
					fromStageId: stageIdOf(route, 'contact_search'),
					toStageId: stageIdOf(route, 'communication'),
					kind: 'forward',
					revision: String(route.version)
				},
				'manager',
				['interactions.read']
			)
		);

		// Отказ по правам — это «нельзя вам», а не «нельзя сейчас»: 403, а не 409.
		expect(result).toMatchObject({ status: 403 });
		expect((result as { data: { message: string } }).data.message).toContain('stages.transition');
		expect(await currentStageId(ctx, interactionId)).toBe(stageIdOf(route, 'contact_search'));

		// И доска тому, у кого права нет, про этот переход честно говорит то же самое.
		const observer = testActor({ roleId: 'manager', permissions: ['interactions.read'] });
		const card = columnOf(
			await getInteractionBoard(observer, await workspaceOf(B2B_WORKSPACE_KEY), query()),
			'Поиск контактных лиц'
		).cards[0];

		expect(card.transitions.every((option) => !option.allowed)).toBe(true);
		expect(card.transitions[0].reasons.join(' ')).toContain('stages.transition');
	});

	it('не переводит стадию, которая к переходу не готова', async () => {
		const ctx = manager();
		const route = await demoRoute();
		const organizationId = await insertOrganization(database.db, { shortName: 'Вуз с чек-листом' });

		const interactionId = await makeInteraction(ctx, {
			title: 'Не готовое',
			organizationId,
			ownerUserId: TEST_USER_IDS.manager
		});

		const result = await transitionAction(
			transitionEvent({
				interactionId,
				fromStageId: stageIdOf(route, 'contact_search'),
				toStageId: stageIdOf(route, 'communication'),
				kind: 'forward',
				revision: String(route.version)
			})
		);

		expect(result).toMatchObject({ status: 409 });
		expect((result as { data: { message: string } }).data.message).toContain('чек-листа');
		expect(await currentStageId(ctx, interactionId)).toBe(stageIdOf(route, 'contact_search'));
	});

	it('требует причину у возврата и принимает её', async () => {
		const ctx = manager();
		const route = await demoRoute();
		const organizationId = await insertOrganization(database.db, { shortName: 'Вуз возврата' });

		const interactionId = await makeInteraction(ctx, {
			title: 'Вернём назад',
			organizationId,
			ownerUserId: TEST_USER_IDS.manager
		});

		await closeChecklist(ctx, interactionId);
		await transitionAction(
			transitionEvent({
				interactionId,
				fromStageId: stageIdOf(route, 'contact_search'),
				toStageId: stageIdOf(route, 'communication'),
				kind: 'forward',
				revision: String(route.version)
			})
		);

		const withoutReason = await transitionAction(
			transitionEvent({
				interactionId,
				fromStageId: stageIdOf(route, 'communication'),
				toStageId: stageIdOf(route, 'contact_search'),
				kind: 'return',
				revision: String(route.version)
			})
		);

		expect(withoutReason).toMatchObject({ status: 400 });
		expect((withoutReason as { data: { issues: string[] } }).data.issues.join(' ')).toContain(
			'почему'
		);

		const withReason = await transitionAction(
			transitionEvent({
				interactionId,
				fromStageId: stageIdOf(route, 'communication'),
				toStageId: stageIdOf(route, 'contact_search'),
				kind: 'return',
				revision: String(route.version),
				reason: 'Контакт оказался не тем подразделением'
			})
		);

		expect(withReason).toEqual({ moved: true });
		expect(await currentStageId(ctx, interactionId)).toBe(stageIdOf(route, 'contact_search'));
	});

	it('требует объяснение у шага вперёд, если так настроен процесс', async () => {
		const ctx = manager();
		const route = await reasonRoute();
		const organizationId = await insertOrganization(database.db, {
			shortName: 'Заказчик с объяснением шага',
			kind: 'legal_entity'
		});

		const interactionId = await makeInteraction(ctx, {
			title: 'Шаг вперёд с объяснением',
			organizationId,
			partyRole: 'customer',
			ownerUserId: TEST_USER_IDS.manager
		});

		// Карточка знает о требовании заранее: доска спрашивает объяснение до
		// команды, а не показывает отказ после неё.
		const board = await getInteractionBoard(ctx, await workspaceOf(B2C_WORKSPACE_KEY), query());
		const card = columnOf(board, 'Первая стадия').cards[0];

		expect(card.transitions[0]).toMatchObject({
			kind: 'forward',
			requiresReason: true,
			allowed: true
		});

		const move = {
			interactionId,
			fromStageId: stageIdOf(route, 'first'),
			toStageId: stageIdOf(route, 'second'),
			kind: 'forward',
			revision: String(route.version)
		};

		const withoutReason = await transitionAction(transitionEvent(move));

		expect(withoutReason).toMatchObject({ status: 409 });
		expect((withoutReason as { data: { message: string } }).data.message).toContain(
			'Нужно объяснить причину'
		);
		expect(await currentStageId(ctx, interactionId)).toBe(stageIdOf(route, 'first'));

		const withReason = await transitionAction(
			transitionEvent({ ...move, reason: 'Договорённости зафиксированы протоколом' })
		);

		expect(withReason).toEqual({ moved: true });
		expect(await currentStageId(ctx, interactionId)).toBe(stageIdOf(route, 'second'));
	});

	it('не берёт вид перехода, которого нет', async () => {
		const route = await demoRoute();
		const organizationId = await insertOrganization(database.db, { shortName: 'Вуз без перехода' });

		const interactionId = await makeInteraction(manager(), {
			title: 'Никуда',
			organizationId,
			ownerUserId: TEST_USER_IDS.manager
		});

		const result = await transitionAction(
			transitionEvent({
				interactionId,
				fromStageId: stageIdOf(route, 'contact_search'),
				toStageId: stageIdOf(route, 'communication'),
				kind: 'sideways',
				revision: String(route.version)
			})
		);

		expect(result).toMatchObject({ status: 400 });
		expect((result as { data: { message: string } }).data.message).toContain('вид перехода');
	});
});
