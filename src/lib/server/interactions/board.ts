/**
 * Доска взаимодействий: те же записи, что и в списке, разложенные по стадиям
 * маршрута.
 *
 * Список отвечает на вопрос «что с этой записью», доска — на вопрос «где стоит
 * работа целиком»: сколько дел висит на обмене документами и сколько из них уже
 * просрочено. Поэтому колонки здесь — стадии одной версии маршрута, а карточка
 * стоит ровно в той колонке, где открыта её запись стадии.
 *
 * Выборка — один запрос: карточки, число карточек на стадии и число
 * просроченных считаются оконными функциями за один проход, а не запросом на
 * колонку. Раскладывает их по колонкам чистая функция, поэтому порядок колонок
 * задаёт маршрут, а не то, что вернула база.
 */
import {
	and,
	asc,
	count,
	desc,
	eq,
	exists,
	ilike,
	inArray,
	isNotNull,
	isNull,
	or,
	sql
} from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type {
	BoardCardState,
	BoardTransitionOption,
	InteractionBoardCard,
	InteractionBoardColumn,
	InteractionBoardRoute,
	InteractionBoardView,
	InteractionStatus,
	StageCategory,
	StageRouteView,
	StageView
} from '$lib/contracts/interactions';
import type { ActorContext } from '../actor';
import { getDb } from '../db';
import {
	blockers,
	interactionParties,
	interactionProducts,
	interactionPrograms,
	interactions,
	organizations,
	products,
	programs,
	stageEntries,
	stageEntryStatus,
	stageRoutes,
	stages,
	users
} from '../db/schema';
import { requirePermission } from '../rbac';
import { readRoute } from '../stages/routes';
import { evaluateTransition, type StageState } from '../stages/transitions';
import { interactionScopeFilter } from './access';

/**
 * Сколько карточек показывает колонка.
 *
 * Доска — это обзор, а не список: колонка из трёхсот карточек не отвечает ни на
 * один вопрос, ради которого её открывают, зато заставляет браузер рисовать всё
 * это разом. Счётчик в шапке колонки при этом считает все карточки стадии, а не
 * показанные, — иначе число в заголовке врало бы о портфеле.
 */
export const CARDS_PER_COLUMN = 25;

/** Отбор доски: фильтры те же, что у списка, плюс версия маршрута. */
export type InteractionBoardQuery = {
	/** Версия маршрута из адреса; неизвестную заменяет маршрут по умолчанию. */
	routeId: string | null;
	status: InteractionStatus | null;
	stageCategory: StageCategory | null;
	overdue: boolean;
	ownerUserId: string | null;
	q: string | null;
};

/** Версия маршрута вместе с признаком «по умолчанию»: он решает, что открыть. */
type RouteOption = InteractionBoardRoute & { isDefault: boolean };

/**
 * Опубликованные версии маршрутов и число взаимодействий области доступа,
 * которые по ним идут. Черновики не в счёт: на них нельзя поставить запись, и
 * доска по ним всегда была бы пуста.
 */
async function readRouteOptions(ctx: ActorContext): Promise<RouteOption[]> {
	const rows = await getDb()
		.select({
			id: stageRoutes.id,
			name: stageRoutes.name,
			version: stageRoutes.version,
			isDefault: stageRoutes.isDefault,
			interactions: count(interactions.id)
		})
		.from(stageRoutes)
		.leftJoin(
			interactions,
			and(
				eq(interactions.routeId, stageRoutes.id),
				eq(interactions.status, 'active'),
				interactionScopeFilter(ctx)
			)
		)
		.where(isNotNull(stageRoutes.publishedAt))
		.groupBy(stageRoutes.id)
		.orderBy(asc(stageRoutes.key), desc(stageRoutes.version));

	return rows;
}

/**
 * Какую версию показать.
 *
 * Выбор человека сильнее всего: запрошенная версия открывается, даже если по
 * ней сейчас никто не идёт. Без выбора открывается та, на которой есть работа,
 * — маршрут по умолчанию в первую очередь; версия без единого взаимодействия
 * показала бы пустую доску там, где работа есть на соседней.
 */
export function chooseBoardRoute(
	routes: readonly RouteOption[],
	requested: string | null
): string | null {
	const asked = requested === null ? undefined : routes.find((route) => route.id === requested);

	if (asked !== undefined) {
		return asked.id;
	}

	const withWork = routes
		.filter((route) => route.interactions > 0)
		.sort((left, right) => right.interactions - left.interactions);

	const chosen =
		withWork.find((route) => route.isDefault) ??
		withWork[0] ??
		routes.find((route) => route.isDefault) ??
		routes[0];

	return chosen?.id ?? null;
}

