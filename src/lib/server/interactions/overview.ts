/**
 * Сводка портфеля на главной: сколько всего горит, где стоит портфель и что
 * происходило в работе.
 *
 * Плитки, полоса и лента собираются одним сервисом: три запроса, каждый со
 * своим «сейчас», разошлись бы в числах уже на второй неделе. Что делать
 * сегодня — список «Мой день» — считает `my-day.ts`: он же уходит утренней
 * сводкой, и у списка дел должен быть один источник.
 */
import { and, count, desc, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import { AUDIT_EVENT_TYPES, type AuditEventType } from '$lib/contracts/audit';
import {
	STAGE_CATEGORIES,
	type StageCategory,
	type StageSnapshot
} from '$lib/contracts/interactions';
import type { ActorContext } from '../actor';
import { getDb } from '../db';
import { auditEvents, blockers, interactions, stageEntries, stageEntryStatus } from '../db/schema';
import { requirePermission } from '../rbac';
import { isStale } from '../stages/status';
import { interactionScopeFilter } from './access';

const ACTIVITY_LIMIT = 10;
/**
 * Сколько событий одного взаимодействия попадает в ленту.
 *
 * Лента отвечает на вопрос «что происходило в работе», а не «что было в
 * журнале»: один активный день по одной записи даёт десяток событий подряд и
 * закрывает собой весь остальной портфель. Журнал целиком лежит в разделе
 * «Журнал действий» и ничего не теряет.
 */
const ACTIVITY_PER_INTERACTION = 2;
/**
 * Окно, за которое считаются завершённые взаимодействия. Им же плитка ведёт в
 * список (`closed` в адресе): число и строки обязаны совпасть.
 */
export const COMPLETED_WINDOW_DAYS = 30;
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

/**
 * Активные дела области, в которых тишина дольше нормы стадии, — тем же
 * правилом `isStale`, что плитка «Тишина»: по ним список отбирает `state=stale`,
 * и число плитки совпадает со строками списка.
 */
export async function listStaleInteractionIds(
	ctx: ActorContext,
	now: Date = new Date()
): Promise<string[]> {
	requirePermission(ctx, 'interactions.read');

	const rows = await readPortfolio(ctx);

	return rows.filter((row) => isStale(row.snapshot, row.lastActivityAt, now)).map((row) => row.id);
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

	const db = getDb();

	// Место события в своей записи: по нему лента и обрезается до нескольких
	// строк на взаимодействие. Считать это в приложении значило бы читать
	// журнал «с запасом», не зная, какого запаса хватит.
	const ranked = db
		.select({
			id: auditEvents.id,
			occurredAt: auditEvents.occurredAt,
			eventType: auditEvents.eventType,
			actorLabel: auditEvents.actorLabel,
			// Своё имя каждому столбцу: у события и у взаимодействия оба ключа
			// зовутся `id`, и подзапрос с двумя `id` неразличим для внешнего select.
			interactionId: sql<string>`${interactions.id}`.as('interaction_id'),
			interactionTitle: sql<string>`${interactions.title}`.as('interaction_title'),
			place: sql<number>`row_number() over (
				partition by ${interactions.id}
				order by ${auditEvents.occurredAt} desc, ${auditEvents.id} desc
			)`
				.mapWith(Number)
				.as('place')
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
		.as('ranked');

	const rows = await db
		.select({
			id: ranked.id,
			occurredAt: ranked.occurredAt,
			eventType: ranked.eventType,
			actorLabel: ranked.actorLabel,
			interactionId: ranked.interactionId,
			interactionTitle: ranked.interactionTitle
		})
		.from(ranked)
		.where(lte(ranked.place, ACTIVITY_PER_INTERACTION))
		.orderBy(desc(ranked.occurredAt), desc(ranked.id))
		.limit(ACTIVITY_LIMIT);

	return rows.map((row) => ({ ...row, eventType: row.eventType as AuditEventType }));
}

/**
 * `now` — один момент времени на всю главную: числа в плитках, полосе и
 * «Моём дне» обязаны сходиться между собой, а не каждое со своим «сейчас».
 */
export async function getWorkOverview(
	ctx: ActorContext,
	now: Date = new Date()
): Promise<WorkOverview> {
	requirePermission(ctx, 'interactions.read');

	const completedSince = new Date(now.getTime() - COMPLETED_WINDOW_DAYS * DAY_MS);

	const [portfolio, completedRecently, activity] = await Promise.all([
		readPortfolio(ctx),
		countCompletedRecently(ctx, completedSince),
		readActivity(ctx)
	]);

	return {
		generatedAt: now,
		counters: { ...countCounters(portfolio, now), completedRecently },
		distribution: buildDistribution(portfolio),
		activity
	};
}
