import { redirect } from '@sveltejs/kit';
import { fail, message, superValidate } from 'sveltekit-superforms';
import { zod4 } from 'sveltekit-superforms/adapters';
import { resolve } from '$app/paths';
import { createDirectionSchema } from '$lib/contracts/directory';
import { actorFromEvent } from '$lib/server/actor';
import { getDirectionRow } from '$lib/server/directory/read';
import { updateDirection } from '$lib/server/directory/write';
import { ConflictError, ValidationError } from '$lib/server/errors';
import { toActionFailure, toPageError } from '$lib/server/http';
import { requirePermission } from '$lib/server/rbac';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const ctx = actorFromEvent(event);

	try {
		requirePermission(ctx, 'directions.write');
		const direction = await getDirectionRow(ctx, event.params.id);

		return {
			direction,
			form: await superValidate(direction, zod4(createDirectionSchema), { errors: false })
		};
	} catch (error) {
		toPageError(error);
	}
};

export const actions: Actions = {
	default: async (event) => {
		const form = await superValidate(event.request, zod4(createDirectionSchema));

		if (!form.valid) {
			return fail(400, { form });
		}

		try {
			await updateDirection(actorFromEvent(event), { ...form.data, id: event.params.id });
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

		redirect(
			303,
			`${resolve('/(app)/directions/[id=uuid]', { id: event.params.id })}?done=updated`
		);
	}
};
