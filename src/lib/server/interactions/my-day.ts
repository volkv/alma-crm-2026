/**
 * «Мой день»: что требует внимания сотрудника сегодня.
 *
 * Один список на два места — блок главной и утреннюю сводку
 * (`notifications/digest.ts`): письмо обязано звать ровно к тому, что человек
 * увидит на экране, поэтому считает их одна функция.
 *
 * Чья работа — решает область доступа вызывающего (`interactionScopeFilter`):
 * у менеджера это его взаимодействия и его вузы, у руководителя — вместе с
 * подчинёнными, у полной области — вся система. Второго правила «чьё это»
 * здесь не заводится.
 *
 * Сроки не считаются заново. Просрочка, срок, пауза и часы стадии берутся из
 * представления `stage_entry_status`, порог зависания — тот же
 * `stuck_threshold_days`, что у наблюдателя (`notifications/watch.ts`), окно
 * продления — `license_warning_days` и правило `$lib/contracts/license`.
 */
import { and, asc, desc, eq, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import { addDays } from '$lib/contracts/license';
import {
	MY_DAY_KINDS,
	MY_DAY_SECTION_LIMIT,
	type MyDay,
	type MyDayBasis,
	type MyDayInteractionKind,
	type MyDayItem,
	type MyDayKind
} from '$lib/contracts/my-day';
import { daysUntil, formatDate, formatDateTime, formatIsoDay, pluralize } from '$lib/format';
import type { ActorContext } from '../actor';
import { getDb } from '../db';
import {
	blockers,
	contractItems,
	contracts,
	interactionParties,
	interactions,
	organizations,
	products,
	stageEntries,
	stageEntryStatus,
	stagePauses
} from '../db/schema';
import { requirePermission, scopeFilter } from '../rbac';
import { getSetting } from '../settings';
import { interactionScopeFilter } from './access';

const DAY_MS = 24 * 60 * 60 * 1000;
const SECONDS_PER_DAY = 24 * 60 * 60;
const DAY_FORMS = ['день', 'дня', 'дней'] as const;

/** Окно «новых заявок»: заявки с сайта, пришедшие за последние сутки. */
const APPLICATION_WINDOW_MS = DAY_MS;

/** Источник заявок с сайта во внешней ссылке взаимодействия: `cms:<экземпляр>`. */
const SITE_SOURCE_PREFIX = 'cms:';

type InteractionRow = {
	id: string;
	title: string;
	createdAt: Date;
	externalSource: string | null;
	ownerUserId: string | null;
	stageName: string | null;
	dueAt: Date | null;
	isOverdue: boolean | null;
	isPaused: boolean | null;
	activeSeconds: number | null;
	pauseStartedAt: Date | null;
	openBlockers: number;
	organizationName: string | null;
	organizationKind: string | null;
};

/** Активные взаимодействия области с тем, что нужно разложить их по разделам. */
async function readInteractions(ctx: ActorContext): Promise<InteractionRow[]> {
	const openBlockers = sql<number>`(
		select count(*) from ${blockers}
		where ${blockers.interactionId} = ${interactions.id} and ${blockers.resolvedAt} is null
	)`.mapWith(Number);

	return (
		getDb()
			.select({
				id: interactions.id,
				title: interactions.title,
				createdAt: interactions.createdAt,
				externalSource: interactions.externalSource,
				ownerUserId: interactions.ownerUserId,
				stageName: sql<string | null>`${stageEntries.stageSnapshot} ->> 'name'`,
				dueAt: stageEntryStatus.dueAt,
				isOverdue: stageEntryStatus.isOverdue,
				isPaused: stageEntryStatus.isPaused,
				activeSeconds: stageEntryStatus.activeSeconds,
				pauseStartedAt: stagePauses.startedAt,
				openBlockers,
				organizationName: organizations.shortName,
				organizationKind: organizations.kind
			})
			.from(interactions)
			.leftJoin(
				stageEntries,
				and(eq(stageEntries.interactionId, interactions.id), isNull(stageEntries.leftAt))
			)
			.leftJoin(stageEntryStatus, eq(stageEntryStatus.stageEntryId, stageEntries.id))
			// Открытая пауза у записи одна — это держит частичный уникальный индекс.
			.leftJoin(
				stagePauses,
				and(eq(stagePauses.stageEntryId, stageEntries.id), isNull(stagePauses.endedAt))
			)
			.leftJoin(
				interactionParties,
				and(
					eq(interactionParties.interactionId, interactions.id),
					eq(interactionParties.isPrimary, true)
				)
			)
			.leftJoin(organizations, eq(organizations.id, interactionParties.organizationId))
			.where(and(eq(interactions.status, 'active'), interactionScopeFilter(ctx)))
	);
}

function days(count: number): string {
	return pluralize(count, DAY_FORMS);
}

function stagePrefix(row: InteractionRow): string {
	return row.stageName === null ? '' : `стадия «${row.stageName}», `;
}

/**
 * Раздел строки и пояснение к ней — или `null`, если со взаимодействием сегодня
 * делать нечего. Проверки идут в порядке {@link MY_DAY_KINDS}: запись попадает в
 * первый подходящий раздел.
 */
function classify(
	row: InteractionRow,
	now: Date,
	thresholdDays: number
): { kind: MyDayKind; detail: string } | null {
	// Дело без ответственного видят его автор и руководитель: у обоих первое
	// дело с ним — назначить, кто поведёт.
	if (row.ownerUserId === null) {
		return {
			kind: 'unassigned',
			detail: `${stagePrefix(row)}заведено ${formatDate(row.createdAt)}`
		};
	}

	if (row.isOverdue === true && row.dueAt !== null) {
		const late = -daysUntil(row.dueAt, now);

		return {
			kind: 'overdue',
			detail: `${stagePrefix(row)}${late === 0 ? 'срок прошёл сегодня' : `срок прошёл ${days(late)} назад`}`
		};
	}

	if (row.dueAt !== null && row.isPaused === false) {
		const left = daysUntil(row.dueAt, now);

		if (left <= 1) {
			return {
				kind: 'due_soon',
				detail: `${stagePrefix(row)}срок ${left <= 0 ? 'сегодня' : 'завтра'}, ${formatDate(row.dueAt)}`
			};
		}
	}

	if (row.openBlockers > 0) {
		return {
			kind: 'blocker',
			detail: `${stagePrefix(row)}${pluralize(row.openBlockers, ['открытая помеха', 'открытые помехи', 'открытых помех'])}`
		};
	}

	if (
		row.isPaused === false &&
		row.activeSeconds !== null &&
		row.activeSeconds > thresholdDays * SECONDS_PER_DAY
	) {
		return {
			kind: 'stuck',
			detail: `${stagePrefix(row)}стоит ${days(Math.floor(row.activeSeconds / SECONDS_PER_DAY))} без учёта пауз`
		};
	}

	if (
		row.isPaused === true &&
		row.pauseStartedAt !== null &&
		now.getTime() - row.pauseStartedAt.getTime() > thresholdDays * DAY_MS
	) {
		const waited = Math.floor((now.getTime() - row.pauseStartedAt.getTime()) / DAY_MS);

		return { kind: 'waiting', detail: `${stagePrefix(row)}ждём ${days(waited)}` };
	}

	if (
		row.externalSource !== null &&
		row.externalSource.startsWith(SITE_SOURCE_PREFIX) &&
		now.getTime() - row.createdAt.getTime() <= APPLICATION_WINDOW_MS
	) {
		return { kind: 'application', detail: `пришла ${formatDateTime(row.createdAt)}` };
	}

	return null;
}

/**
 * Свободный текст к строкам экрана: самая весомая помеха и кого ждём. Читается
 * только для тех строк, что попали на экран.
 */
async function readNotes(items: MyDayItem[]): Promise<Map<string, string>> {
	const notes = new Map<string, string>();
	const blocked = items.filter((item) => item.kind === 'blocker').map((item) => item.target.id);
	const waiting = items.filter((item) => item.kind === 'waiting').map((item) => item.target.id);
	const db = getDb();

	const [blockerRows, pauseRows] = await Promise.all([
		blocked.length === 0
			? []
			: db
					.select({ interactionId: blockers.interactionId, description: blockers.description })
					.from(blockers)
					.where(and(inArray(blockers.interactionId, blocked), isNull(blockers.resolvedAt)))
					// Запрещающая переход помеха важнее прочих, свежая — важнее старой.
					.orderBy(desc(blockers.blocksTransition), desc(blockers.raisedAt)),
		waiting.length === 0
			? []
			: db
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
							inArray(stageEntries.interactionId, waiting),
							isNull(stagePauses.endedAt),
							isNull(stageEntries.leftAt)
						)
					)
	]);

	for (const row of blockerRows) {
		if (!notes.has(row.interactionId)) {
			notes.set(row.interactionId, row.description);
		}
	}

	for (const row of pauseRows) {
		const text = row.nextAction ?? row.note;
		notes.set(row.interactionId, row.party === null ? text : `${row.party}: ${text}`);
	}

	return notes;
}

