/**
 * Чтение взаимодействий: карточка, список, комментарии и история правок.
 *
 * Список — это то, с чего начинается рабочий день: в одной строке видно, где
 * взаимодействие стоит, сколько у него осталось времени и кто за него отвечает.
 * Поэтому текущая стадия и её срок приезжают тем же запросом, что и сама
 * строка, а не подгружаются по одной на карточку.
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
	ne,
	or,
	sql,
	type SQL
} from 'drizzle-orm';
import { NO_OPTION, type PageResult } from '$lib/contracts/common';
import { GENERATED_DOCUMENT_KIND } from '$lib/contracts/documents';
import { PARTY_ROLE_LABELS } from '$lib/contracts/interactions';
import type {
	CommentView,
	InteractionChangeView,
	InteractionContractView,
	InteractionDocumentView,
	InteractionFilterOptions,
	InteractionListItem,
	InteractionListQuery,
	InteractionPartyView,
	InteractionProductView,
	InteractionProgramView,
	InteractionView,
	PartyRole,
	StageProgressItem,
	StageSnapshot
} from '$lib/contracts/interactions';
import type { ActorContext } from '../actor';
import { cachedInteractionPart } from '../cache/interactions';
import { getDb } from '../db';
import {
	affiliations,
	blockers,
	comments,
	contractItems,
	contracts,
	directions,
	documents,
	interactionChanges,
	interactionContractItems,
	interactionParties,
	interactionPartySites,
	interactionProducts,
	interactionPrograms,
	interactions,
	organizations,
	people,
	productDirections,
	products,
	programVersions,
	programs,
	sites,
	stageEntries,
	stageEntryStatus,
	workspaces,
	users
} from '../db/schema';
import { NotFoundError } from '../errors';
import { withPiiTrace } from '../people/pii-trace';
import { toPersonView } from '../people/serialize';
import { can, requirePermission, workspaceFilter } from '../rbac';
import {
	buildProgress,
	isStale,
	readStageIntroductions,
	type ProgressEntry
} from '../stages/status';
import { readActiveRevisionForWorkspace } from '../stages/process';
import { assertInteractionVisible, interactionScopeFilter } from './access';
import { listMyDayInteractionIds } from './my-day';
import { listStaleInteractionIds } from './overview';

/** Отбор по вузу, направлению, программе и продукту: поля общие у списка и у доски. */
export type InteractionAttributeQuery = {
	/** Вуз — основная сторона взаимодействия. */
	org: readonly string[];
	/** Направление — объединение направлений продуктов и программ. */
	dir: readonly string[];
	prog: readonly string[];
	prod: readonly string[];
	/** Ответственные: любой из выбранных. */
	owner: readonly string[];
};

/**
 * Условия по вузу, направлению, программе, продукту и ответственному.
 *
 * Общие для списка (`listConditions`) и доски (`interactions/board.ts`
 * `boardConditions`): набор один, и это тот же набор, что фильтрует отчёт
 * (`reports/conditions.ts`), — иначе строки списка на фильтре по направлению
 * разошлись бы с числом отчёта на том же фильтре.
 *
 * «Вуз» — основная сторона (`is_primary`), а не любой контрагент: это то
 * учебное заведение, ради которого взаимодействие завели, а не любая сторона,
 * когда-либо в нём поучаствовавшая.
 */
export function interactionAttributeConditions(query: InteractionAttributeQuery): SQL[] {
	const db = getDb();
	const conditions: SQL[] = [];

	if (query.owner.length > 0) {
		// `none` — «без ответственного»: вместе с людьми через то же «или».
		const people = query.owner.filter((value) => value !== NO_OPTION);
		const alternatives: SQL[] = [];

		if (people.length > 0) {
			alternatives.push(inArray(interactions.ownerUserId, people));
		}

		if (people.length < query.owner.length) {
			alternatives.push(isNull(interactions.ownerUserId));
		}

		conditions.push(or(...alternatives) ?? sql`false`);
	}

	if (query.org.length > 0) {
		conditions.push(
			exists(
				db
					.select({ one: sql`1` })
					.from(interactionParties)
					.where(
						and(
							eq(interactionParties.interactionId, interactions.id),
							eq(interactionParties.isPrimary, true),
							inArray(interactionParties.organizationId, query.org)
						)
					)
			)
		);
	}

	if (query.dir.length > 0) {
		const viaProducts = exists(
			db
				.select({ one: sql`1` })
				.from(interactionProducts)
				.innerJoin(
					productDirections,
					eq(productDirections.productId, interactionProducts.productId)
				)
				.where(
					and(
						eq(interactionProducts.interactionId, interactions.id),
						inArray(productDirections.directionId, query.dir)
					)
				)
		);

		const viaPrograms = exists(
			db
				.select({ one: sql`1` })
				.from(interactionPrograms)
				.innerJoin(programs, eq(programs.id, interactionPrograms.programId))
				.where(
					and(
						eq(interactionPrograms.interactionId, interactions.id),
						inArray(programs.directionId, query.dir)
					)
				)
		);

		const combined = or(viaProducts, viaPrograms);

		if (combined !== undefined) {
			conditions.push(combined);
		}
	}

	if (query.prog.length > 0) {
		conditions.push(
			exists(
				db
					.select({ one: sql`1` })
					.from(interactionPrograms)
					.where(
						and(
							eq(interactionPrograms.interactionId, interactions.id),
							inArray(interactionPrograms.programId, query.prog)
						)
					)
			)
		);
	}

	if (query.prod.length > 0) {
		conditions.push(
			exists(
				db
					.select({ one: sql`1` })
					.from(interactionProducts)
					.where(
						and(
							eq(interactionProducts.interactionId, interactions.id),
							inArray(interactionProducts.productId, query.prod)
						)
					)
			)
		);
	}

	return conditions;
}

