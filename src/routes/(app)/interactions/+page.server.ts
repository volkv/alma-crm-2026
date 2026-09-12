import { fail } from '@sveltejs/kit';
import {
	interactionListQuerySchema,
	setResponsibleSchema,
	type InteractionSort
} from '$lib/contracts/interactions';
import { readTableQuery } from '$lib/components/data-table/query';
import { actorFromEvent } from '$lib/server/actor';
import { toActionFailure } from '$lib/server/http';
import { listInteractions } from '$lib/server/interactions/read';
import { can } from '$lib/server/rbac';
import { setResponsible } from '$lib/server/stages/commands';
import { readFilters } from './filters';
import { responsibleOptions } from './responsible';
import type { Actions, PageServerLoad } from './$types';

/** Колонки, по которым список сортируется на сервере. */
const SORTABLE = new Set(['title', 'dueAt', 'lastActivityAt']);

function toSort(sortBy: string | null, direction: 'asc' | 'desc'): InteractionSort {
	if (sortBy === null || !SORTABLE.has(sortBy)) {
		return '-lastActivityAt';
	}

	return `${direction === 'desc' ? '-' : ''}${sortBy}` as InteractionSort;
}

export const load: PageServerLoad = async (event) => {
	const ctx = actorFromEvent(event);
	const table = readTableQuery(event.url);
	const filters = readFilters(event.url);

	const query = interactionListQuerySchema.parse({
		status: filters.status,
		stageCategory: filters.stageCategory,
		overdue: filters.overdue,
		ownerUserId: filters.mine ? (event.locals.user?.id ?? null) : null,
		sort: toSort(table.sortBy, table.sortDirection),
		q: table.search,
		page: table.page,
		pageSize: table.size
	});

	const [result, users] = await Promise.all([
		listInteractions(ctx, query),
		responsibleOptions(event)
	]);

	return {
		rows: result.items,
		total: result.total,
		filters,
		// Пустой список под фильтром и пустой раздел — разные состояния: в первом
		// случае человеку нужно снять фильтр, во втором — завести первую запись.
		isFiltered:
			table.search !== '' ||
			filters.status !== null ||
			filters.stageCategory !== null ||
			filters.overdue ||
			filters.mine,
		users,
		canAssign: can(ctx, 'interactions.write')
	};
};

export const actions: Actions = {
	assign: async (event) => {
		const data = await event.request.formData();

		const parsed = setResponsibleSchema.safeParse({
			interactionIds: data.getAll('interactionId').map(String),
			userId: data.get('userId')
		});

		if (!parsed.success) {
			return fail(400, {
				message: 'Не удалось назначить ответственного',
				issues: parsed.error.issues.map((issue) => issue.message)
			});
		}

		try {
			return { assigned: await setResponsible(actorFromEvent(event), parsed.data) };
		} catch (error) {
			return toActionFailure(error);
		}
	}
};
