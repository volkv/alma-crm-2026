import { redirect } from '@sveltejs/kit';
import { fail, message, superValidate } from 'sveltekit-superforms';
import { zod4 } from 'sveltekit-superforms/adapters';
import { resolve } from '$app/paths';
import { createProductSchema } from '$lib/contracts/directory';
import { actorFromEvent } from '$lib/server/actor';
import { toPageError } from '$lib/server/directory/page';
import { listOrganizationOptions } from '$lib/server/directory/read';
import { createProduct } from '$lib/server/directory/write';
import { ConflictError, ValidationError } from '$lib/server/errors';
import { toActionFailure } from '$lib/server/http';
import { requirePermission } from '$lib/server/rbac';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const ctx = actorFromEvent(event);

	try {
		requirePermission(ctx, 'products.write');

		return {
			organizations: await listOrganizationOptions(ctx),
			form: await superValidate(zod4(createProductSchema))
		};
	} catch (error) {
		toPageError(error);
	}
};

export const actions: Actions = {
	default: async (event) => {
		const form = await superValidate(event.request, zod4(createProductSchema));

		if (!form.valid) {
			return fail(400, { form });
		}

		let created;

		try {
			created = await createProduct(actorFromEvent(event), form.data);
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

		redirect(303, `${resolve('/(app)/products/[id]', { id: created.id })}?done=created`);
	}
};
