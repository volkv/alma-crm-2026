import {
	CATALOG_ROWS_PAGE,
	CATALOG_ROW_ACTIONS,
	type CatalogRowAction
} from '$lib/contracts/directory-import';
import { actorFromEvent } from '$lib/server/actor';
import { getCatalogImport, listCatalogImportRows } from '$lib/server/directory/import';
import { toPageError } from '$lib/server/http';
import { requirePermission } from '$lib/server/rbac';
import type { PageServerLoad } from './$types';

function readAction(url: URL): CatalogRowAction | null {
	const value = url.searchParams.get('action');

	return (CATALOG_ROW_ACTIONS as readonly string[]).includes(value ?? '')
		? (value as CatalogRowAction)
		: null;
}

export const load: PageServerLoad = async (event) => {
	const ctx = actorFromEvent(event);

	const action = readAction(event.url);

	try {
		// Внутри `try`: отказ по правам обязан стать ответом 403, а не пятисотой.
		requirePermission(ctx, 'directory.import');

		const [record, rows] = await Promise.all([
			getCatalogImport(ctx, event.params.id),
			listCatalogImportRows(ctx, event.params.id, {
				action,
				page: 1,
				pageSize: CATALOG_ROWS_PAGE
			})
		]);

		return { record, rows: rows.items, shown: rows.items.length, total: rows.total, action };
	} catch (error) {
		toPageError(error);
	}
};
