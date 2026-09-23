/**
 * Доска взаимодействий: те же записи, что и в списке, разложенные по стадиям
 * действующего процесса.
 *
 * Список отвечает на вопрос «что с этой записью», доска — на вопрос «где стоит
 * работа целиком»: сколько дел висит на обмене документами и сколько из них уже
 * просрочено. Колонки — стадии действующей редакции одного пространства, а
 * карточка стоит ровно в той колонке, где открыта её запись стадии. Выбора
 * версии на доске нет: в пространстве действует ровно один процесс, и его номер
 * человеку не нужен. Пространство задаёт адрес — доска и список показывают одно
 * и то же место, а не то, где сегодня больше работы.
 *
 * Выборка — один запрос: карточки, число карточек на стадии и число
 * просроченных считаются оконными функциями за один проход, а не запросом на
 * колонку. Раскладывает их по колонкам чистая функция, поэтому порядок колонок
 * задаёт маршрут, а не то, что вернула база.
 */
import { and, asc, count, desc, eq, exists, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type {
	BoardCardState,
	BoardTransitionOption,
	InteractionBoardCard,
	InteractionBoardColumn,
	InteractionBoardView,
	InteractionStatus,
	ProcessRevisionView,
	StageCategory,
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
	stages,
	users
} from '../db/schema';
import { requirePermission } from '../rbac';
import { readActiveRevisionForWorkspace } from '../stages/process';
import { evaluateTransition, type StageState } from '../stages/transitions';
import { interactionScopeFilter } from './access';
import { interactionAttributeConditions } from './read';

/**
 * Сколько карточек показывает колонка.
 *
 * Доска — это обзор, а не список: колонка из трёхсот карточек не отвечает ни на
 * один вопрос, ради которого её открывают, зато заставляет браузер рисовать всё
 * это разом. Счётчик в шапке колонки при этом считает все карточки стадии, а не
 * показанные, — иначе число в заголовке врало бы о портфеле.
 */
export const CARDS_PER_COLUMN = 25;

/** Отбор доски: фильтры те же, что у списка. Пространство задано адресом. */
export type InteractionBoardQuery = {
	status: InteractionStatus | null;
	stageCategory: StageCategory | null;
	overdue: boolean;
	ownerUserId: string | null;
	q: string | null;
	/** Вуз, направление, программа, продукт — как в списке (`interactions/read.ts`). */
	org: readonly string[];
	dir: readonly string[];
	prog: readonly string[];
	prod: readonly string[];
};

/**
 * Условия отбора карточек. Повторяют фильтры списка (`interactions/read.ts`)
 * намеренно: доска берёт из записи стадии то, что списку не нужно, — чек-лист,
 * результат, подтверждение и данные обучения для приговора по переходу.
 */
function boardConditions(
	ctx: ActorContext,
	workspaceId: string,
	query: InteractionBoardQuery
): SQL[] {
	const conditions: SQL[] = [
		interactionScopeFilter(ctx),
		eq(interactions.workspaceId, workspaceId),
		...interactionAttributeConditions(query)
	];

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
async function readBoardRows(ctx: ActorContext, workspaceId: string, query: InteractionBoardQuery) {
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
			lmsEvidence: stageEntries.lmsEvidence,
			documentMarkEvidence: stageEntries.documentMarkEvidence,
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
		.where(and(...boardConditions(ctx, workspaceId, query)))
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
	revision: ProcessRevisionView
): BoardTransitionOption[] {
	const stagesById = new Map(revision.stages.map((stage) => [stage.id, stage]));

	const positionOf = (stageId: string): number => stagesById.get(stageId)?.position ?? 0;

	return revision.transitions
		.filter((transition) => transition.fromStageId === state.stageId)
		.map((transition) => {
			const verdict = evaluateTransition(ctx, state, transition, null);

			return {
				toStageId: transition.toStageId,
				toStageName: stagesById.get(transition.toStageId)?.name ?? 'Стадия вне процесса',
				kind: transition.kind,
				requiresReason: transition.requiresReason,
				allowed: verdict.allowed,
				reasons: verdict.reasons
			};
		})
		.sort((left, right) => positionOf(left.toStageId) - positionOf(right.toStageId));
}

/** Пространство, чью доску собирают: его задаёт адрес, а не отбор. */
export type BoardWorkspace = { id: string; key: string; name: string };

/** Карточка вместе со счётчиками её колонки: то, что раскладывают по доске. */
export type BoardEntry = {
	card: InteractionBoardCard;
	totals: { count: number; overdue: number };
};

/**
 * Карточки по колонкам. Колонки задаёт процесс, а не данные: стадия без единой
 * карточки остаётся на доске, потому что «здесь сейчас пусто» — это ответ, а
 * исчезнувшая колонка выглядит как исчезнувший участок процесса.
 */
export function buildBoardColumns(
	revisionStages: readonly StageView[],
	entries: readonly BoardEntry[]
): InteractionBoardColumn[] {
	const byStage = new Map<string, BoardEntry[]>();

	for (const entry of entries) {
		const list = byStage.get(entry.card.stageId) ?? [];
		list.push(entry);
		byStage.set(entry.card.stageId, list);
	}

	return [...revisionStages]
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
	workspace: BoardWorkspace,
	query: InteractionBoardQuery
): Promise<InteractionBoardView> {
	requirePermission(ctx, 'interactions.read');

	const revision = await readActiveRevisionForWorkspace(workspace.id);

	// Пространство без назначенного процесса — это не поломка доски: стадий нет,
	// и колонок тоже. Доска в этом случае объясняет словами, что работать здесь
	// пока нечем, а отказ выглядел бы как поломка.
	if (revision === null) {
		return {
			workspaceId: workspace.id,
			workspaceKey: workspace.key,
			workspaceName: workspace.name,
			columns: [],
			total: 0,
			cardsPerColumn: CARDS_PER_COLUMN,
			revision: null
		};
	}

	const rows = await readBoardRows(ctx, workspace.id, query);

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
			lmsEvidence: row.lmsEvidence,
			documentMarkEvidence: row.documentMarkEvidence,
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
				transitions: boardTransitions(ctx, state, revision)
			},
			totals: { count: row.stageCount, overdue: row.stageOverdue }
		};
	});

	return {
		workspaceId: workspace.id,
		workspaceKey: workspace.key,
		workspaceName: workspace.name,
		columns: buildBoardColumns(revision.stages, entries),
		total: entries.length,
		cardsPerColumn: CARDS_PER_COLUMN,
		revision: revision.version
	};
}
