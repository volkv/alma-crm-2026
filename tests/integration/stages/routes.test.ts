/**
 * Экран маршрутов на настоящей базе: список версий, карточка, новая версия и
 * публикация.
 *
 * Проверяются и сервисы, и загрузчики с действиями страницы: право на раздел,
 * сборка конфигурации из формы и перевод предметного отказа в текст живут в
 * маршруте, а не в сервисе, и ошибиться можно только там.
 */
import type { RequestEvent } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	createInteractionSchema,
	type StageRouteView,
	type StageView
} from '$lib/contracts/interactions';
import type { ActorContext } from '$lib/server/actor';
import { auditEvents, stageRoutes, stageTransitions } from '$lib/server/db/schema';
import { ConflictError, ForbiddenError, ValidationError } from '$lib/server/errors';
import { createInteraction } from '$lib/server/interactions/write';
import { cancelInteraction } from '$lib/server/stages/commands';
import {
	createDraftFrom,
	createRoute,
	ensureDemoRoute,
	getRouteDetail,
	listRoutes,
	publishRoute,
	setDefaultRoute,
	validateRouteDraft
} from '$lib/server/stages/routes';
import { DEMO_ROUTE, DEMO_ROUTE_KEY } from '$lib/server/stages/demo-route';
import {
	insertOrganization,
	startTestDatabase,
	testActor,
	TEST_USER_IDS,
	type TestDatabase
} from '../helpers/db';
import { pageEvent, sessionUser } from '../helpers/event';

// См. комментарий в `helpers/db.ts`: без этого сервисы пойдут в базу разработчика.
vi.mock('$env/dynamic/private', () => ({ env: process.env }));

/** Загрузчик и действие маршрута типизированы своим маршрутом; подделка — общим. */
type PageLoad = (event: RequestEvent) => Promise<unknown>;
type FormAction = (event: RequestEvent) => Promise<unknown>;

const listPage = await import('../../../src/routes/(app)/settings/routes/+page.server');
const detailPage = await import('../../../src/routes/(app)/settings/routes/[id=uuid]/+page.server');

const loadList = listPage.load as unknown as PageLoad;
const loadDetail = detailPage.load as unknown as PageLoad;
const stageAction = detailPage.actions.stage as unknown as FormAction;
const deleteStageAction = detailPage.actions.deleteStage as unknown as FormAction;
const publishAction = detailPage.actions.publish as unknown as FormAction;

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

/** Демонстрационный маршрут в базе: с него начинается любая настройка. */
async function demoRoute(): Promise<string> {
	return database.db.transaction((tx) => ensureDemoRoute(tx));
}

/** Активное взаимодействие на версии маршрута. */
async function startInteractionOn(ctx: ActorContext, routeId: string): Promise<string> {
	const organizationId = await insertOrganization(database.db, { shortName: 'Вуз маршрута' });

	const interaction = await createInteraction(
		ctx,
		createInteractionSchema.parse({
			title: 'Подготовка специалистов',
			routeId,
			ownerUserId: TEST_USER_IDS.admin,
			parties: [{ organizationId, partyRole: 'educational_institution', isPrimary: true }]
		})
	);

	return interaction.id;
}

type RouteSummary = {
	id: string;
	key: string;
	version: number;
	isDefault: boolean;
	publishedAt: Date | null;
	stageCount: number;
	activeInteractions: number;
};

type ListData = { routes: RouteSummary[] };

type DetailData = {
	detail: {
		route: StageRouteView;
		activeInteractions: number;
		draft: { id: string; version: number } | null;
		issues: string[];
	};
};

/** Претензии формы, собранные действием: и общие, и по полям. */
function formErrors(result: unknown): string[] {
	const outcome = result as {
		data?: { form?: { errors?: Record<string, string[]> } };
		form?: { errors?: Record<string, string[]> };
	};
	const errors = outcome.data?.form?.errors ?? outcome.form?.errors;

	if (errors === undefined) {
		throw new Error(`Действие не вернуло форму: ${JSON.stringify(result)}`);
	}

	return Object.values(errors).flat();
}

/** Поля формы стадии в том виде, в каком их шлёт браузер: строками. */
function stageForm(overrides: Record<string, string> = {}): Record<string, string> {
	return {
		originalKey: '',
		position: '1',
		key: 'pilot',
		name: 'Пилотное согласование',
		category: 'documents',
		slaDays: '5',
		staleAfterDays: '0',
		checklist: '',
		...overrides
	};
}

