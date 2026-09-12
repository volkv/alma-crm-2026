import { readTableQuery } from '$lib/components/data-table/query';
import { programDirectoryQuerySchema } from '$lib/contracts/directory';
import { actorFromEvent } from '$lib/server/actor';
import { listProgramRows } from '$lib/server/directory/read';
import { toPageError } from '$lib/server/http';
import { can } from '$lib/server/rbac';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const table = readTableQuery(event.url);
	const query = programDirectoryQuerySchema.parse({
		status: event.url.searchParams.get('status') ?? undefined,
		level: event.url.searchParams.get('level') ?? undefined,
		q: table.search,
		sortBy: table.sortBy ?? undefined,
		sortDirection: table.sortDirection,
		page: table.page,
		pageSize: table.size
	});

	const ctx = actorFromEvent(event);

	try {
		const result = await listProgramRows(ctx, query);

		return {
			rows: result.items,
			total: result.total,
			filtered: query.status !== null || query.level !== null || query.q !== null,
			canWrite: can(ctx, 'programs.write')
		};
	} catch (error) {
		toPageError(error);
	}
};
