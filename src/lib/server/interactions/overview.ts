/**
 * Сводка рабочего дня: что происходит с портфелем взаимодействий и с чего
 * начинать.
 *
 * Главная отвечает на четыре вопроса подряд — сколько всего горит, где стоит
 * портфель, что делать мне прямо сейчас и кого мы ждём, — и поэтому собирается
 * одним сервисом: четыре страницы, каждая со своим запросом, разошлись бы в
 * числах уже на второй неделе.
 *
 * Строки «требуют действия» берутся у `listInteractions`: стадия, срок, лента
 * маршрута и счётчик помех там уже собраны одним запросом, и второй такой же
 * запрос здесь означал бы два ответа на вопрос «где взаимодействие стоит».
 * Порядок внутри списка — правило этой страницы, а не списка, поэтому он
 * считается здесь.
 */
import { and, asc, count, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import { AUDIT_EVENT_TYPES, type AuditEventType } from '$lib/contracts/audit';
import {
	STAGE_CATEGORIES,
	interactionListQuerySchema,
	type InteractionListItem,
	type InteractionListQuery,
	type StageCategory,
	type StageSnapshot
} from '$lib/contracts/interactions';
import { daysUntil } from '$lib/format';
import type { ActorContext } from '../actor';
import { getDb } from '../db';
import {
	auditEvents,
	blockers,
	interactionParties,
	interactions,
	organizations,
	stageEntries,
	stageEntryStatus,
	stagePauses
} from '../db/schema';
import { requirePermission } from '../rbac';
import { isStale } from '../stages/status';
import { interactionScopeFilter } from './access';
import { listInteractions } from './read';

/** За сколько дней до срока взаимодействие попадает в «скоро». */
const DUE_SOON_DAYS = 3;
/** Сколько строк помещается в «требуют действия»: это список на утро, а не отчёт. */
const NEEDS_ACTION_LIMIT = 10;
const WAITING_LIMIT = 5;
const ACTIVITY_LIMIT = 10;
/** Окно, за которое считаются завершённые взаимодействия. */
const COMPLETED_WINDOW_DAYS = 30;
/**
 * Сколько строк рассматривается при отборе «требуют действия». Порядок внутри
 * списка — правило приложения, а не колонка в базе, поэтому кандидаты берутся
 * страницей с ближайшими сроками: просроченные в неё попадают все, у них срок
 * уже в прошлом.
 */
const CANDIDATE_PAGE_SIZE = 100;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Что показывать в ленте активности. Список считается из словаря событий, а не
 * перечисляется руками: новое событие взаимодействия попадёт в ленту само.
 */
const FEED_EVENT_TYPES: AuditEventType[] = AUDIT_EVENT_TYPES.filter(
	(type) => type.startsWith('interactions.') || type.startsWith('documents.')
);

/** Счётчики портфеля: по одному числу на вопрос, который задают утром. */
export type OverviewCounters = {
	active: number;
	overdue: number;
	paused: number;
	/** С открытыми помехами — и запрещающими переход, и остальными. */
	blocked: number;
	/** Вокруг записи тихо дольше, чем допускает её стадия. */
	stale: number;
	/** Завершённые за последние 30 дней. */
	completedRecently: number;
};

/** Доля смысловой группы стадий в активном портфеле. */
export type OverviewStageShare = {
	category: StageCategory;
	count: number;
};

export type OverviewDistribution = {
	/** Только группы, в которых кто-то стоит, в порядке маршрута. */
	shares: OverviewStageShare[];
	/** Активные без открытой стадии: их не видно ни в одной группе. */
	stageless: number;
	total: number;
	/** Группа с наибольшей долей — та, на которой сейчас стоит портфель. */
	leading: StageCategory | null;
};

/** Что мешает взаимодействию двигаться — одна причина, самая важная. */
export type OverviewImpediment =
	| { kind: 'blocker'; text: string; blocksTransition: boolean }
	| { kind: 'waiting'; party: string | null; text: string }
	| { kind: 'silence'; since: Date };

/** Строка списка «требуют действия»: сама запись и то, что её держит. */
export type OverviewTask = {
	interaction: InteractionListItem;
	impediment: OverviewImpediment | null;
};

/** Взаимодействие, по которому ждут не нас. */
export type OverviewWaiting = {
	interactionId: string;
	title: string;
	/** Кого ждём: сторона взаимодействия, если она названа в паузе. */
	party: string | null;
	note: string;
	nextAction: string | null;
	since: Date;
};

/** Событие журнала в ленте главной. */
export type OverviewActivity = {
	id: string;
	occurredAt: Date;
	eventType: AuditEventType;
	actorLabel: string;
	interactionId: string;
	interactionTitle: string;
};

export type WorkOverview = {
	/** Момент, на который собраны все числа: сроки на странице считаются от него. */
	generatedAt: Date;
	counters: OverviewCounters;
	distribution: OverviewDistribution;
	needsAction: {
		/**
		 * `mine` — взаимодействия вызывающего; `all` — просроченные по всей
		 * области доступа, когда своих у человека нет.
		 */
		basis: 'mine' | 'all';
		tasks: OverviewTask[];
	};
	waiting: OverviewWaiting[];
	activity: OverviewActivity[];
};

/** Строка активного взаимодействия в том объёме, в каком её считают счётчики. */
type PortfolioRow = {
	id: string;
	ownerUserId: string;
	lastActivityAt: Date;
	snapshot: StageSnapshot | null;
	isOverdue: boolean | null;
	isPaused: boolean | null;
	openBlockers: number;
};

/**
 * Активные взаимодействия области доступа — по строке на запись.
 *
 * Счётчики считаются в приложении, а не агрегатом в SQL, потому что протухание
 * — правило приложения (`isStale`), а не столбец: написанное второй раз на SQL,
 * оно однажды разойдётся с первым, и расхождение будет молчаливым.
 */
async function readPortfolio(ctx: ActorContext): Promise<PortfolioRow[]> {
	const db = getDb();

	const openBlockerCount = sql<number>`(
		select count(*) from ${blockers}
		where ${blockers.interactionId} = ${interactions.id} and ${blockers.resolvedAt} is null
	)`.mapWith(Number);

	return db
		.select({
			id: interactions.id,
			ownerUserId: interactions.ownerUserId,
			lastActivityAt: interactions.lastActivityAt,
			snapshot: stageEntries.stageSnapshot,
			isOverdue: stageEntryStatus.isOverdue,
			isPaused: stageEntryStatus.isPaused,
			openBlockers: openBlockerCount
		})
		.from(interactions)
		.leftJoin(
			stageEntries,
			and(eq(stageEntries.interactionId, interactions.id), isNull(stageEntries.leftAt))
		)
		.leftJoin(stageEntryStatus, eq(stageEntryStatus.stageEntryId, stageEntries.id))
		.where(and(eq(interactions.status, 'active'), interactionScopeFilter(ctx)));
}

function countCounters(
	rows: PortfolioRow[],
	now: Date
): Omit<OverviewCounters, 'completedRecently'> {
	return {
		active: rows.length,
		overdue: rows.filter((row) => row.isOverdue === true).length,
		paused: rows.filter((row) => row.isPaused === true).length,
		blocked: rows.filter((row) => row.openBlockers > 0).length,
		stale: rows.filter((row) => isStale(row.snapshot, row.lastActivityAt, now)).length
	};
}

function buildDistribution(rows: PortfolioRow[]): OverviewDistribution {
	const counts = new Map<StageCategory, number>();
	let stageless = 0;

	for (const row of rows) {
		if (row.snapshot === null) {
			stageless += 1;
			continue;
		}

		counts.set(row.snapshot.category, (counts.get(row.snapshot.category) ?? 0) + 1);
	}

	const shares = STAGE_CATEGORIES.map((category) => ({
		category,
		count: counts.get(category) ?? 0
	})).filter((share) => share.count > 0);

	const leading = shares.reduce<OverviewStageShare | null>(
		(best, share) => (best === null || share.count > best.count ? share : best),
		null
	);

	return {
		shares,
		stageless,
		total: rows.length,
		leading: leading?.category ?? null
	};
}

/** Завершённые за окно: последнее событие такой записи — это её завершение. */
async function countCompletedRecently(ctx: ActorContext, since: Date): Promise<number> {
	const [row] = await getDb()
		.select({ value: count() })
		.from(interactions)
		.where(
			and(
				eq(interactions.status, 'completed'),
				gte(interactions.lastActivityAt, since),
				interactionScopeFilter(ctx)
			)
		);

	return row?.value ?? 0;
}

function candidateQuery(changes: Partial<InteractionListQuery>): InteractionListQuery {
	return interactionListQuerySchema.parse({
		status: 'active',
		// Ближайший срок первым: просроченные все попадают в страницу кандидатов,
		// их срок уже в прошлом.
		sort: 'dueAt',
		pageSize: CANDIDATE_PAGE_SIZE,
		...changes
	});
}

/**
 * Насколько строка срочная: 0 — просрочено, 1 — стоит помеха, 2 — срок на
 * подходе, 3 — всё остальное. Порядок именно такой: просрочку уже не вернуть,
 * помеха не рассосётся сама, а срок «через три дня» ещё можно успеть.
 */
function urgency(item: InteractionListItem, now: Date): number {
	if (item.isOverdue) {
		return 0;
	}

	if (item.openBlockers > 0) {
		return 1;
	}

	if (item.dueAt !== null && !item.isPaused && daysUntil(item.dueAt, now) <= DUE_SOON_DAYS) {
		return 2;
	}

	return 3;
}

function byUrgency(now: Date) {
	return (left: InteractionListItem, right: InteractionListItem): number => {
		const difference = urgency(left, now) - urgency(right, now);

		if (difference !== 0) {
			return difference;
		}

		// Внутри ступени — по сроку: у записи без срока торопиться не с чем.
		if (left.dueAt === null || right.dueAt === null) {
			return left.dueAt === right.dueAt ? 0 : left.dueAt === null ? 1 : -1;
		}

		return left.dueAt.getTime() - right.dueAt.getTime();
	};
}

/**
 * Что держит каждое из показанных взаимодействий. Причина одна и самая
 * весомая: помеха, ожидание стороны, тишина. Готовность перехода сюда не
 * входит — её правила живут в `evaluateTransition`, и второго их изложения
 * быть не должно.
 */
async function readImpediments(
	interactionIds: string[],
	items: InteractionListItem[]
): Promise<Map<string, OverviewImpediment>> {
	const result = new Map<string, OverviewImpediment>();

	if (interactionIds.length === 0) {
		return result;
	}

	const db = getDb();

	const [blockerRows, pauseRows] = await Promise.all([
		db
			.select({
				interactionId: blockers.interactionId,
				description: blockers.description,
				blocksTransition: blockers.blocksTransition
			})
			.from(blockers)
			.where(and(inArray(blockers.interactionId, interactionIds), isNull(blockers.resolvedAt)))
			// Запрещающая переход помеха важнее прочих, свежая — важнее старой.
			.orderBy(desc(blockers.blocksTransition), desc(blockers.raisedAt)),
		db
			.select({
				interactionId: stageEntries.interactionId,
				note: stagePauses.note,
				nextAction: stagePauses.nextAction,
				party: organizations.shortName
			})
			.from(stagePauses)
			.innerJoin(stageEntries, eq(stageEntries.id, stagePauses.stageEntryId))
			.leftJoin(interactionParties, eq(interactionParties.id, stagePauses.waitingPartyId))
			.leftJoin(organizations, eq(organizations.id, interactionParties.organizationId))
			.where(
				and(
					inArray(stageEntries.interactionId, interactionIds),
					isNull(stagePauses.endedAt),
					isNull(stageEntries.leftAt)
				)
			)
	]);

	for (const row of blockerRows) {
		if (!result.has(row.interactionId)) {
			result.set(row.interactionId, {
				kind: 'blocker',
				text: row.description,
				blocksTransition: row.blocksTransition
			});
		}
	}

	for (const row of pauseRows) {
		if (!result.has(row.interactionId)) {
			result.set(row.interactionId, {
				kind: 'waiting',
				party: row.party,
				text: row.nextAction ?? row.note
			});
		}
	}

	for (const item of items) {
		if (item.isStale && !result.has(item.id)) {
			result.set(item.id, { kind: 'silence', since: item.lastActivityAt });
		}
	}

	return result;
}

/**
 * Строки на утро. Своих взаимодействий нет — показываются просроченные по всей
 * области доступа: наблюдателю и новому сотруднику пустой список не говорит
 * ничего, а горящее по соседству — говорит.
 */
async function readNeedsAction(
	ctx: ActorContext,
	now: Date
): Promise<{ basis: 'mine' | 'all'; tasks: OverviewTask[] }> {
	const userId = ctx.user?.id ?? null;

	const mine =
		userId === null ? null : await listInteractions(ctx, candidateQuery({ ownerUserId: userId }));

	const basis: 'mine' | 'all' = mine !== null && mine.total > 0 ? 'mine' : 'all';
	const page =
		mine !== null && mine.total > 0
			? mine
			: await listInteractions(ctx, candidateQuery({ overdue: true }));

	const items = [...page.items].sort(byUrgency(now)).slice(0, NEEDS_ACTION_LIMIT);
	const impediments = await readImpediments(
		items.map((item) => item.id),
		items
	);

	return {
		basis,
		tasks: items.map((item) => ({
			interaction: item,
			impediment: impediments.get(item.id) ?? null
		}))
	};
}

/** Кого мы ждём: открытые паузы, дольше всех ожидающие — первыми. */
async function readWaiting(ctx: ActorContext): Promise<OverviewWaiting[]> {
	return getDb()
		.select({
			interactionId: interactions.id,
			title: interactions.title,
			party: organizations.shortName,
			note: stagePauses.note,
			nextAction: stagePauses.nextAction,
			since: stagePauses.startedAt
		})
		.from(stagePauses)
		.innerJoin(stageEntries, eq(stageEntries.id, stagePauses.stageEntryId))
		.innerJoin(interactions, eq(interactions.id, stageEntries.interactionId))
		.leftJoin(interactionParties, eq(interactionParties.id, stagePauses.waitingPartyId))
		.leftJoin(organizations, eq(organizations.id, interactionParties.organizationId))
		.where(
			and(
				isNull(stagePauses.endedAt),
				isNull(stageEntries.leftAt),
				eq(interactions.status, 'active'),
				interactionScopeFilter(ctx)
			)
		)
		.orderBy(asc(stagePauses.startedAt))
		.limit(WAITING_LIMIT);
}

/**
 * Лента последних событий по взаимодействиям.
 *
 * Журнал целиком — инструмент администратора и закрыт правом `audit.read`.
 * Здесь читается не он, а след работы над записями, которые вызывающий и так
 * открывает: события отобраны по типам, успешны и ограничены областью доступа
 * через взаимодействие, к которому относятся. Поэтому право здесь то же, что и
 * у списка, — `interactions.read`.
 */
async function readActivity(ctx: ActorContext): Promise<OverviewActivity[]> {
	// У событий документа подлежащее — сам документ, а взаимодействие лежит
	// ссылкой в подробностях: без этого лента потеряла бы половину работы.
	const subject = sql`case
		when ${auditEvents.subjectType} = 'interaction' then ${auditEvents.subjectId}
		else (${auditEvents.details} ->> 'interactionId')::uuid
	end`;

	const rows = await getDb()
		.select({
			id: auditEvents.id,
			occurredAt: auditEvents.occurredAt,
			eventType: auditEvents.eventType,
			actorLabel: auditEvents.actorLabel,
			interactionId: interactions.id,
			interactionTitle: interactions.title
		})
		.from(auditEvents)
		.innerJoin(interactions, sql`${interactions.id} = ${subject}`)
		.where(
			and(
				eq(auditEvents.outcome, 'success'),
				inArray(auditEvents.eventType, FEED_EVENT_TYPES),
				interactionScopeFilter(ctx)
			)
		)
		.orderBy(desc(auditEvents.occurredAt), desc(auditEvents.id))
		.limit(ACTIVITY_LIMIT);

	return rows.map((row) => ({ ...row, eventType: row.eventType as AuditEventType }));
}

export async function getWorkOverview(ctx: ActorContext): Promise<WorkOverview> {
	requirePermission(ctx, 'interactions.read');

	// Один момент времени на всю сводку: числа в плитках, полосе и списке
	// обязаны сходиться между собой, а не каждое со своим «сейчас».
	const now = new Date();
	const completedSince = new Date(now.getTime() - COMPLETED_WINDOW_DAYS * DAY_MS);

	const [portfolio, completedRecently, needsAction, waiting, activity] = await Promise.all([
		readPortfolio(ctx),
		countCompletedRecently(ctx, completedSince),
		readNeedsAction(ctx, now),
		readWaiting(ctx),
		readActivity(ctx)
	]);

	return {
		generatedAt: now,
		counters: { ...countCounters(portfolio, now), completedRecently },
		distribution: buildDistribution(portfolio),
		needsAction,
		waiting,
		activity
	};
}
