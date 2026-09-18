import { redirect } from '@sveltejs/kit';
import { fail, message, superValidate } from 'sveltekit-superforms';
import { zod4 } from 'sveltekit-superforms/adapters';
import { resolve } from '$app/paths';
import { createDirectionSchema } from '$lib/contracts/directory';
import { actorFromEvent } from '$lib/server/actor';
import { createDirection } from '$lib/server/directory/write';
import { ConflictError, ValidationError } from '$lib/server/errors';
import { toActionFailure, toPageError } from '$lib/server/http';
import { requirePermission } from '$lib/server/rbac';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	try {
		requirePermission(actorFromEvent(event), 'directions.write');
	} catch (error) {
		toPageError(error);
	}

	return { form: await superValidate(zod4(createDirectionSchema)) };
};

export const actions: Actions = {
	default: async (event) => {
		const form = await superValidate(event.request, zod4(createDirectionSchema));

		if (!form.valid) {
			return fail(400, { form });
		}

		let created;

		try {
			created = await createDirection(actorFromEvent(event), form.data);
		} catch (error) {
			if (error instanceof ConflictError || error instanceof ValidationError) {
				return message(
					form,
					{ text: error.message },
					{ status: error instanceof ConflictError ? 409 : 400 }
				);
			}

			return toActionFailure(error);
		}

		redirect(303, `${resolve('/(app)/directions/[id=uuid]', { id: created.id })}?done=created`);
	}
};
