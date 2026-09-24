import {
	columnVisibilityFeature,
	metaHelper,
	rowPaginationFeature,
	rowSelectionFeature,
	rowSortingFeature,
	tableFeatures
} from '@tanstack/svelte-table';

/** What a column declares about itself beyond how to read its value. */
export type DataTableColumnMeta = {
	/** `end` right-aligns the whole column; use it for anything numeric. */
	align?: 'start' | 'end';
	/** Name for the column-visibility menu, when the header is not plain text. */
	title?: string;
	/**
	 * In a stacked list (`stacked` on the table, below 640 px) the cell shares
	 * a line with its inline neighbours instead of taking one of its own —
	 * for short values such as a stage or a deadline.
	 */
	stackInline?: boolean;
};

/**
 * The behaviour the product table has, and nothing else: TanStack v9 drops
 * every feature that is not listed here, so this is also the bundle budget.
 *
 * Deliberately absent are the row models for sorting, filtering and pagination:
 * the table shows a page the server has already sorted and sliced, so it only
 * keeps the state (which column, which page) and never reorders rows itself.
 */
export const features = tableFeatures({
	rowSortingFeature,
	rowPaginationFeature,
	rowSelectionFeature,
	columnVisibilityFeature,
	columnMeta: metaHelper<DataTableColumnMeta>()
});

export type DataTableFeatures = typeof features;