/**
 * Условия отбора карточек. Повторяют фильтры списка (`interactions/read.ts`)
 * намеренно: доска отбирает по версии маршрута, которой в запросе списка нет,
 * и берёт из записи стадии то, что списку не нужно, — чек-лист, результат и
 * подтверждение для приговора по переходу.
 */
function boardConditions(ctx: ActorContext, routeId: string, query: InteractionBoardQuery): SQL[] {
	const conditions: SQL[] = [interactionScopeFilter(ctx), eq(stages.routeId, routeId)];

	if (query.status !== null) {
		conditions.push(eq(interactions.status, query.status));
	}

	if (query.ownerUserId !== null) {
		conditions.push(eq(interactions.ownerUserId, query.ownerUserId));
	}

	if (query.stageCategory !== null) {
		conditions.push(eq(stages.category, query.stageCategory));
	}

	if (query.overdue) {
		conditions.push(eq(stageEntryStatus.isOverdue, true));
	}

	if (query.q !== null && query.q !== '') {
		const pattern = `%${query.q}%`;
		const search = or(
			ilike(interactions.title, pattern),
			exists(
				getDb()
					.select({ one: sql`1` })
					.from(interactionParties)
					.innerJoin(organizations, eq(organizations.id, interactionParties.organizationId))
					.where(
						and(
							eq(interactionParties.interactionId, interactions.id),
							or(ilike(organizations.shortName, pattern), ilike(organizations.legalName, pattern))
						)
					)
			)
		);

		if (search !== undefined) {
			conditions.push(search);
		}
	}

	return conditions;
}

/**
 * Карточки доски одним запросом.
 *
 * `row_number()` отрезает хвост колонки, а `count(*) over` считает её целиком:
 * обрезанная колонка обязана честно сказать, сколько на ней дел. Порядок внутри
 * колонки — по сроку, потому что смотрят на доску ради того, что горит;
 * идентификатор последним ключом убирает неопределённость у одинаковых сроков.
 */
async function readBoardRows(ctx: ActorContext, routeId: string, query: InteractionBoardQuery) {
	const db = getDb();

	const ranked = db
		.select({
			id: interactions.id,
			title: interactions.title,
			ownerName: users.fullName,
			stageId: stageEntries.stageId,
			checklistState: stageEntries.checklistState,
			resultText: stageEntries.resultText,
			confirmation: stageEntries.confirmation,
			snapshot: stageEntries.stageSnapshot,
			dueAt: stageEntryStatus.dueAt,
			isOverdue: stageEntryStatus.isOverdue,
			isPaused: stageEntryStatus.isPaused,
			place: sql<number>`(row_number() over (
				partition by ${stageEntries.stageId}
				order by ${stageEntryStatus.dueAt} asc, ${interactions.id} asc
			))::int`.as('place'),
			stageCount: sql<number>`(count(*) over (partition by ${stageEntries.stageId}))::int`.as(
				'stage_count'
			),
			stageOverdue:
				sql<number>`(count(*) filter (where ${stageEntryStatus.isOverdue}) over (partition by ${stageEntries.stageId}))::int`.as(
					'stage_overdue'
				)
		})
		.from(interactions)
		.innerJoin(users, eq(users.id, interactions.ownerUserId))
		.innerJoin(
			stageEntries,
			and(eq(stageEntries.interactionId, interactions.id), isNull(stageEntries.leftAt))
		)
		.innerJoin(stages, eq(stages.id, stageEntries.stageId))
		.innerJoin(stageEntryStatus, eq(stageEntryStatus.stageEntryId, stageEntries.id))
		.where(and(...boardConditions(ctx, routeId, query)))
		.as('board');

	return db
		.select()
		.from(ranked)
		.where(sql`${ranked.place} <= ${CARDS_PER_COLUMN}`)
		.orderBy(asc(ranked.place));
}

/**
 * Учебное заведение взаимодействия. Стороны приезжают отдельным запросом, а не
 * соединением с выборкой: их у записи несколько, и соединение размножило бы
 * карточки по числу сторон.
 */