/**
 * Лицензии в окне продления по вузам области: по назначениям ответственных
 * (`scopeFilter`), как и список вузов. Первыми — самые ранние сроки.
 */
async function readLicenses(ctx: ActorContext, now: Date): Promise<MyDayItem[]> {
	const today = formatIsoDay(now);
	const windowDays = await getSetting('license_warning_days');

	const rows = await getDb()
		.select({
			organizationId: organizations.id,
			organizationName: organizations.shortName,
			organizationKind: organizations.kind,
			productName: products.name,
			contractNumber: contracts.number,
			licenseUntil: contractItems.licenseUntil
		})
		.from(contractItems)
		.innerJoin(contracts, eq(contracts.id, contractItems.contractId))
		.innerJoin(organizations, eq(organizations.id, contracts.organizationId))
		.innerJoin(products, eq(products.id, contractItems.productId))
		.where(
			and(
				isNotNull(contractItems.licenseUntil),
				sql`${contractItems.licenseUntil} <= ${addDays(today, windowDays)}::date`,
				ne(contracts.status, 'closed'),
				eq(organizations.isActive, true),
				scopeFilter(ctx, organizations.id)
			)
		)
		.orderBy(asc(contractItems.licenseUntil));

	return rows.map((row) => {
		const until = row.licenseUntil as string;
		const left = daysUntil(`${until}T00:00:00+03:00`, now);
		const term =
			left < 0
				? `истекла ${formatDate(until)}, ${days(-left)} назад`
				: left === 0
					? `истекает сегодня, ${formatDate(until)}`
					: `истекает ${formatDate(until)}, через ${days(left)}`;

		return {
			kind: 'license',
			target: { type: 'organization', id: row.organizationId },
			title: `«${row.productName}», договор № ${row.contractNumber}`,
			organizationName: row.organizationName,
			isPersonal: row.organizationKind === 'individual',
			detail: `лицензия ${term}`,
			note: null
		};
	});
}

