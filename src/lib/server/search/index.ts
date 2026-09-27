/**
 * Выдача быстрого поиска.
 *
 * Граница доступа у каждой группы — та же, что у её раздела: взаимодействия,
 * программы и продукты читаются самими читателями разделов, вместе с их правом
 * и областью. Там, где читатель раздела не умеет искать нужным способом
 * (человек по ФИО без расшифровки контактов, договор по номеру, организация
 * по домену сайта и с границей карточки), выборка своя, но граница — тем же
 * серверным условием, что у раздела (`personInScope`, `scopeFilter`,
 * `visibleOrganizationFilter`), а не её пересказом: запись вне области обязана
 * не находиться, а не находиться и отказывать.
 */
import { and, asc, desc, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import {
	SEARCH_GROUP_LIMIT,
	SEARCH_KINDS,
	type SearchHit,
	type SearchKind,
	type SearchResult
} from '$lib/search/contract';
import { ORGANIZATION_KIND_LABELS } from '$lib/components/directory/labels';
import type { ActorContext } from '../actor';
import { getDb } from '../db';
import { affiliations, contracts, organizations, people } from '../db/schema';
import { listProducts, listPrograms } from '../directory/read';
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
 * Сайты, которые подходят домену запроса: сам домен и его родители до имени
 * второго уровня. Почта `priem@lk.spbstu.ru` ведёт к сайту `spbstu.ru`, а
 * обратное неверно: почта `ivanov@example.org` не делает «своими» все сайты
 * `*.example.org` — иначе общий домен, как у демонстрационных данных, находил
 * бы разом все организации.
 */
function siteHostsFor(domain: string): string[] {
	const labels = domain.split('.');

	return labels.slice(0, -1).map((_, index) => labels.slice(index).join('.'));
}

/** Узел сайта организации без схемы, `www`, порта и пути — как его сравнивает поиск. */
const WEBSITE_HOST = sql<string>`regexp_replace(
	regexp_replace(lower(${organizations.website}), '^[a-z]+://', ''),
	'^www\.|[:/?#].*$', '', 'g'
)`;

/**
 * Организации по названию, ИНН или домену сайта.
 *
 * Граница — та же, что у карточки (`visibleOrganizationFilter`): поиск ведёт в
 * карточку, и находить нужно ровно то, что откроется, — включая вуз, который
 * виден через своё взаимодействие. Список раздела остаётся уже: он показывает
 * только назначенные вузы.
 */
async function findOrganizations(ctx: ActorContext, query: string): Promise<SearchHit[]> {
	const pattern = `%${query}%`;
	const domain = domainOf(query);
	const byName = sql<boolean>`coalesce(${or(
		ilike(organizations.shortName, pattern),
		ilike(organizations.legalName, pattern),
		ilike(organizations.inn, pattern)
	)}, false)`;
	const matches =
		domain === null ? byName : or(byName, inArray(WEBSITE_HOST, siteHostsFor(domain)));

	const rows = await getDb()
		.select({
			id: organizations.id,
			shortName: organizations.shortName,
			inn: organizations.inn,
			website: organizations.website,
			byName
		})
		.from(organizations)
		.where(and(visibleOrganizationFilter(ctx, organizations.id), matches))
		// Совпадения по названию — выше совпадений по сайту: их и искали.
		.orderBy(desc(byName), asc(organizations.shortName), asc(organizations.id))
		.limit(SEARCH_GROUP_LIMIT);

	return rows.map((row) => ({
		kind: 'organization',
		id: row.id,
		targetId: row.id,
		title: row.shortName,
		subtitle: row.byName ? (row.inn === null ? null : `ИНН ${row.inn}`) : row.website
	}));
}

/**
 * Читатель группы. Право проверяется до выборки, а не отказом изнутри: поиск
 * показывает то, что человеку и так открыто, а про закрытый раздел молчит —
 * отказ на полпути превратил бы одну недоступную группу в пустую палитру.
 */
type GroupReader = (ctx: ActorContext, query: string) => Promise<SearchHit[]>;

const READERS: Record<SearchKind, GroupReader> = {
	organization: async (ctx, query) =>
		can(ctx, 'organizations.read') ? findOrganizations(ctx, query) : [],

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
							name: organizations.shortName,
							kind: organizations.kind,
							position: affiliations.position
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

		// Подпись — где человек работает: должность и организация. Карточка
		// частного клиента носит его же ФИО, и повторять имя подписью незачем —
		// о нём достаточно сказать, что это физическое лицо.
		return rows.map((row) => {
			const roles = links
				.filter((link) => link.personId === row.id)
				.map((link) =>
					link.kind === 'individual'
						? ORGANIZATION_KIND_LABELS.individual
						: `${link.position}, ${link.name}`
				);

			return {
				kind: 'person',
				id: row.id,
				targetId: row.id,
				title: row.fullName,
				subtitle: roles.length === 0 ? null : [...new Set(roles)].join('; ')
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
			state: null,
			day: null,
			closedWithin: null,
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
