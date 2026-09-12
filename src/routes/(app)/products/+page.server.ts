import { readTableQuery } from '$lib/components/data-table/query';
import { productDirectoryQuerySchema } from '$lib/contracts/directory';
import { actorFromEvent } from '$lib/server/actor';
import { listProductRows } from '$lib/server/directory/read';
import { toPageError } from '$lib/server/http';
import { can } from '$lib/server/rbac';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const table = readTableQuery(event.url);
	const query = productDirectoryQuerySchema.parse({
		status: event.url.searchParams.get('status') ?? undefined,
		q: table.search,
		sortBy: table.sortBy ?? undefined,
		sortDirection: table.sortDirection,
		page: table.page,
		pageSize: table.size
	});

	const ctx = actorFromEvent(event);

	try {
		const result = await listProductRows(ctx, query);

		return {
			rows: result.items,
			total: result.total,
			filtered: query.status !== null || query.q !== null,
			canWrite: can(ctx, 'products.write')
		};
	} catch (error) {
		toPageError(error);
	}
};
