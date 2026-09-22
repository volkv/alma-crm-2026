/**
 * Выдача быстрого поиска.
 *
 * Своих выборок здесь нет ни одной: каждая группа читается тем же читателем,
 * которым живёт её раздел, — вместе с его правом и его областью доступа.
 * Собственный запрос стал бы вторым описанием того, кто что видит, и разошёлся
 * бы с первым на первой же правке правил: организация вне области обязана не
 * находиться, а не находиться и отказывать.
 */
import {
	SEARCH_GROUP_LIMIT,
	SEARCH_KINDS,
	type SearchHit,
	type SearchKind,
	type SearchResult
} from '$lib/search/contract';
import type { ActorContext } from '../actor';
import { listOrganizations, listProducts, listPrograms } from '../directory/read';
import { listInteractions } from '../interactions/read';
import { can } from '../rbac';

/** Страница выдачи: первая и ровно в потолок группы. */
const PAGE = { page: 1, pageSize: SEARCH_GROUP_LIMIT } as const;

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

		const found = await listOrganizations(ctx, { kind: null, q: query, ...PAGE });

		return found.items.map((organization) => ({
			kind: 'organization',
			id: organization.id,
			title: organization.shortName,
			subtitle: organization.inn === null ? null : `ИНН ${organization.inn}`
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
			sort: '-lastActivityAt',
			q: query,
			...PAGE
		});

		return found.items.map((interaction) => ({
			kind: 'interaction',
			id: interaction.id,
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