function basisOf(ctx: ActorContext): MyDayBasis {
	if (ctx.scope.kind === 'all') {
		return 'all';
	}

	return ctx.scope.userIds.size > 1 ? 'team' : 'own';
}

/**
 * Дела раздела «Моего дня» — все, а не первые строки: по ним список дел
 * отбирает ровно тот набор, что посчитан на главной (`day` в адресе списка).
 * Разбор тот же (`classify`), поэтому число раздела и строки списка не
 * расходятся.
 */
export async function listMyDayInteractionIds(
	ctx: ActorContext,
	kind: MyDayInteractionKind,
	now: Date = new Date()
): Promise<string[]> {
	requirePermission(ctx, 'interactions.read');

	const [rows, thresholdDays] = await Promise.all([
		readInteractions(ctx),
		getSetting('stuck_threshold_days')
	]);

	return rows
		.filter((row) => classify(row, now, thresholdDays)?.kind === kind)
		.map((row) => row.id);
}

/**
 * «Мой день» вызывающего на момент `now`. Пустой список разделов — всё в
 * порядке: ни просрочки, ни близких сроков, ни помех, ни новых заявок.
 */
export async function getMyDay(ctx: ActorContext, now: Date = new Date()): Promise<MyDay> {
	requirePermission(ctx, 'interactions.read');

	const [rows, licenses, thresholdDays] = await Promise.all([
		readInteractions(ctx),
		readLicenses(ctx, now),
		getSetting('stuck_threshold_days')
	]);

	const byKind = new Map<MyDayKind, MyDayItem[]>(MY_DAY_KINDS.map((kind) => [kind, []]));

	// Внутри раздела — по сроку стадии, ближайший и самый просроченный первыми;
	// у записи без срока торопиться не с чем.
	const ordered = [...rows].sort(
		(left, right) =>
			(left.dueAt?.getTime() ?? Number.POSITIVE_INFINITY) -
			(right.dueAt?.getTime() ?? Number.POSITIVE_INFINITY)
	);

	for (const row of ordered) {
		const placed = classify(row, now, thresholdDays);

		if (placed === null) {
			continue;
		}

		byKind.get(placed.kind)?.push({
			kind: placed.kind,
			target: { type: 'interaction', id: row.id },
			title: row.title,
			organizationName: row.organizationName,
			isPersonal: row.organizationKind === 'individual',
			detail: placed.detail,
			note: null
		});
	}

	byKind.set('license', licenses);

	const sections = MY_DAY_KINDS.map((kind) => {
		const all = byKind.get(kind) ?? [];

		return { kind, items: all.slice(0, MY_DAY_SECTION_LIMIT), total: all.length };
	}).filter((section) => section.total > 0);

	const notes = await readNotes(sections.flatMap((section) => section.items));

	for (const section of sections) {
		for (const item of section.items) {
			item.note = notes.get(item.target.id) ?? null;
		}
	}

	return { generatedAt: now, basis: basisOf(ctx), sections };
}
