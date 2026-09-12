import { redirect } from '@sveltejs/kit';
import { fail, message, superValidate } from 'sveltekit-superforms';
import { zod4 } from 'sveltekit-superforms/adapters';
import { resolve } from '$app/paths';
import { createAffiliationSchema } from '$lib/contracts/directory';
import { actorFromEvent } from '$lib/server/actor';
import { toPageError } from '$lib/server/directory/page';
import { getOrganization, listPersonOptions, listSites } from '$lib/server/directory/read';
import { createAffiliation } from '$lib/server/directory/write';
import { ConflictError, ValidationError } from '$lib/server/errors';
import { toActionFailure } from '$lib/server/http';
import { requirePermission } from '$lib/server/rbac';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const ctx = actorFromEvent(event);

	try {
		requirePermission(ctx, 'people.write');

		const [organization, sites, people] = await Promise.all([
			getOrganization(ctx, event.params.id),
			listSites(ctx, event.params.id),
			listPersonOptions(ctx)
		]);

		return {
			organization,
			people,
			siteOptions: sites.map((site) => ({ id: site.id, label: site.name })),
			form: await superValidate(
				{
					organizationId: organization.id,
					roleKind: 'coordinator' as const,
					validFrom: new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(
						new Date()
					)
				},
				zod4(createAffiliationSchema),
				{ errors: false }
			)
		};
	} catch (error) {
		toPageError(error);
	}
};

export const actions: Actions = {
	default: async (event) => {
		const form = await superValidate(event.request, zod4(createAffiliationSchema));

		if (!form.valid) {
			return fail(400, { form });
		}

		try {
			await createAffiliation(actorFromEvent(event), {
				...form.data,
				organizationId: event.params.id
			});
		} catch (error) {
			if (error instanceof ConflictError || error instanceof ValidationError) {
				return message(
					form,
					{ text: error.message },
					{
						status: error instanceof ConflictError ? 409 : 400
					}
				);
			}

			return toActionFailure(error);
		}

		redirect(
			303,
			`${resolve('/(app)/organizations/[id]', { id: event.params.id })}?done=affiliation_created`
		);
	}
};