describe('список маршрутов', () => {
	it('отдаёт версии со счётчиками стадий и активных взаимодействий', async () => {
		const ctx = admin();
		const routeId = await demoRoute();
		await startInteractionOn(ctx, routeId);

		const data = (await loadList(pageEvent({ path: '/settings/routes' }))) as ListData;
		const demo = data.routes.find((route) => route.id === routeId);

		expect(demo).toMatchObject({
			key: DEMO_ROUTE_KEY,
			version: 1,
			isDefault: true,
			stageCount: DEMO_ROUTE.stages.length,
			activeInteractions: 1
		});
		expect(demo?.publishedAt).not.toBeNull();
	});

	it('закрыт для роли без права на настройку и оставляет след отказа', async () => {
		await demoRoute();

		await expect(
			loadList(pageEvent({ path: '/settings/routes', user: sessionUser('manager') }))
		).rejects.toMatchObject({ status: 403 });

		// Загрузчик отвечает отказом раньше сервиса, поэтому след в журнале
		// оставляет сам сервис: правило одно, а мест применения два.
		await expect(listRoutes(testActor({ roleId: 'manager' }))).rejects.toBeInstanceOf(
			ForbiddenError
		);

		const denied = await database.db
			.select({ outcome: auditEvents.outcome, actorUserId: auditEvents.actorUserId })
			.from(auditEvents)
			.where(eq(auditEvents.eventType, 'stages.routes_viewed'));

		expect(denied).toEqual([{ outcome: 'denied', actorUserId: TEST_USER_IDS.manager }]);
	});
});

describe('карточка версии', () => {
	it('считает взаимодействия, которые идут по этой версии прямо сейчас', async () => {
		const ctx = admin();
		const routeId = await demoRoute();
		const interactionId = await startInteractionOn(ctx, routeId);

		const opened = (await loadDetail(
			pageEvent({ path: `/settings/routes/${routeId}`, params: { id: routeId } })
		)) as DetailData;

		expect(opened.detail.activeInteractions).toBe(1);
		expect(opened.detail.route.stages).toHaveLength(DEMO_ROUTE.stages.length);
		expect(opened.detail.route.transitions).toHaveLength(DEMO_ROUTE.transitions.length);
		expect(opened.detail.draft).toBeNull();

		await cancelInteraction(ctx, { interactionId, reason: 'Вуз отказался от программы' });

		const afterCancel = (await getRouteDetail(ctx, routeId)).activeInteractions;

		// Закрытая запись версию больше не держит: счётчик отвечает на вопрос
		// «по чему сейчас работают», а не «кто когда-либо на неё ссылался».
		expect(afterCancel).toBe(0);
	});

	it('отдаёт 404 на версию, которой нет', async () => {
		const absent = '00000000-0000-4000-8000-0000000000ff';

		await expect(
			loadDetail(pageEvent({ path: `/settings/routes/${absent}`, params: { id: absent } }))
		).rejects.toMatchObject({ status: 404 });
	});
});

describe('новая версия', () => {
	it('копирует стадии и переходы черновиком', async () => {
		const ctx = admin();
		const source = await getRouteDetail(ctx, await demoRoute());
		const draft = await createDraftFrom(ctx, source.route.id);

		expect(draft.key).toBe(source.route.key);
		expect(draft.version).toBe(source.route.version + 1);
		expect(draft.publishedAt).toBeNull();
		// Признак «по умолчанию» остаётся у той версии, по которой сейчас заводят
		// взаимодействия: на черновик запись поставить нельзя.
		expect(draft.isDefault).toBe(false);

		expect(draft.stages.map((stage: StageView) => stage.key)).toEqual(
			source.route.stages.map((stage) => stage.key)
		);
		expect(draft.stages.map((stage: StageView) => stage.position)).toEqual(
			source.route.stages.map((stage) => stage.position)
		);
		expect(draft.transitions).toHaveLength(source.route.transitions.length);

		const keyById = new Map(draft.stages.map((stage: StageView) => [stage.id, stage.key]));
		const sourceKeyById = new Map(source.route.stages.map((stage) => [stage.id, stage.key]));
		const pairs = (route: StageRouteView, keys: Map<string, string>): string[] =>
			route.transitions
				.map(
					(transition) =>
						`${keys.get(transition.fromStageId)}→${keys.get(transition.toStageId)}:${transition.kind}`
				)
				.sort();

		expect(pairs(draft, keyById)).toEqual(pairs(source.route, sourceKeyById));
	});

	it('не заводит второй черновик того же маршрута', async () => {
		const ctx = admin();
		const routeId = await demoRoute();

		await createDraftFrom(ctx, routeId);

		await expect(createDraftFrom(ctx, routeId)).rejects.toBeInstanceOf(ConflictError);

		// Карточка опубликованной версии объясняет отказ до нажатия: у маршрута
		// уже есть черновик, и работать надо в нём.
		const detail = (await loadDetail(
			pageEvent({ path: `/settings/routes/${routeId}`, params: { id: routeId } })
		)) as DetailData;

		expect(detail.detail.draft).toMatchObject({ version: 2 });
	});
});

