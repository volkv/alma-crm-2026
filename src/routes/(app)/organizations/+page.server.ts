import { readTableQuery } from '$lib/components/data-table/query';
import { organizationDirectoryQuerySchema } from '$lib/contracts/directory';
import { actorFromEvent } from '$lib/server/actor';
import { listOrganizationRows } from '$lib/server/directory/read';
import { toPageError } from '$lib/server/http';
import { can } from '$lib/server/rbac';
import { createActions, loadCreateForm } from './create-form.server';
import type { Actions, PageServerLoad } from './$types';

/**
 * Список организаций. Страница, сортировка, поиск и оба фильтра живут в
 * строке запроса — значит, отфильтрованный список это ссылка, а сервер отдаёт
 * ровно одну страницу строк и общее их число.
 */
export const load: PageServerLoad = async (event) => {
	const table = readTableQuery(event.url);
	const query = organizationDirectoryQuerySchema.parse({
		kind: event.url.searchParams.get('kind') ?? undefined,
		educationLevel: event.url.searchParams.get('level') ?? undefined,
		q: table.search,
		sortBy: table.sortBy ?? undefined,
		sortDirection: table.sortDirection,
		page: table.page,
		pageSize: table.size
	});

	const ctx = actorFromEvent(event);

	try {
		const [result, create] = await Promise.all([
			listOrganizationRows(ctx, query),
			loadCreateForm(event, ctx)
		]);

		return {
			rows: result.items,
			total: result.total,
			filtered: query.kind.length > 0 || query.educationLevel.length > 0 || query.q !== null,
			canImport: can(ctx, 'directory.import'),
			// Окно «Новая организация»: `null` — заводить нельзя, кнопки нет.
			create
		};
	} catch (error) {
		toPageError(error);
	}
};

/** Отдельной страницы создания нет: её действия — у окна над списком. */
export const actions: Actions = createActions;
