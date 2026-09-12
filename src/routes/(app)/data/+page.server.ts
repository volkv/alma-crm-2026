import { readTableQuery } from '$lib/components/data-table/query';
import { statSnapshotListQuerySchema } from '$lib/contracts/stats';
import { actorFromEvent } from '$lib/server/actor';
import { toPageError } from '$lib/server/http';
import { can } from '$lib/server/rbac';
import { listSnapshots } from '$lib/server/stats/read';
import type { PageServerLoad } from './$types';

/**
 * Список снимков данных. Состояние списка живёт в строке запроса, как во всех
 * списках продукта: отфильтрованный список это ссылка.
 */
export const load: PageServerLoad = async (event) => {
	const table = readTableQuery(event.url);
	const query = statSnapshotListQuerySchema.parse({
		status: event.url.searchParams.get('status') ?? undefined,
		source: event.url.searchParams.get('source') ?? undefined,
		q: table.search,
		sortBy: table.sortBy ?? undefined,
		// Раздел открывают ради того, что загрузили последним, а не ради первой
		// строки по алфавиту.
		sortDirection: table.sortBy === null ? 'desc' : table.sortDirection,
		page: table.page,
		pageSize: table.size
	});

	const ctx = actorFromEvent(event);

	try {
		const result = await listSnapshots(ctx, query);

		return {
			rows: result.items,
			total: result.total,
			// Пустой список под фильтром и пустой раздел — разные состояния: в
			// первом случае надо снять фильтр, во втором — загрузить первый файл.
			filtered: query.status !== null || query.source !== null || query.q !== null,
			canImport: can(ctx, 'stats.import')
		};
	} catch (error) {
		toPageError(error);
	}
};