/**
 * Условия выборки списка. Одни и те же для страницы и для счётчика.
 *
 * `preselected` — дела, заранее отобранные правилом приложения: раздел «Моего
 * дня» (`query.day`) и тишина (`state=stale`). Оба правила считаются в
 * приложении — с порогами из настроек и нормой из слепка стадии, — и второе их
 * описание на SQL однажды разошлось бы с главной. `null` — такого отбора нет.
 */
function listConditions(
	ctx: ActorContext,
	query: InteractionListQuery,
	preselected: readonly string[] | null
): SQL[] {
	const conditions: SQL[] = [interactionScopeFilter(ctx), ...interactionAttributeConditions(query)];

	if (query.status !== null) {
		conditions.push(eq(interactions.status, query.status));
	}

	if (query.ownerUserId !== null) {
		conditions.push(eq(interactions.ownerUserId, query.ownerUserId));
	}

	if (query.organizationId !== null) {
		conditions.push(
			exists(
				getDb()
					.select({ one: sql`1` })
					.from(interactionParties)
					.where(
						and(
							eq(interactionParties.interactionId, interactions.id),
							eq(interactionParties.organizationId, query.organizationId)
						)
					)
			)
		);
	}

	if (query.workspace !== null) {
		// Пространство задаётся ключом, а не идентификатором: он стоит в адресе,
		// его читают люди, и он не меняется от установки к установке.
		conditions.push(
			exists(
				getDb()
					.select({ one: sql`1` })
					.from(workspaces)
					.where(
						and(eq(workspaces.id, interactions.workspaceId), eq(workspaces.key, query.workspace))
					)
			)
		);
	}

	if (query.stageCategory !== null) {
		// Смысловая группа берётся из слепка стадии: он и есть то, что видит
		// исполнитель в карточке.
		conditions.push(sql`${stageEntries.stageSnapshot} ->> 'category' = ${query.stageCategory}`);
	}

	if (query.overdue) {
		conditions.push(eq(stageEntryStatus.isOverdue, true));
	}

	// Состояния — те же правила, что у плиток главной (`overview.ts`); тишину
	// отбирает `preselected`.
	if (query.state === 'paused') {
		conditions.push(eq(stageEntryStatus.isPaused, true));
	} else if (query.state === 'blocked') {
		conditions.push(
			exists(
				getDb()
					.select({ one: sql`1` })
					.from(blockers)
					.where(and(eq(blockers.interactionId, interactions.id), isNull(blockers.resolvedAt)))
			)
		);
	}

	if (query.closedWithin !== null) {
		// Закрытая запись больше не меняется, и её последнее событие — это
		// закрытие: то же правило, что у плитки «Завершённые» (`overview.ts`).
		conditions.push(
			ne(interactions.status, 'active'),
			sql`${interactions.lastActivityAt} >= now() - make_interval(days => ${query.closedWithin})`
		);
	}

	if (preselected !== null) {
		conditions.push(
			preselected.length === 0 ? sql`false` : inArray(interactions.id, [...preselected])
		);
	}

	if (query.q !== null) {
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
 * Порядок списка.
 *
 * Последним ключом всегда идёт идентификатор. Без него порядок строк с
 * одинаковым значением — например, с одним и тем же моментом последнего
 * события — Postgres не обещает вовсе: две страницы подряд собираются двумя
 * запросами, и строка с границы может показаться дважды или не показаться ни
 * разу. Идентификатор дописывает к любому ключу однозначность.
 */
function listOrder(query: InteractionListQuery): SQL[] {
	const tiebreaker = asc(interactions.id);

	switch (query.sort) {
		case 'title':
			return [asc(interactions.title), tiebreaker];
		case '-title':
			return [desc(interactions.title), tiebreaker];
		case 'dueAt':
			return [sql`${stageEntryStatus.dueAt} asc nulls last`, tiebreaker];
		case '-dueAt':
			return [sql`${stageEntryStatus.dueAt} desc nulls last`, tiebreaker];
		case 'lastActivityAt':
			return [asc(interactions.lastActivityAt), tiebreaker];
		default:
			return [desc(interactions.lastActivityAt), tiebreaker];
	}
}

/** Основные стороны процесса: вуз и заказчик подготовки. */
async function readPartyNames(
	interactionIds: string[]
): Promise<Map<string, { institutionName: string | null; customerName: string | null }>> {
	const result = new Map<string, { institutionName: string | null; customerName: string | null }>();

	if (interactionIds.length === 0) {
		return result;
	}

	const rows = await getDb()
		.select({
			interactionId: interactionParties.interactionId,
			partyRole: interactionParties.partyRole,
			isPrimary: interactionParties.isPrimary,
			name: organizations.shortName
		})
		.from(interactionParties)
		.innerJoin(organizations, eq(organizations.id, interactionParties.organizationId))
		.where(inArray(interactionParties.interactionId, interactionIds))
		.orderBy(desc(interactionParties.isPrimary));

	for (const row of rows) {
		const current = result.get(row.interactionId) ?? { institutionName: null, customerName: null };

		if (row.partyRole === 'educational_institution' && current.institutionName === null) {
			current.institutionName = row.name;
		}

		if (row.partyRole === 'customer' && current.customerName === null) {
			current.customerName = row.name;
		}

		result.set(row.interactionId, current);
	}

	return result;
}

/**
 * Пространство, в которое отвести человека, пришедшего по прежнему адресу
 * `/interactions`.
 *
 * То, где у него есть работа: место без единого взаимодействия открыло бы
 * пустой список там, где работа идёт по соседству. Это ровно то правило, по
 * которому раньше доска выбирала группу, — с одной разницей: теперь оно решает,
 * куда отвести, и срабатывает однократно, а не подменяет содержимое экрана при
 * каждом заходе.
 */
export async function chooseWorkspaceForWork(
	ctx: ActorContext
): Promise<{ id: string; key: string } | null> {
	requirePermission(ctx, 'interactions.read');

	const rows = await getDb()
		.select({
			id: workspaces.id,
			key: workspaces.key,
			position: workspaces.position,
			value: count(interactions.id)
		})
		.from(workspaces)
		.leftJoin(
			interactions,
			and(
				eq(interactions.workspaceId, workspaces.id),
				eq(interactions.status, 'active'),
				interactionScopeFilter(ctx)
			)
		)
		// Отводить можно только туда, куда сотрудник включён: чужое пространство
		// без работы ответило бы ему 404, а не пустым списком.
		.where(workspaceFilter(ctx, workspaces.id))
		.groupBy(workspaces.id)
		.orderBy(asc(workspaces.position));

	const withWork = [...rows]
		.filter((row) => row.value > 0)
		.sort((left, right) => right.value - left.value);

	const chosen = withWork[0] ?? rows[0];

	return chosen === undefined ? null : { id: chosen.id, key: chosen.key };
}

/**
 * Дела, отобранные правилами приложения (`listConditions`): раздел «Моего дня»
 * и тишина. Оба заданы — пересечение.
 */
async function preselectIds(
	ctx: ActorContext,
	query: InteractionListQuery
): Promise<string[] | null> {
	const [day, stale] = await Promise.all([
		query.day === null ? null : listMyDayInteractionIds(ctx, query.day),
		query.state === 'stale' ? listStaleInteractionIds(ctx) : null
	]);

	if (day === null) {
		return stale;
	}

	return stale === null ? day : day.filter((id) => stale.includes(id));
}

export async function listInteractions(
	ctx: ActorContext,
	query: InteractionListQuery
): Promise<PageResult<InteractionListItem>> {
	requirePermission(ctx, 'interactions.read');

	const db = getDb();
	const where = and(...listConditions(ctx, query, await preselectIds(ctx, query)));

	const page = db
		.select({
			interaction: interactions,
			ownerName: users.fullName,
			entry: {
				id: stageEntries.id,
				stageId: stageEntries.stageId,
				snapshot: stageEntries.stageSnapshot
			},
			status: {
				dueAt: stageEntryStatus.dueAt,
				remainingSeconds: stageEntryStatus.remainingSeconds,
				isOverdue: stageEntryStatus.isOverdue,
				isPaused: stageEntryStatus.isPaused
			}
		})
		.from(interactions)
		.leftJoin(users, eq(users.id, interactions.ownerUserId))
		.leftJoin(
			stageEntries,
			and(eq(stageEntries.interactionId, interactions.id), isNull(stageEntries.leftAt))
		)
		.leftJoin(stageEntryStatus, eq(stageEntryStatus.stageEntryId, stageEntries.id))
		.where(where)
		.orderBy(...listOrder(query))
		.limit(query.pageSize)
		.offset((query.page - 1) * query.pageSize);

	const totals = db
		.select({ value: count() })
		.from(interactions)
		.leftJoin(
			stageEntries,
			and(eq(stageEntries.interactionId, interactions.id), isNull(stageEntries.leftAt))
		)
		.leftJoin(stageEntryStatus, eq(stageEntryStatus.stageEntryId, stageEntries.id))
		.where(where);

	const [rows, totalRows] = await Promise.all([page, totals]);
	const ids = rows.map((row) => row.interaction.id);

	const [partyNames, progressByInteraction, blockerCounts] = await Promise.all([
		readPartyNames(ids),
		readProgress(rows),
		readOpenBlockerCounts(ids)
	]);

	return {
		items: rows.map((row) => {
			const snapshot = row.entry?.snapshot ?? null;

			return {
				id: row.interaction.id,
				title: row.interaction.title,
				status: row.interaction.status,
				ownerUserId: row.interaction.ownerUserId,
				ownerName: row.ownerName,
				lastActivityAt: row.interaction.lastActivityAt,
				institutionName: partyNames.get(row.interaction.id)?.institutionName ?? null,
				customerName: partyNames.get(row.interaction.id)?.customerName ?? null,
				stage:
					row.entry === null || snapshot === null
						? null
						: {
								id: row.entry.stageId,
								key: snapshot.key,
								name: snapshot.name,
								position: snapshot.position,
								category: snapshot.category
							},
				progress: progressByInteraction.get(row.interaction.id) ?? [],
				dueAt: row.status?.dueAt ?? null,
				remainingSeconds: row.status?.remainingSeconds ?? null,
				isOverdue: row.status?.isOverdue ?? false,
				isPaused: row.status?.isPaused ?? false,
				isStale: isStale(snapshot, row.interaction.lastActivityAt),
				openBlockers: blockerCounts.get(row.interaction.id) ?? 0
			};
		}),
		total: totalRows[0]?.value ?? 0,
		page: query.page,
		pageSize: query.pageSize
	};
}

/**
 * Варианты фильтров вуз/направление/программа/продукт списка и доски.
 *
 * Каталог отчёта (`reports/options.ts`) сюда не годится без правки: он несёт
 * весь справочник в области доступа, а не то, что реально встречается в
 * пространстве, — направления и продукты не привязаны к пространству в схеме,
 * и без сужения по фактическому участию список предлагал бы выбрать «Продукт
 * X», под которым в этом пространстве нет ни одной записи. Поэтому запрос
 * свой: он идёт не от справочника, а от взаимодействий пространства в области
 * доступа — тем же отбором, что `interactionScopeFilter` даёт списку.
 *
 * Не кэшируется: страница списка и так делает несколько запросов на
 * открытие, а объём данных на пространство — единицы и десятки строк, не
 * тысячи.
 */
export async function readInteractionFilterOptions(
	ctx: ActorContext,
	workspaceId: string
): Promise<InteractionFilterOptions> {
	requirePermission(ctx, 'interactions.read');

	const db = getDb();
	const scope = and(interactionScopeFilter(ctx), eq(interactions.workspaceId, workspaceId));

	const [
		organizationRows,
		programRows,
		productRows,
		programDirectionRows,
		ownerRows,
		unassignedRows
	] = await Promise.all([
		db
			.selectDistinct({ value: organizations.id, label: organizations.shortName })
			.from(interactions)
			.innerJoin(
				interactionParties,
				and(
					eq(interactionParties.interactionId, interactions.id),
					eq(interactionParties.isPrimary, true)
				)
			)
			.innerJoin(organizations, eq(organizations.id, interactionParties.organizationId))
			.where(scope)
			.orderBy(asc(organizations.shortName)),
		db
			.selectDistinct({ value: programs.id, label: programs.name })
			.from(interactions)
			.innerJoin(interactionPrograms, eq(interactionPrograms.interactionId, interactions.id))
			.innerJoin(programs, eq(programs.id, interactionPrograms.programId))
			.where(scope)
			.orderBy(asc(programs.name)),
		db
			.selectDistinct({ value: products.id, label: products.name })
			.from(interactions)
			.innerJoin(interactionProducts, eq(interactionProducts.interactionId, interactions.id))
			.innerJoin(products, eq(products.id, interactionProducts.productId))
			.where(scope)
			.orderBy(asc(products.name)),
		db
			.selectDistinct({ value: programs.directionId })
			.from(interactions)
			.innerJoin(interactionPrograms, eq(interactionPrograms.interactionId, interactions.id))
			.innerJoin(programs, eq(programs.id, interactionPrograms.programId))
			.where(and(scope, isNotNull(programs.directionId))),
		// Продукты уже отобраны выше — направления продукта читаются по ним, а не
		// вторым проходом по взаимодействиям.
		db
			.selectDistinct({ value: users.id, label: users.fullName })
			.from(interactions)
			.innerJoin(users, eq(users.id, interactions.ownerUserId))
			.where(scope)
			.orderBy(asc(users.fullName)),
		db
			.select({ id: interactions.id })
			.from(interactions)
			.where(and(scope, isNull(interactions.ownerUserId)))
			.limit(1)
	]);

	const productDirectionRows =
		productRows.length === 0
			? []
			: await db
					.selectDistinct({ value: productDirections.directionId })
					.from(productDirections)
					.where(
						inArray(
							productDirections.productId,
							productRows.map((row) => row.value)
						)
					);

	const directionIds = new Set<string>([
		...programDirectionRows
			.map((row) => row.value)
			.filter((value): value is string => value !== null),
		...productDirectionRows.map((row) => row.value)
	]);

	const directionRows =
		directionIds.size === 0
			? []
			: await db
					.select({ value: directions.id, label: directions.name })
					.from(directions)
					.where(inArray(directions.id, [...directionIds]))
					.orderBy(asc(directions.position));

	return {
		organizations: organizationRows,
		directions: directionRows,
		programs: programRows,
		products: productRows,
		owners: ownerRows,
		hasUnassigned: unassignedRows.length > 0
	};
}

/** Сколько открытых помех у каждого взаимодействия страницы. */
async function readOpenBlockerCounts(interactionIds: string[]): Promise<Map<string, number>> {
	if (interactionIds.length === 0) {
		return new Map();
	}

	const rows = await getDb()
		.select({ interactionId: blockers.interactionId, value: count() })
		.from(blockers)
		.where(and(inArray(blockers.interactionId, interactionIds), isNull(blockers.resolvedAt)))
		.groupBy(blockers.interactionId);

	return new Map(rows.map((row) => [row.interactionId, row.value]));
}

type ListRow = {
	interaction: typeof interactions.$inferSelect;
	entry: { id: string; stageId: string; snapshot: StageSnapshot } | null;
	status: { dueAt: Date; isOverdue: boolean; isPaused: boolean } | null;
};

/**
 * Лента процесса для каждой строки списка. Действующая редакция читается по
 * одному разу на пространство, а не на строку: в списке они почти всегда
 * одинаковые.
 *
 * Записи сопоставляются со стадиями по ключу из снимка: строка `stages` живёт
 * внутри редакции, и после изменения процесса соединение по `stage_id`
 * показало бы пустую историю.
 */
async function readProgress(rows: ListRow[]): Promise<Map<string, StageProgressItem[]>> {
	const result = new Map<string, StageProgressItem[]>();

	if (rows.length === 0) {
		return result;
	}

	const db = getDb();
	const workspaceIds = [...new Set(rows.map((row) => row.interaction.workspaceId))];
	const revisions = new Map(
		await Promise.all(
			workspaceIds.map(
				async (workspaceId) =>
					[workspaceId, await readActiveRevisionForWorkspace(workspaceId)] as const
			)
		)
	);

	const [entryRows, introductions] = await Promise.all([
		db
			.select({
				interactionId: stageEntries.interactionId,
				stageId: stageEntries.stageId,
				snapshot: stageEntries.stageSnapshot,
				enteredAt: stageEntries.enteredAt,
				leftAt: stageEntries.leftAt
			})
			.from(stageEntries)
			.where(
				inArray(
					stageEntries.interactionId,
					rows.map((row) => row.interaction.id)
				)
			),
		Promise.all(
			[...revisions].map(
				async ([workspaceId, revision]) =>
					[
						workspaceId,
						revision === null ? new Map<string, Date>() : await readStageIntroductions(db, revision)
					] as const
			)
		).then((pairs) => new Map(pairs))
	]);

	const entriesByInteraction = new Map<string, ProgressEntry[]>();

	for (const entry of entryRows) {
		const list = entriesByInteraction.get(entry.interactionId) ?? [];
		list.push({
			stageId: entry.stageId,
			stageKey: entry.snapshot.key,
			name: entry.snapshot.name,
			position: entry.snapshot.position,
			category: entry.snapshot.category,
			enteredAt: entry.enteredAt,
			leftAt: entry.leftAt
		});
		entriesByInteraction.set(entry.interactionId, list);
	}

	const blocking = await readBlockingInteractions(rows.map((row) => row.interaction.id));

	for (const row of rows) {
		const revision = revisions.get(row.interaction.workspaceId);

		if (revision === undefined || revision === null) {
			continue;
		}

		result.set(
			row.interaction.id,
			buildProgress(
				revision.stages,
				entriesByInteraction.get(row.interaction.id) ?? [],
				row.entry === null || row.status === null
					? null
					: {
							stageKey: row.entry.snapshot.key,
							dueAt: row.status.dueAt,
							isOverdue: row.status.isOverdue,
							isPaused: row.status.isPaused
						},
				blocking.has(row.interaction.id),
				introductions.get(row.interaction.workspaceId) ?? new Map()
			)
		);
	}

	return result;
}

/** У кого есть открытая помеха, запрещающая переход. */
async function readBlockingInteractions(interactionIds: string[]): Promise<Set<string>> {
	if (interactionIds.length === 0) {
		return new Set();
	}

	const rows = await getDb()
		.select({ interactionId: blockers.interactionId })
		.from(blockers)
		.where(
			and(
				inArray(blockers.interactionId, interactionIds),
				isNull(blockers.resolvedAt),
				eq(blockers.blocksTransition, true)
			)
		);

	return new Set(rows.map((row) => row.interactionId));
}

async function readParties(
	ctx: ActorContext,
	interactionId: string
): Promise<InteractionPartyView[]> {
	// Карточка показывает контакты сторон, а значит, оставляет след просмотра
	// персональных данных. Область сбора открывается до выборки: тогда чтения,
	// запущенные загрузчиком страницы разом, складываются в одно событие.
	return withPiiTrace(ctx, () => readPartyRows(ctx, interactionId));
}

async function readPartyRows(
	ctx: ActorContext,
	interactionId: string
): Promise<InteractionPartyView[]> {
	const db = getDb();

	const rows = await db
		.select({
			party: interactionParties,
			organizationName: organizations.shortName,
			affiliation: affiliations,
			person: people
		})
		.from(interactionParties)
		.innerJoin(organizations, eq(organizations.id, interactionParties.organizationId))
		.leftJoin(affiliations, eq(affiliations.id, interactionParties.contactAffiliationId))
		.leftJoin(people, eq(people.id, affiliations.personId))
		.where(eq(interactionParties.interactionId, interactionId))
		.orderBy(desc(interactionParties.isPrimary));

	const siteRows =
		rows.length === 0
			? []
			: await db
					.select({ partyId: interactionPartySites.partyId, id: sites.id, name: sites.name })
					.from(interactionPartySites)
					.innerJoin(sites, eq(sites.id, interactionPartySites.siteId))
					.where(
						inArray(
							interactionPartySites.partyId,
							rows.map((row) => row.party.id)
						)
					)
					.orderBy(asc(sites.name));

	return rows.map((row) => ({
		id: row.party.id,
		organizationId: row.party.organizationId,
		organizationName: row.organizationName,
		partyRole: row.party.partyRole,
		isPrimary: row.party.isPrimary,
		contactAffiliationId: row.party.contactAffiliationId,
		// Контакты человека наружу отдаёт только сериализатор: маскирование,
		// забытое во вложенном ответе, — это утечка.
		contact: row.person === null ? null : toPersonView(ctx, row.person),
		contactPosition: row.affiliation?.position ?? null,
		// Канал связи — способ достучаться до человека: его видит тот, кому
		// открыты люди организации, как и в её карточке.
		contactChannel: can(ctx, 'people.read') ? (row.affiliation?.channel ?? null) : null,
		sites: siteRows
			.filter((site) => site.partyId === row.party.id)
			.map((site) => ({ id: site.id, name: site.name }))
	}));
}

async function readPrograms(interactionId: string): Promise<InteractionProgramView[]> {
	const rows = await getDb()
		.select({
			programId: interactionPrograms.programId,
			programVersionId: interactionPrograms.programVersionId,
			code: programs.code,
			name: programs.name
		})
		.from(interactionPrograms)
		.innerJoin(programs, eq(programs.id, interactionPrograms.programId))
		.where(eq(interactionPrograms.interactionId, interactionId))
		.orderBy(asc(programs.code));

	return rows;
}

async function readProducts(interactionId: string): Promise<InteractionProductView[]> {
	const rows = await getDb()
		.select({ productId: interactionProducts.productId, code: products.code, name: products.name })
		.from(interactionProducts)
		.innerJoin(products, eq(products.id, interactionProducts.productId))
		.where(eq(interactionProducts.interactionId, interactionId))
		.orderBy(asc(products.code));

	return rows;
}

/**
 * Договор взаимодействия и выбранные из него позиции.
 *
 * Читается по `interactions.contract_id`, а позиции — по связи: позиций у
 * договора бывает больше, чем выбрало взаимодействие, и показывать все значило
 * бы приписать записи условия, по которым она не идёт.
 */
async function readContract(
	interactionId: string,
	contractId: string | null
): Promise<InteractionContractView | null> {
	if (contractId === null) {
		return null;
	}

	const [contract] = await getDb()
		.select({
			id: contracts.id,
			number: contracts.number,
			status: contracts.status,
			signedOn: contracts.signedOn,
			validUntil: contracts.validUntil
		})
		.from(contracts)
		.where(eq(contracts.id, contractId))
		.limit(1);

	if (contract === undefined) {
		return null;
	}

	const items = await getDb()
		.select({
			id: contractItems.id,
			productId: contractItems.productId,
			code: products.code,
			name: products.name,
			licenseSignedAt: contractItems.licenseSignedAt,
			licenseUntil: contractItems.licenseUntil,
			transferStatus: contractItems.transferStatus
		})
		.from(interactionContractItems)
		.innerJoin(contractItems, eq(contractItems.id, interactionContractItems.contractItemId))
		.innerJoin(products, eq(products.id, contractItems.productId))
		.where(eq(interactionContractItems.interactionId, interactionId))
		.orderBy(asc(products.code));

	return { ...contract, items };
}

/**
 * Документы взаимодействия — только перечень. Содержимое отдаёт маршрут
 * скачивания, и он же записывает выдачу в журнал.
 */
async function readDocuments(interactionId: string): Promise<InteractionDocumentView[]> {
	const rows = await getDb()
		.select({
			id: documents.id,
			kind: documents.kind,
			templateKey: documents.templateKey,
			supersedesId: documents.supersedesId,
			signing: documents.signing,
			title: documents.title,
			mime: documents.mime,
			sizeBytes: documents.sizeBytes,
			createdAt: documents.createdAt,
			agreedAt: documents.agreedAt,
			approvedAt: documents.approvedAt,
			inEffectAt: documents.inEffectAt,
			agreedNote: documents.agreedNote,
			approvedNote: documents.approvedNote,
			inEffectNote: documents.inEffectNote
		})
		.from(documents)
		.where(eq(documents.interactionId, interactionId))
		.orderBy(desc(documents.createdAt));

	// Загрузка новой редакции наследует вид «собран по шаблону» и шаблон, но
	// город и подписантов сборки у неё нет: подписи сборщика нет — это скан.
	return rows.map(({ supersedesId, signing, ...row }) => ({
		...row,
		scan: row.kind === GENERATED_DOCUMENT_KIND && supersedesId !== null && signing === null
	}));
}

/** Карточка без сторон: то, что одинаково для всех, кто её видит. */
type InteractionBase = Omit<InteractionView, 'parties'>;

async function buildInteractionBase(interactionId: string): Promise<InteractionBase> {
	const [row] = await getDb()
		.select({
			interaction: interactions,
			workspaceKey: workspaces.key,
			workspaceName: workspaces.name,
			ownerName: users.fullName
		})
		.from(interactions)
		.innerJoin(workspaces, eq(workspaces.id, interactions.workspaceId))
		.leftJoin(users, eq(users.id, interactions.ownerUserId))
		.where(eq(interactions.id, interactionId))
		.limit(1);

	if (row === undefined) {
		throw new NotFoundError('Взаимодействие не найдено');
	}

	const [programList, productList, contract, documentList] = await Promise.all([
		readPrograms(interactionId),
		readProducts(interactionId),
		readContract(interactionId, row.interaction.contractId),
		readDocuments(interactionId)
	]);

	return {
		id: row.interaction.id,
		title: row.interaction.title,
		status: row.interaction.status,
		workspaceId: row.interaction.workspaceId,
		workspaceKey: row.workspaceKey,
		workspaceName: row.workspaceName,
		agreementPeriodStart: row.interaction.agreementPeriodStart,
		agreementPeriodEnd: row.interaction.agreementPeriodEnd,
		academicPeriodStart: row.interaction.academicPeriodStart,
		academicPeriodEnd: row.interaction.academicPeriodEnd,
		ownerUserId: row.interaction.ownerUserId,
		ownerName: row.ownerName,
		lastActivityAt: row.interaction.lastActivityAt,
		externalSource: row.interaction.externalSource,
		externalId: row.interaction.externalId,
		createdAt: row.interaction.createdAt,
		updatedAt: row.interaction.updatedAt,
		editVersion: row.interaction.editVersion,
		programs: programList,
		products: productList,
		contract,
		documents: documentList
	};
}

/** Дата из JSON или `null`, если её там не было. */
function reviveMoment(value: Date | null): Date | null {
	return value === null ? null : new Date(value);
}

function reviveInteractionBase(stored: unknown): InteractionBase {
	const base = stored as InteractionBase;

	return {
		...base,
		lastActivityAt: new Date(base.lastActivityAt),
		createdAt: new Date(base.createdAt),
		updatedAt: new Date(base.updatedAt),
		documents: base.documents.map((document) => ({
			...document,
			createdAt: new Date(document.createdAt),
			agreedAt: reviveMoment(document.agreedAt),
			approvedAt: reviveMoment(document.approvedAt),
			inEffectAt: reviveMoment(document.inEffectAt)
		}))
	};
}

/**
 * Карточка взаимодействия целиком.
 *
 * Собирается из двух половин, и делятся они не по удобству, а по тому, можно ли
 * их кэшировать. Всё, что одинаково для любого, кто карточку видит — сама
 * запись, её процесс, программы, продукты, перечень документов, — живёт в Redis
 * до следующего события по записи (`cache/interactions.ts`). Стороны читаются
 * из базы **каждый раз**: их контакты проходят через сериализатор, который
 * маскирует их по правам и оставляет след просмотра персональных данных, — а
 * ответ, отданный из кэша, этот след потерял бы.
 */
export async function getInteraction(
	ctx: ActorContext,
	interactionId: string
): Promise<InteractionView> {
	requirePermission(ctx, 'interactions.read');

	const interaction = await assertInteractionVisible(ctx, interactionId);

	const [base, parties] = await Promise.all([
		cachedInteractionPart(
			'base',
			interaction,
			() => buildInteractionBase(interactionId),
			reviveInteractionBase
		),
		readParties(ctx, interactionId)
	]);

	return { ...base, parties };
}

/**
 * Лента комментариев карточки.
 *
 * Читается при каждом открытии, а меняется только когда по взаимодействию
 * что-то произошло, — поэтому собранная лента живёт в Redis до следующего
 * события по записи (`cache/interactions.ts`). Право и видимость проверяются
 * до кэша и по базе: кэш ускоряет ответ, а не решает, кому он положен.
 */
/** Подпись комментария, пришедшего с заявкой сайта. */
const INTAKE_COMMENT_AUTHOR = 'Заявка с сайта';

export async function listComments(
	ctx: ActorContext,
	interactionId: string
): Promise<CommentView[]> {
	requirePermission(ctx, 'interactions.read');
	const interaction = await assertInteractionVisible(ctx, interactionId);

	return cachedInteractionPart(
		'comments',
		interaction,
		async () => {
			const rows = await getDb()
				.select({ comment: comments, authorName: users.fullName })
				.from(comments)
				.innerJoin(users, eq(users.id, comments.authorId))
				.where(eq(comments.interactionId, interactionId))
				.orderBy(desc(comments.createdAt));

			return rows.map((row) => ({
				id: row.comment.id,
				authorId: row.comment.authorId,
				// Текст заявки заносит приём от имени ответственного за входящие, но
				// написал его не он: в ленте он подписан источником, а не сотрудником.
				authorName:
					row.comment.source === 'application_intake' ? INTAKE_COMMENT_AUTHOR : row.authorName,
				source: row.comment.source,
				body: row.comment.body,
				createdAt: row.comment.createdAt
			}));
		},
		// JSON не знает про `Date`: момент возвращается из строки обратно в дату,
		// иначе карточка получила бы строку там, где объявлена дата.
		(stored) =>
			(stored as CommentView[]).map((row) => ({ ...row, createdAt: new Date(row.createdAt) }))
	);
}

/**
 * Ссылочные поля истории правок: в значении лежит идентификатор, а на экран
 * выходит имя. Сюда попадает всё, у чего значение — ссылка на другую запись;
 * название, сроки и учебный период ссылками не являются и подписи не получают.
 */
const REFERENCE_FIELDS = {
	ownerUserId: 'user',
	parties: 'organization',
	programs: 'program',
	products: 'product',
	contract: 'contract',
	contractItems: 'contract_item',
	contact: 'affiliation',
	sites: 'site'
} as const;

type ReferenceKind = (typeof REFERENCE_FIELDS)[keyof typeof REFERENCE_FIELDS];

/** Подпись записи, которой уже нет: сырой идентификатор на экран не выходит. */
const UNKNOWN_REFERENCE = 'недоступно';

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Идентификаторы, на которые ссылается одно значение истории.
 *
 * `null` — ссылаться не на что (поле очистили или заполнили впервые): такое
 * значение показывается прочерком, а не подписью несуществующей записи. Пустая
 * строка внутри списка — элемент незнакомой формы; он станет «недоступно», как
 * и удалённая запись, потому что назвать его всё равно нечем.
 */
function referencedIds(field: string, value: unknown): string[] | null {
	if (value === null || value === undefined) {
		return null;
	}

	// Одиночная ссылка: ответственный, договор и контактное лицо лежат в
	// значении строкой, а не списком, — и пустой договор это «договора нет», а
	// не «список пуст».
	if (field === 'ownerUserId' || field === 'contract' || field === 'contact') {
		return typeof value === 'string' ? [value] : [''];
	}

	if (!Array.isArray(value)) {
		return [''];
	}

	if (field === 'parties') {
		return value.map((item) =>
			isRecord(item) && typeof item.organizationId === 'string' ? item.organizationId : ''
		);
	}

	// Программа записывается вместе с версией; ранние строки истории хранят
	// одни идентификаторы программ, и читаются они так же.
	if (field === 'programs') {
		return value.map((item) =>
			typeof item === 'string'
				? item
				: isRecord(item) && typeof item.programId === 'string'
					? item.programId
					: ''
		);
	}

	return value.map((item) => (typeof item === 'string' ? item : ''));
}

/**
 * Роль стороны рядом с её именем: «СПбПУ (учебное заведение)» и «СПбПУ
 * (компания-заказчик)» — разные строки истории, и без роли правка сторон
 * читалась бы как «ничего не изменилось».
 */
function partyRoleSuffix(item: unknown): string {
	if (!isRecord(item) || typeof item.partyRole !== 'string') {
		return '';
	}

	const label = PARTY_ROLE_LABELS[item.partyRole as PartyRole];

	if (label === undefined) {
		return '';
	}

	// Признак основной стороны пишется с правки состава: смена основной —
	// такое же решение, как смена роли.
	const role = label.toLocaleLowerCase('ru');

	return item.isPrimary === true ? ` (${role}, основная)` : ` (${role})`;
}

/** Версия программы в строке истории; `null` — версия не закреплена или строка ранняя. */
function programVersionOf(item: unknown): string | null {
	return isRecord(item) && typeof item.programVersionId === 'string' ? item.programVersionId : null;
}

/** Номера версий программ, упомянутых в истории, — одним запросом. */
async function readProgramVersionNumbers(ids: Set<string>): Promise<Map<string, number>> {
	if (ids.size === 0) {
		return new Map();
	}

	const rows = await getDb()
		.select({ id: programVersions.id, version: programVersions.version })
		.from(programVersions)
		.where(inArray(programVersions.id, [...ids]));

	return new Map(rows.map((row) => [row.id, row.version]));
}

/** Имена записей по идентификаторам — по одному запросу на вид ссылки. */
async function readReferenceNames(
	wanted: Map<ReferenceKind, Set<string>>
): Promise<Map<ReferenceKind, Map<string, string>>> {
	const db = getDb();
	const resolved = new Map<ReferenceKind, Map<string, string>>();

	const read = async (
		kind: ReferenceKind,
		query: (ids: string[]) => Promise<{ id: string; name: string }[]>
	): Promise<void> => {
		const ids = wanted.get(kind);

		if (ids === undefined || ids.size === 0) {
			return;
		}

		const rows = await query([...ids]);

		resolved.set(kind, new Map(rows.map((row) => [row.id, row.name])));
	};

	await Promise.all([
		read('user', (ids) =>
			db.select({ id: users.id, name: users.fullName }).from(users).where(inArray(users.id, ids))
		),
		read('organization', (ids) =>
			db
				.select({ id: organizations.id, name: organizations.shortName })
				.from(organizations)
				.where(inArray(organizations.id, ids))
		),
		read('program', (ids) =>
			db
				.select({ id: programs.id, name: programs.name })
				.from(programs)
				.where(inArray(programs.id, ids))
		),
		read('product', (ids) =>
			db
				.select({ id: products.id, name: products.name })
				.from(products)
				.where(inArray(products.id, ids))
		),
		read('contract', (ids) =>
			db
				.select({ id: contracts.id, name: contracts.number })
				.from(contracts)
				.where(inArray(contracts.id, ids))
		),
		// Позиция договора называется своим продуктом: «позиция 3f2a…» не
		// объясняет, что именно в работе поменялось.
		read('contract_item', (ids) =>
			db
				.select({ id: contractItems.id, name: products.name })
				.from(contractItems)
				.innerJoin(products, eq(products.id, contractItems.productId))
				.where(inArray(contractItems.id, ids))
		),
		read('site', (ids) =>
			db.select({ id: sites.id, name: sites.name }).from(sites).where(inArray(sites.id, ids))
		),
		// Контактное лицо называется человеком, а не его ролью: имя берётся из
		// карточки человека при чтении, и обезличенный человек не всплывает в
		// истории прежним именем.
		read('affiliation', (ids) =>
			db
				.select({
					id: affiliations.id,
					name: sql<string>`${people.lastName} || ' ' || ${people.firstName}`
				})
				.from(affiliations)
				.innerJoin(people, eq(people.id, affiliations.personId))
				.where(inArray(affiliations.id, ids))
		)
	]);

	return resolved;
}

/**
 * Предметная история плана: сроки, стороны, программы, ответственный.
 *
 * Самое дорогое чтение карточки: к выборке самих строк добавляются подписи
 * ссылочных значений — до четырёх запросов по справочникам. Поэтому собранная
 * история живёт в Redis до следующего события по взаимодействию
 * (`cache/interactions.ts`); переименование вуза доходит до неё по сроку жизни
 * записи, а не мгновенно.
 */
export async function listInteractionChanges(
	ctx: ActorContext,
	interactionId: string
): Promise<InteractionChangeView[]> {
	requirePermission(ctx, 'interactions.read');
	const interaction = await assertInteractionVisible(ctx, interactionId);

	return cachedInteractionPart(
		'changes',
		interaction,
		() => buildInteractionChanges(interactionId),
		(stored) =>
			(stored as InteractionChangeView[]).map((row) => ({
				...row,
				changedAt: new Date(row.changedAt)
			}))
	);
}

async function buildInteractionChanges(interactionId: string): Promise<InteractionChangeView[]> {
	const rows = await getDb()
		.select({ change: interactionChanges, authorName: users.fullName })
		.from(interactionChanges)
		.innerJoin(users, eq(users.id, interactionChanges.authorId))
		.where(eq(interactionChanges.interactionId, interactionId))
		.orderBy(desc(interactionChanges.changedAt));

	// Имена собираются на весь список сразу: строк истории у долгого
	// взаимодействия десятки, и запрос на каждую ссылку превратил бы вкладку
	// «История» в сотню запросов.
	const wanted = new Map<ReferenceKind, Set<string>>();

	for (const row of rows) {
		const kind = REFERENCE_FIELDS[row.change.field as keyof typeof REFERENCE_FIELDS];

		if (kind === undefined) {
			continue;
		}

		const ids = wanted.get(kind) ?? new Set<string>();

		for (const value of [row.change.oldValue, row.change.newValue]) {
			for (const referenced of referencedIds(row.change.field, value) ?? []) {
				if (referenced !== '') {
					ids.add(referenced);
				}
			}
		}

		wanted.set(kind, ids);
	}

	const versionIds = new Set<string>();

	for (const row of rows) {
		if (row.change.field !== 'programs') {
			continue;
		}

		for (const value of [row.change.oldValue, row.change.newValue]) {
			for (const item of Array.isArray(value) ? value : []) {
				const versionId = programVersionOf(item);

				if (versionId !== null) {
					versionIds.add(versionId);
				}
			}
		}
	}

	const [names, versions] = await Promise.all([
		readReferenceNames(wanted),
		readProgramVersionNumbers(versionIds)
	]);

	/** Версия рядом с программой: «переход на новую версию» иначе не отличить от «ничего». */
	function versionSuffix(item: unknown): string {
		const versionId = programVersionOf(item);

		if (versionId === null) {
			return '';
		}

		const version = versions.get(versionId);

		return version === undefined ? ' (версия недоступна)' : ` (версия ${version})`;
	}

	/** Подпись одного значения: `null` — поле не ссылочное. */
	function label(field: string, value: unknown): string | null {
		const kind = REFERENCE_FIELDS[field as keyof typeof REFERENCE_FIELDS];

		if (kind === undefined) {
			return null;
		}

		const ids = referencedIds(field, value);

		if (ids === null || ids.length === 0) {
			return '—';
		}

		const known = names.get(kind) ?? new Map<string, string>();
		const items = Array.isArray(value) ? value : [value];

		return ids
			.map((referenced, index) => {
				const name = known.get(referenced) ?? UNKNOWN_REFERENCE;

				if (field === 'parties') {
					return `${name}${partyRoleSuffix(items[index])}`;
				}

				return field === 'programs' ? `${name}${versionSuffix(items[index])}` : name;
			})
			.join(', ');
	}

	return rows.map((row) => ({
		id: row.change.id,
		changedAt: row.change.changedAt,
		authorId: row.change.authorId,
		authorName: row.authorName,
		field: row.change.field,
		oldValue: row.change.oldValue,
		newValue: row.change.newValue,
		oldLabel: label(row.change.field, row.change.oldValue),
		newLabel: label(row.change.field, row.change.newValue),
		reason: row.change.reason
	}));
}
