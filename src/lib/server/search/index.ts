/**
 * Выдача быстрого поиска.
 *
 * Граница доступа у каждой группы — та же, что у её раздела: организации,
 * взаимодействия, программы и продукты читаются самими читателями разделов,
 * вместе с их правом и областью. Там, где читатель раздела не умеет искать
 * нужным способом (человек по ФИО без расшифровки контактов, договор по
 * номеру, организация по домену сайта), выборка своя, но граница — тем же
 * серверным условием, что у списка раздела (`personInScope`, `scopeFilter`,
 * `visibleOrganizationFilter`), а не её пересказом: запись вне области обязана
 * не находиться, а не находиться и отказывать.
 */
import { and, asc, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import {
	SEARCH_GROUP_LIMIT,
	SEARCH_KINDS,
	type SearchHit,
	type SearchKind,
	type SearchResult
} from '$lib/search/contract';
import type { ActorContext } from '../actor';
import { getDb } from '../db';
import { affiliations, contracts, organizations, people } from '../db/schema';
import { listOrganizations, listProducts, listPrograms } from '../directory/read';
import { visibleOrganizationFilter } from '../interactions/access';
import { listInteractions } from '../interactions/read';
import { personInScope } from '../people/access';
import { hashEmail } from '../people/pii';
import { can, scopeFilter } from '../rbac';

/** Страница выдачи: первая и ровно в потолок группы. */
const PAGE = { page: 1, pageSize: SEARCH_GROUP_LIMIT } as const;

/** ФИО одной строкой — так же, как его ищет список людей. */
const PERSON_FULL_NAME = sql<string>`trim(
	${people.lastName} || ' ' || ${people.firstName} || ' ' || coalesce(${people.middleName}, '')
)`;

/**
 * Домен из строки запроса: адрес почты (`kam@spbstu.ru`), сайт с протоколом и
 * путём или голый домен. `null` — строка на домен не похожа, и искать по сайту
 * нечего: «ТТУ» с сайтом сравнивать незачем.
 */
function domainOf(query: string): string | null {
	const host = query
		.trim()
		.toLowerCase()
		.replace(/^.*@/u, '')
		.replace(/^[a-z]+:\/\//u, '')
		.replace(/^www\./u, '')
		.replace(/[/?#].*$/u, '');

	return /^[\p{L}\p{N}-]+(\.[\p{L}\p{N}-]+)+$/u.test(host) ? host : null;
}

/**
 * Организации по домену сайта. Граница — та же, что у списка организаций и
 * его поиска (`visibleOrganizationFilter`).
 */
async function organizationsByDomain(ctx: ActorContext, query: string): Promise<SearchHit[]> {
	const domain = domainOf(query);

	if (domain === null) {
		return [];
	}

	const rows = await getDb()
		.select({
			id: organizations.id,
			shortName: organizations.shortName,
			website: organizations.website
		})
		.from(organizations)
		.where(
			and(
				visibleOrganizationFilter(ctx, organizations.id),
				ilike(organizations.website, `%${domain}%`)
			)
		)
		.orderBy(asc(organizations.shortName), asc(organizations.id))
		.limit(SEARCH_GROUP_LIMIT);

	return rows.map((row) => ({
		kind: 'organization',
		id: row.id,
		targetId: row.id,
		title: row.shortName,
		subtitle: row.website
	}));
}

/**
 * Читатель группы. Право проверяется до выборки, а не отказом изнутри: поиск
 * показывает то, что человеку и так открыто, а про закрытый раздел молчит —
 * отказ на полпути превратил бы одну недоступную группу в пустую палитру.
 */
type GroupReader = (ctx: ActorContext, query: string) => Promise<SearchHit[]>;

const READERS: Record<SearchKind, GroupReader> = {
	organization: async (ctx, query) => {
		if (!can(ctx, 'organizations.read')) {
			return [];
		}

		const [found, byDomain] = await Promise.all([
			listOrganizations(ctx, { kind: null, q: query, ...PAGE }),
			organizationsByDomain(ctx, query)
		]);

		const hits: SearchHit[] = found.items.map((organization) => ({
			kind: 'organization',
			id: organization.id,
			targetId: organization.id,
			title: organization.shortName,
			subtitle: organization.inn === null ? null : `ИНН ${organization.inn}`
		}));
		const seen = new Set(hits.map((hit) => hit.id));

		return [...hits, ...byDomain.filter((hit) => !seen.has(hit.id))].slice(0, SEARCH_GROUP_LIMIT);
	},

	person: async (ctx, query) => {
		if (!can(ctx, 'people.read')) {
			return [];
		}

		const pattern = `%${query}%`;
		// Точная почта — только тому, кому контакты открыты без маски: иначе
		// найденный по адресу человек выдал бы адрес, которого ему не показывают.
		const emailKey = can(ctx, 'people.read_pii') && query.includes('@') ? hashEmail(query) : null;
		const byName = ilike(PERSON_FULL_NAME, pattern);
		const matches = emailKey === null ? byName : or(byName, eq(people.emailHash, emailKey));

		const db = getDb();
		const rows = await db
			.select({ id: people.id, fullName: PERSON_FULL_NAME })
			.from(people)
			// Обезличенный человек имени больше не имеет — находить нечего.
			.where(and(personInScope(ctx), isNull(people.anonymizedAt), matches))
			.orderBy(asc(people.lastName), asc(people.firstName), asc(people.id))
			.limit(SEARCH_GROUP_LIMIT);

		// Организации в подписи — только из области, как в списке людей: имя
		// чужого вуза рядом с человеком — это уже сведения о чужой организации.
		const links =
			rows.length === 0
				? []
				: await db
						.selectDistinct({
							personId: affiliations.personId,
							name: organizations.shortName
						})
						.from(affiliations)
						.innerJoin(organizations, eq(organizations.id, affiliations.organizationId))
						.where(
							and(
								inArray(
									affiliations.personId,
									rows.map((row) => row.id)
								),
								scopeFilter(ctx, affiliations.organizationId)
							)
						)
						.orderBy(asc(organizations.shortName));

		return rows.map((row) => {
			const names = links.filter((link) => link.personId === row.id).map((link) => link.name);

			return {
				kind: 'person',
				id: row.id,
				targetId: row.id,
				title: row.fullName,
				subtitle: names.length === 0 ? null : names.join(', ')
			};
		});
	},

	contract: async (ctx, query) => {
		// Право и область — как у списка договоров (`directory/contracts.ts`):
		// договор — имущество оператора, и видно его по назначениям на вуз.
		if (!can(ctx, 'organizations.read')) {
			return [];
		}

		const rows = await getDb()
			.select({
				id: contracts.id,
				number: contracts.number,
				organizationId: contracts.organizationId,
				organizationName: organizations.shortName
			})
			.from(contracts)
			.innerJoin(organizations, eq(organizations.id, contracts.organizationId))
			.where(and(scopeFilter(ctx, contracts.organizationId), ilike(contracts.number, `%${query}%`)))
			.orderBy(asc(contracts.number), asc(contracts.id))
			.limit(SEARCH_GROUP_LIMIT);

		return rows.map((row) => ({
			kind: 'contract',
			id: row.id,
			targetId: row.organizationId,
			title: `Договор № ${row.number}`,
			subtitle: row.organizationName
		}));
	},

	interaction: async (ctx, query) => {
		if (!can(ctx, 'interactions.read')) {
			return [];
		}

		const found = await listInteractions(ctx, {
			status: null,
			ownerUserId: null,
			organizationId: null,
			workspace: null,
			stageCategory: null,
			overdue: false,
			org: [],
			dir: [],
			prog: [],
			prod: [],
			owner: [],
			sort: '-lastActivityAt',
			q: query,
			...PAGE
		});

		return found.items.map((interaction) => ({
			kind: 'interaction',
			id: interaction.id,
			targetId: interaction.id,
			title: interaction.title,
			subtitle: joined([interaction.institutionName, interaction.stage?.name ?? null])
		}));
	},

	program: async (ctx, query) => {
		if (!can(ctx, 'programs.read')) {
			return [];
		}

		const found = await listPrograms(ctx, { status: null, q: query, ...PAGE });

		return found.items.map((program) => ({
			kind: 'program',
			id: program.id,
			targetId: program.id,
			title: program.name,
			subtitle: program.code
		}));
	},

	product: async (ctx, query) => {
		if (!can(ctx, 'products.read')) {
			return [];
		}

		const found = await listProducts(ctx, { status: null, q: query, ...PAGE });

		return found.items.map((product) => ({
			kind: 'product',
			id: product.id,
			targetId: product.id,
			title: product.name,
			subtitle: product.code
		}));
	}
};

/** Подпись строки из того, что у записи есть; нечего сказать — `null`. */
function joined(parts: readonly (string | null)[]): string | null {
	const known = parts.filter((part): part is string => part !== null && part !== '');

	return known.length === 0 ? null : known.join(' · ');
}

/**
 * Находки по строке запроса. Группы читаются параллельно: каждая ходит в базу
 * сама, и ждать их по очереди значило бы складывать четыре задержки в одну.
 */
export async function search(ctx: ActorContext, query: string): Promise<SearchResult> {
	const groups = await Promise.all(SEARCH_KINDS.map((kind) => READERS[kind](ctx, query)));

	return { items: groups.flat() };
}