async function readOrganizationNames(interactionIds: string[]): Promise<Map<string, string>> {
	if (interactionIds.length === 0) {
		return new Map();
	}

	const rows = await getDb()
		.select({
			interactionId: interactionParties.interactionId,
			partyRole: interactionParties.partyRole,
			name: organizations.shortName
		})
		.from(interactionParties)
		.innerJoin(organizations, eq(organizations.id, interactionParties.organizationId))
		.where(inArray(interactionParties.interactionId, interactionIds))
		.orderBy(desc(interactionParties.isPrimary));

	const institutions = new Map<string, string>();
	const anyParty = new Map<string, string>();

	for (const row of rows) {
		if (!anyParty.has(row.interactionId)) {
			anyParty.set(row.interactionId, row.name);
		}

		if (row.partyRole === 'educational_institution' && !institutions.has(row.interactionId)) {
			institutions.set(row.interactionId, row.name);
		}
	}

	const result = new Map<string, string>();

	for (const interactionId of interactionIds) {
		// Учебное заведение — то, ради чего запись завели; если его ещё нет,
		// карточка называет ту сторону, которая есть, а не молчит.
		const name = institutions.get(interactionId) ?? anyParty.get(interactionId);

		if (name !== undefined) {
			result.set(interactionId, name);
		}
	}

	return result;
}

/** Программы и продукты карточки: чем именно занимаемся с этим вузом. */
async function readOfferings(interactionIds: string[]): Promise<Map<string, string[]>> {
	if (interactionIds.length === 0) {
		return new Map();
	}

	const db = getDb();

	const [programRows, productRows] = await Promise.all([
		db
			.select({ interactionId: interactionPrograms.interactionId, name: programs.name })
			.from(interactionPrograms)
			.innerJoin(programs, eq(programs.id, interactionPrograms.programId))
			.where(inArray(interactionPrograms.interactionId, interactionIds))
			.orderBy(asc(programs.code)),
		db
			.select({ interactionId: interactionProducts.interactionId, name: products.name })
			.from(interactionProducts)
			.innerJoin(products, eq(products.id, interactionProducts.productId))
			.where(inArray(interactionProducts.interactionId, interactionIds))
			.orderBy(asc(products.code))
	]);

	const result = new Map<string, string[]>();

	for (const row of [...programRows, ...productRows]) {
		const list = result.get(row.interactionId) ?? [];
		list.push(row.name);
		result.set(row.interactionId, list);
	}

	return result;
}

/** Открытые помехи: сколько их всего и сколько из них запрещают переход. */
async function readBlockerCounts(
	interactionIds: string[]
): Promise<Map<string, { open: number; blocking: number }>> {
	if (interactionIds.length === 0) {
		return new Map();
	}

	const rows = await getDb()
		.select({
			interactionId: blockers.interactionId,
			open: count(),
			blocking: sql<number>`(count(*) filter (where ${blockers.blocksTransition}))::int`
		})
		.from(blockers)
		.where(and(inArray(blockers.interactionId, interactionIds), isNull(blockers.resolvedAt)))
		.groupBy(blockers.interactionId);

	return new Map(
		rows.map((row) => [row.interactionId, { open: row.open, blocking: row.blocking }])
	);
}

/**
 * Состояние карточки. Порядок проверок тот же, что у ленты стадий
 * (`buildProgress`): помеха важнее паузы, пауза важнее просрочки — иначе одна и
 * та же запись называлась бы в списке и на доске по-разному.
 */
export function boardCardState(input: {
	blockingBlockers: number;
	isPaused: boolean;
	isOverdue: boolean;
}): BoardCardState {
	if (input.blockingBlockers > 0) {
		return 'blocked';
	}

	if (input.isPaused) {
		return 'paused';
	}

	return input.isOverdue ? 'overdue' : 'current';
}

/**
 * Переходы, предложенные карточке, с приговором движка по каждому.
 *
 * Приговор считает `evaluateTransition` — та же функция, которой отказывает
 * команда: второго свода правил на доске нет. Причина спрашивается без команды
 * (`intent = null`), потому что её человек вводит в диалоге в момент нажатия, —
 * иначе возврат всегда выглядел бы недоступным.
 */