describe('правка черновика', () => {
	it('добавляет стадию на указанное место', async () => {
		const ctx = admin();
		const draft = await createDraftFrom(ctx, await demoRoute());

		const result = await stageAction(
			pageEvent({
				path: `/settings/routes/${draft.id}`,
				params: { id: draft.id },
				form: stageForm({
					position: '2',
					checklist: '* draft_sent: Проект соглашения отправлен\nreview_done: Замечания собраны'
				})
			})
		);

		expect(result).toMatchObject({ form: { valid: true } });

		const updated = (await getRouteDetail(ctx, draft.id)).route;
		const added = updated.stages.find((stage) => stage.key === 'pilot');

		expect(added).toMatchObject({ position: 2, name: 'Пилотное согласование', slaDays: 5 });
		// Ноль в поле означает «не протухает», а в базе это пусто: двух видов
		// «пусто» в столбце не появляется.
		expect(added?.staleAfterDays).toBeNull();
		expect(added?.checklist).toEqual([
			{ key: 'draft_sent', label: 'Проект соглашения отправлен', required: true },
			{ key: 'review_done', label: 'Замечания собраны', required: false }
		]);
		expect(updated.stages).toHaveLength(DEMO_ROUTE.stages.length + 1);
	});

	it('объясняет непонятную строку чек-листа номером строки', async () => {
		const ctx = admin();
		const draft = await createDraftFrom(ctx, await demoRoute());

		const result = await stageAction(
			pageEvent({
				path: `/settings/routes/${draft.id}`,
				params: { id: draft.id },
				form: stageForm({ checklist: 'Проект соглашения отправлен' })
			})
		);

		expect(formErrors(result).join(' ')).toContain('Строка 1');
	});

	it('не удаляет стадию, которую держат переходы', async () => {
		const ctx = admin();
		const draft = await createDraftFrom(ctx, await demoRoute());

		const result = await deleteStageAction(
			pageEvent({
				path: `/settings/routes/${draft.id}`,
				params: { id: draft.id },
				form: { key: 'meeting' }
			})
		);

		expect(result).toMatchObject({ status: 409 });
		expect((result as { data: { issues: string[] } }).data.issues.length).toBeGreaterThan(0);

		// Отказ — это отказ: стадия осталась на месте.
		const stillThere = (await getRouteDetail(ctx, draft.id)).route.stages.some(
			(stage) => stage.key === 'meeting'
		);
		expect(stillThere).toBe(true);
	});

	it('отказывает в правке опубликованной версии словами', async () => {
		const routeId = await demoRoute();

		const result = await stageAction(
			pageEvent({
				path: `/settings/routes/${routeId}`,
				params: { id: routeId },
				form: stageForm()
			})
		);

		expect(formErrors(result).join(' ')).toContain('Опубликованный маршрут изменить нельзя');
	});
});

