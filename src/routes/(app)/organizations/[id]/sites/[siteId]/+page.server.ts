import { redirect } from '@sveltejs/kit';
import { fail, message, superValidate } from 'sveltekit-superforms';
import { zod4 } from 'sveltekit-superforms/adapters';
import { resolve } from '$app/paths';
import { createSiteSchema } from '$lib/contracts/directory';
import { actorFromEvent } from '$lib/server/actor';
import { toPageError } from '$lib/server/directory/page';
import { getOrganization, getSite } from '$lib/server/directory/read';
import { updateSite } from '$lib/server/directory/write';
import { ConflictError, ValidationError } from '$lib/server/errors';
import { toActionFailure } from '$lib/server/http';
import { requirePermission } from '$lib/server/rbac';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const ctx = actorFromEvent(event);

	try {
		requirePermission(ctx, 'organizations.write');
		const [organization, site] = await Promise.all([
			getOrganization(ctx, event.params.id),
			getSite(ctx, event.params.siteId)
		]);

		return {
			organization,
			site,
			form: await superValidate(site, zod4(createSiteSchema), { errors: false })
		};
	} catch (error) {
		toPageError(error);
	}
};

export const actions: Actions = {
	default: async (event) => {
		const form = await superValidate(event.request, zod4(createSiteSchema));

		if (!form.valid) {
			return fail(400, { form });
		}

		try {
			await updateSite(actorFromEvent(event), {
				...form.data,
				id: event.params.siteId,
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
			`${resolve('/(app)/organizations/[id]', { id: event.params.id })}?done=site_updated`
		);
	}
};
