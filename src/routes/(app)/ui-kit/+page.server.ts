import { fail, message, superValidate } from 'sveltekit-superforms';
import { zod4 } from 'sveltekit-superforms/adapters';
import { readTableQuery, sliceForQuery, type TableQuery } from '$lib/components/data-table/query';
import { showcaseOrganizationSchema } from './schema';
import { SHOWCASE_ORGANIZATIONS, type ShowcaseOrganization } from './showcase-data';
import type { Actions, PageServerLoad } from './$types';

/**
 * The kit page answers its own list the way a real section will: the query
 * string says what to show, the server filters, sorts and slices, and the table
 * receives one page plus the total. Only the data source differs — an array in
 * this module instead of the database.
 */

const comparators: Record<string, (a: ShowcaseOrganization, b: ShowcaseOrganization) => number> = {
	name: (a, b) => a.name.localeCompare(b.name, 'ru'),
	shortName: (a, b) => a.shortName.localeCompare(b.shortName, 'ru'),
	region: (a, b) => a.region.localeCompare(b.region, 'ru'),
	kind: (a, b) => a.kind.localeCompare(b.kind, 'ru'),
	contacts: (a, b) => a.contacts - b.contacts,
	updatedAt: (a, b) => a.updatedAt.localeCompare(b.updatedAt)
};

function select(query: TableQuery): { rows: ShowcaseOrganization[]; total: number } {
	const needle = query.search.toLocaleLowerCase('ru');
	const matched = needle
		? SHOWCASE_ORGANIZATIONS.filter((organization) =>
				[organization.name, organization.shortName, organization.region].some((field) =>
					field.toLocaleLowerCase('ru').includes(needle)
				)
			)
		: [...SHOWCASE_ORGANIZATIONS];

	const comparator = query.sortBy ? comparators[query.sortBy] : undefined;
	if (comparator) {
		matched.sort((a, b) => (query.sortDirection === 'desc' ? -comparator(a, b) : comparator(a, b)));
	}

	return { rows: sliceForQuery(matched, query), total: matched.length };
}

export const load: PageServerLoad = async ({ url }) => {
	const query = readTableQuery(url);

	return {
		...select(query),
		form: await superValidate(zod4(showcaseOrganizationSchema))
	};
};

export const actions: Actions = {
	default: async ({ request }) => {
		const form = await superValidate(request, zod4(showcaseOrganizationSchema));

		if (!form.valid) {
			return fail(400, { form });
		}

		// Nothing is stored: the kit page demonstrates the round trip, and the
		// section that owns organisations will do the writing.
		return message(form, `Форма принята: ${form.data.name}`);
	}
};
