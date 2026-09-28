import { readTableQuery } from '$lib/components/data-table/query';
import { directionDirectoryQuerySchema } from '$lib/contracts/directory';
import { actorFromEvent } from '$lib/server/actor';
import { listDirectionRows } from '$lib/server/directory/read';
import { toPageError } from '$lib/server/http';
import { can } from '$lib/server/rbac';
import { createDirectionAction, loadCreateDirectionForm } from './create-form.server';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const table = readTableQuery(event.url);
	const query = directionDirectoryQuerySchema.parse({
		state: event.url.searchParams.get('state') ?? undefined,
		q: table.search,
		sortBy: table.sortBy ?? undefined,
		sortDirection: table.sortDirection,
		page: table.page,
		pageSize: table.size
	});

	const ctx = actorFromEvent(event);

	try {
		const [result, create] = await Promise.all([
			listDirectionRows(ctx, query),
			loadCreateDirectionForm(event, ctx)
		]);

		return {
			rows: result.items,
			total: result.total,
			filtered: query.state !== null || query.q !== null,
			canWrite: can(ctx, 'directions.write'),
			/** Окно «Новое направление»; `null` — заводить нельзя. */
			create
		};
	} catch (error) {
		toPageError(error);
	}
};

export const actions: Actions = {
	create: createDirectionAction
};
