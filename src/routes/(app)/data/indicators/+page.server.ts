import { readTableQuery } from '$lib/components/data-table/query';
import { parseStatPeriodKey, statIndicatorQuerySchema } from '$lib/contracts/stats';
import { actorFromEvent } from '$lib/server/actor';
import { toPageError } from '$lib/server/http';
import { listIndicatorFilters, listIndicators, listPeriods } from '$lib/server/stats/read';
import type { PageServerLoad } from './$types';

/**
 * Показатели по подтверждённым снимкам. Рейтинг программ живёт отдельно
 * (`/data/ranking`): он считается по фактам системы, а не по снимкам.
 *
 * Период и фильтры живут в адресе: «заявки по этой программе за
 * 2025/2026» — это ссылка, которую посылают коллеге, а не состояние экрана.
 * Периоды между собой не складываются, поэтому без выбранного периода строки
 * приходят как есть, по одной на период.
 */
export const load: PageServerLoad = async (event) => {
	const ctx = actorFromEvent(event);
	const table = readTableQuery(event.url);
	const period = parseStatPeriodKey(event.url.searchParams.get('period'));

	const query = statIndicatorQuerySchema.parse({
		programId: event.url.searchParams.get('programId') ?? undefined,
		organizationId: event.url.searchParams.get('organizationId') ?? undefined,
		page: table.page,
		pageSize: table.size
	});

	try {
		const [periods, indicators, filters] = await Promise.all([
			listPeriods(ctx),
			listIndicators(ctx, { ...query, period }),
			listIndicatorFilters(ctx)
		]);

		return {
			periods,
			selected: period,
			rows: indicators.items,
			total: indicators.total,
			filters,
			filtered: query.programId !== null || query.organizationId !== null
		};
	} catch (error) {
		toPageError(error);
	}
};