export function boardTransitions(
	ctx: ActorContext,
	state: StageState,
	route: StageRouteView
): BoardTransitionOption[] {
	const stagesById = new Map(route.stages.map((stage) => [stage.id, stage]));

	const positionOf = (stageId: string): number => stagesById.get(stageId)?.position ?? 0;

	return route.transitions
		.filter((transition) => transition.fromStageId === state.stageId)
		.map((transition) => {
			const verdict = evaluateTransition(ctx, state, transition, null);

			return {
				toStageId: transition.toStageId,
				toStageName: stagesById.get(transition.toStageId)?.name ?? 'Стадия вне маршрута',
				kind: transition.kind,
				requiresReason: transition.requiresReason,
				allowed: verdict.allowed,
				reasons: verdict.reasons
			};
		})
		.sort((left, right) => positionOf(left.toStageId) - positionOf(right.toStageId));
}

/** Карточка вместе со счётчиками её колонки: то, что раскладывают по доске. */
export type BoardEntry = {
	card: InteractionBoardCard;
	totals: { count: number; overdue: number };
};

/**
 * Карточки по колонкам. Колонки задаёт маршрут, а не данные: стадия без единой
 * карточки остаётся на доске, потому что «здесь сейчас пусто» — это ответ, а
 * исчезнувшая колонка выглядит как исчезнувший участок процесса.
 */
export function buildBoardColumns(
	routeStages: readonly StageView[],
	entries: readonly BoardEntry[]
): InteractionBoardColumn[] {
	const byStage = new Map<string, BoardEntry[]>();

	for (const entry of entries) {
		const list = byStage.get(entry.card.stageId) ?? [];
		list.push(entry);
		byStage.set(entry.card.stageId, list);
	}

	return [...routeStages]
		.sort((left, right) => left.position - right.position)
		.map((stage) => {
			const list = byStage.get(stage.id) ?? [];
			const totals = list[0]?.totals ?? { count: 0, overdue: 0 };

			return {
				stageId: stage.id,
				key: stage.key,
				name: stage.name,
				position: stage.position,
				category: stage.category,
				count: totals.count,
				overdue: totals.overdue,
				cards: list.map((entry) => entry.card)
			};
		});
}

export async function getInteractionBoard(
	ctx: ActorContext,
	query: InteractionBoardQuery
): Promise<InteractionBoardView> {
	requirePermission(ctx, 'interactions.read');

	const db = getDb();
	const options = await readRouteOptions(ctx);
	const routeId = chooseBoardRoute(options, query.routeId);

	// Выбор над доской показывает версии, на которых есть работа, и маршрут по
	// умолчанию: остальные версии — это история процесса, а не место, куда
	// собираются переключиться. Открытая версия остаётся в списке всегда, иначе
	// выбор показывал бы не то, что на экране.
	const offered: InteractionBoardRoute[] = options
		.filter((route) => route.interactions > 0 || route.isDefault || route.id === routeId)
		.map((route) => ({
			id: route.id,
			name: route.name,
			version: route.version,
			interactions: route.interactions
		}));

	if (routeId === null) {
		return {
			routes: offered,
			routeId: null,
			columns: [],
			total: 0,
			cardsPerColumn: CARDS_PER_COLUMN
		};
	}

	const [route, rows] = await Promise.all([
		readRoute(db, routeId),
		readBoardRows(ctx, routeId, query)
	]);

	const ids = rows.map((row) => row.id);

	const [organizationNames, offerings, blockerCounts] = await Promise.all([
		readOrganizationNames(ids),
		readOfferings(ids),
		readBlockerCounts(ids)
	]);

	const entries: BoardEntry[] = rows.map((row) => {
		const counts = blockerCounts.get(row.id) ?? { open: 0, blocking: 0 };

		const state: StageState = {
			stageId: row.stageId,
			snapshot: row.snapshot,
			checklistState: row.checklistState,
			resultText: row.resultText,
			confirmation: row.confirmation,
			isPaused: row.isPaused,
			blockingBlockers: counts.blocking
		};

		return {
			card: {
				id: row.id,
				title: row.title,
				organizationName: organizationNames.get(row.id) ?? null,
				offerings: offerings.get(row.id) ?? [],
				ownerName: row.ownerName,
				stageId: row.stageId,
				dueAt: row.dueAt,
				state: boardCardState({
					blockingBlockers: counts.blocking,
					isPaused: row.isPaused,
					isOverdue: row.isOverdue
				}),
				openBlockers: counts.open,
				transitions: boardTransitions(ctx, state, route)
			},
			totals: { count: row.stageCount, overdue: row.stageOverdue }
		};
	});

	return {
		routes: offered,
		routeId,
		columns: buildBoardColumns(route.stages, entries),
		total: entries.length,
		cardsPerColumn: CARDS_PER_COLUMN
	};
}
