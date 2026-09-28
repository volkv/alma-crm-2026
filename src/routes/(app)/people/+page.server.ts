import { readTableQuery } from '$lib/components/data-table/query';
import { peopleListQuerySchema } from '$lib/contracts/directory';
import { actorFromEvent } from '$lib/server/actor';
import { listOrganizationOptions, listPeople } from '$lib/server/directory/read';
import { toPageError } from '$lib/server/http';
import { can } from '$lib/server/rbac';
import { createPersonAction, loadCreatePerson } from './create-person.server';
import type { Actions, PageServerLoad } from './$types';

/**
 * Список людей. Поиск идёт и по ФИО, и по названию организации: человека чаще
 * ищут «кто у нас в этом вузе», чем по фамилии, которую надо ещё вспомнить.
 */
export const load: PageServerLoad = async (event) => {
	const table = readTableQuery(event.url);
	const query = peopleListQuerySchema.parse({
		organizationId: event.url.searchParams.get('organization') ?? undefined,
		retention: event.url.searchParams.get('retention') ?? undefined,
		q: table.search,
		sortBy: table.sortBy ?? undefined,
		sortDirection: table.sortDirection,
		page: table.page,
		pageSize: table.size
	});

	const ctx = actorFromEvent(event);

	try {
		const [result, organizations, createPerson] = await Promise.all([
			listPeople(ctx, query),
			listOrganizationOptions(ctx),
			loadCreatePerson(event, ctx)
		]);

		return {
			rows: result.items,
			total: result.total,
			organizations,
			filtered: query.organizationId !== null || query.retention !== null || query.q !== null,
			// Фильтр по сроку хранения показывают тому, кто за этот срок отвечает.
			managesPii: can(ctx, 'people.manage_consents'),
			/** Окно «Добавить контакт»; `null` — заводить людей нельзя. */
			createPerson
		};
	} catch (error) {
		toPageError(error);
	}
};

export const actions: Actions = {
	createPerson: createPersonAction
};
