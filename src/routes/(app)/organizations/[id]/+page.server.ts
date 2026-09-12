import { fail, redirect } from '@sveltejs/kit';
import { resolve } from '$app/paths';
import { endAffiliationSchema } from '$lib/contracts/directory';
import { actorFromEvent } from '$lib/server/actor';
import { toPageError } from '$lib/server/directory/page';
import {
	countOrganizationInteractions,
	getOrganization,
	listAffiliations,
	listSites
} from '$lib/server/directory/read';
import { archiveOrganization, endAffiliation } from '$lib/server/directory/write';
import { toActionFailure } from '$lib/server/http';
import { can } from '$lib/server/rbac';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const ctx = actorFromEvent(event);

	try {
		const organization = await getOrganization(ctx, event.params.id);

		// Контакты — отдельное право: организацию видно и без права на людей.
		const [sites, affiliations, interactionCount] = await Promise.all([
			listSites(ctx, organization.id),
			can(ctx, 'people.read') ? listAffiliations(ctx, organization.id) : Promise.resolve([]),
			countOrganizationInteractions(ctx, organization.id)
		]);

		return {
			organization,
			sites,
			affiliations,
			interactionCount,
			// Полномочия закрывают сегодняшним днём по Москве — по нему живёт процесс.
			today: new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(new Date()),
			canReadPeople: can(ctx, 'people.read'),
			canWrite: can(ctx, 'organizations.write'),
			canWritePeople: can(ctx, 'people.write')
		};
	} catch (error) {
		toPageError(error);
	}
};

export const actions: Actions = {
	archive: async (event) => {
		try {
			await archiveOrganization(actorFromEvent(event), event.params.id);
		} catch (error) {
			return toActionFailure(error);
		}

		redirect(303, `${resolve('/(app)/organizations')}?done=archived`);
	},

	endAffiliation: async (event) => {
		const parsed = endAffiliationSchema.safeParse(
			Object.fromEntries(await event.request.formData())
		);

		if (!parsed.success) {
			return fail(400, {
				message: 'Полномочия не закрыты',
				issues: parsed.error.issues.map((issue) => issue.message)
			});
		}

		try {
			await endAffiliation(actorFromEvent(event), parsed.data);
		} catch (error) {
			return toActionFailure(error);
		}

		redirect(
			303,
			`${resolve('/(app)/organizations/[id]', { id: event.params.id })}?done=affiliation_ended`
		);
	}
};