describe('публикация', () => {
	it('не публикует маршрут, из которого некуда идти', async () => {
		const ctx = admin();

		const draft = await createRoute(ctx, {
			key: 'two-stage-route',
			name: 'Маршрут из двух стадий',
			description: null,
			isDefault: false,
			stages: [
				{
					key: 'first',
					name: 'Первая стадия',
					category: 'contact',
					slaDays: 5,
					staleAfterDays: null,
					requiresResult: false,
					requiresConfirmation: false,
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
					checklist: []
				}
			],
			transitions: []
		});

		const failure = await publishRoute(ctx, draft.id).catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(ValidationError);
		expect((failure as ValidationError).issues.join(' ')).toContain('нет перехода вперёд');

		// Отказ ничего не опубликовал: версия осталась черновиком.
		const [row] = await database.db
			.select({ publishedAt: stageRoutes.publishedAt })
			.from(stageRoutes)
			.where(eq(stageRoutes.id, draft.id));

		expect(row.publishedAt).toBeNull();
	});

	it('не публикует маршрут с висячим переходом', async () => {
		const ctx = admin();
		const published = await getRouteDetail(ctx, await demoRoute());
		const draft = await createDraftFrom(ctx, published.route.id);

		// Переход на стадию чужой версии: схема контракта такого не пропустит, а
		// в базе внешний ключ смотрит на любую стадию — значит, проверять надо и
		// здесь.
		await database.db.insert(stageTransitions).values({
			routeId: draft.id,
			fromStageId: draft.stages[0].id,
			toStageId: published.route.stages[3].id,
			kind: 'skip',
			requiredPermissionKey: 'stages.transition',
			requiresReason: true
		});

		const result = await publishAction(
			pageEvent({ path: `/settings/routes/${draft.id}`, params: { id: draft.id } })
		);

		expect(result).toMatchObject({ status: 400 });
		expect((result as { data: { issues: string[] } }).data.issues.join(' ')).toContain(
			'ведёт на стадию, которой нет в маршруте'
		);
	});

	it('публикует копию и передаёт ей признак маршрута по умолчанию', async () => {
		const ctx = admin();
		const routeId = await demoRoute();
		const draft = await createDraftFrom(ctx, routeId);

		const published = await publishRoute(ctx, draft.id);

		expect(published.publishedAt).not.toBeNull();
		expect(published.isDefault).toBe(false);

		await setDefaultRoute(ctx, published.id);

		const defaults = await database.db
			.select({ id: stageRoutes.id })
			.from(stageRoutes)
			.where(eq(stageRoutes.isDefault, true));

		expect(defaults).toEqual([{ id: published.id }]);

		const recorded = await database.db
			.select({ outcome: auditEvents.outcome, subjectId: auditEvents.subjectId })
			.from(auditEvents)
			.where(
				and(
					eq(auditEvents.eventType, 'stages.route_default_changed'),
					eq(auditEvents.outcome, 'success')
				)
			);

		expect(recorded).toEqual([{ outcome: 'success', subjectId: published.id }]);
	});

	it('не делает маршрутом по умолчанию черновик', async () => {
		const ctx = admin();
		const draft = await createDraftFrom(ctx, await demoRoute());

		await expect(setDefaultRoute(ctx, draft.id)).rejects.toBeInstanceOf(ConflictError);
	});
});

describe('проверка конфигурации', () => {
	/** Версия маршрута, собранная в памяти: база такую уже не примет. */
	function view(stages: StageView[], transitions: StageRouteView['transitions']): StageRouteView {
		return {
			id: 'route',
			key: 'broken',
			version: 1,
			name: 'Испорченный маршрут',
			description: null,
			isDefault: false,
			publishedAt: null,
			stages,
			transitions
		};
	}

	function stage(overrides: Partial<StageView>): StageView {
		return {
			id: crypto.randomUUID(),
			routeId: 'route',
			position: 1,
			key: 'stage',
			name: 'Стадия',
			category: 'contact',
			slaDays: 5,
			staleAfterDays: null,
			requiresResult: false,
			requiresConfirmation: false,
			checklist: [],
			...overrides
		};
	}

	it('называет повтор позиции и стадию, названную кодом своей группы', () => {
		const issues = validateRouteDraft(
			view(
				[
					stage({ key: 'a', name: 'Первый контакт', position: 1 }),
					stage({ key: 'b', name: 'contact', position: 1 })
				],
				[]
			)
		);

		expect(issues.join(' ')).toContain('Позиция 1 занята двумя стадиями');
		expect(issues.join(' ')).toContain('названа кодом своей смысловой группы');
	});

	it('молчит о маршруте из одной стадии', () => {
		expect(validateRouteDraft(view([stage({ key: 'only', name: 'Единственная' })], []))).toEqual(
			[]
		);
	});
});
