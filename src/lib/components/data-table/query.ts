import { resolve } from '$app/paths';
import type { Pathname, ResolvedPathname } from '$app/types';

/**
 * A list view keeps its state in the query string — page, page size, sort and
 * search. That makes a view a link: it can be bookmarked, sent to a colleague
 * and reopened by the back button, and the server can answer it in one request.
 *
 * This module is the only place that knows the parameter names, and both sides
 * use it: the load function reads the query, the table writes it.
 */

export const PAGE_SIZES = [10, 25, 50, 100] as const;
export const DEFAULT_PAGE_SIZE = 25;

export type SortDirection = 'asc' | 'desc';

/** The list state, already parsed and clamped to something usable. */
export type TableQuery = {
	/** 1-based, the way it is written in the URL. */
	page: number;
	size: number;
	/** Column id, or `null` when the server's own order applies. */
	sortBy: string | null;
	sortDirection: SortDirection;
	search: string;
};

/**
 * A query parameter is user input: a hand-edited `page=abc` must not fail the
 * request, it just is not a page number. Anything unusable falls back to the
 * default, which is exactly what the URL without the parameter means.
 */
function readPage(raw: string | null): number {
	const value = Number.parseInt(raw ?? '', 10);

	return Number.isInteger(value) && value >= 1 ? value : 1;
}

function readSize(raw: string | null): number {
	const value = Number.parseInt(raw ?? '', 10);

	return PAGE_SIZES.includes(value as (typeof PAGE_SIZES)[number]) ? value : DEFAULT_PAGE_SIZE;
}

/** Reads the list state out of a URL. Safe on the server and in the browser. */
export function readTableQuery(url: URL): TableQuery {
	const raw = url.searchParams.get('sort') ?? '';
	const descending = raw.startsWith('-');
	const sortBy = (descending ? raw.slice(1) : raw) || null;

	return {
		page: readPage(url.searchParams.get('page')),
		size: readSize(url.searchParams.get('size')),
		sortBy,
		sortDirection: descending ? 'desc' : 'asc',
		search: url.searchParams.get('q')?.trim() ?? ''
	};
}

function apply(params: URLSearchParams, key: string, value: string | null) {
	if (value === null) {
		params.delete(key);
	} else {
		params.set(key, value);
	}
}

/**
 * The link to the same page with part of the list state changed. Parameters at
 * their default value are left out, so the first page of a list is a clean URL
 * and two ways of reaching the same view produce the same link. Parameters the
 * page owns (a filter of its own) are carried over untouched.
 */
export function tableHref(url: URL, changes: Partial<TableQuery>): ResolvedPathname {
	const next = { ...readTableQuery(url), ...changes };
	const params = new URLSearchParams(url.searchParams);

	apply(params, 'page', next.page > 1 ? String(next.page) : null);
	apply(params, 'size', next.size === DEFAULT_PAGE_SIZE ? null : String(next.size));
	apply(
		params,
		'sort',
		next.sortBy ? `${next.sortDirection === 'desc' ? '-' : ''}${next.sortBy}` : null
	);
	apply(params, 'q', next.search || null);

	const query = params.toString();
	// `url.pathname` is the page this table is rendered on, so it is a path of
	// this app; `resolve` only prefixes the configured base path.
	const path = url.pathname as Pathname;

	return query ? resolve(`${path}?${query}` as `${Pathname}?${string}`) : resolve(path);
}

/** The slice of a full data set this query asks for. Useful for fixtures. */
export function sliceForQuery<T>(rows: readonly T[], query: TableQuery): T[] {
	const start = (query.page - 1) * query.size;

	return rows.slice(start, start + query.size);
}
