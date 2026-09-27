import { redirect } from '@sveltejs/kit';
import { z } from 'zod';
import { fail, message, superValidate } from 'sveltekit-superforms';
import { zod4 } from 'sveltekit-superforms/adapters';
import { resolve } from '$app/paths';
import { createPersonSchema } from '$lib/contracts/directory';
import { actorFromEvent } from '$lib/server/actor';
import { createPerson } from '$lib/server/directory/write';
import { ConflictError, ValidationError } from '$lib/server/errors';
import { toActionFailure, toPageError } from '$lib/server/http';
import { requirePermission } from '$lib/server/rbac';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	try {
		requirePermission(actorFromEvent(event), 'people.write');
	} catch (error) {
		toPageError(error);
	}

	return { form: await superValidate(zod4(createPersonSchema)) };
};

export const actions: Actions = {
	default: async (event) => {
		const form = await superValidate(event.request, zod4(createPersonSchema));

		if (!form.valid) {
			return fail(400, { form });
		}

		let created;

		try {
			created = await createPerson(actorFromEvent(event), form.data);
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

		// Заведён из формы контакта организации: туда и вернуться, уже с ним.
		// Параметр — только идентификатор; видна ли организация, проверит та форма.
		const target = z.uuid().safeParse(event.url.searchParams.get('for'));

		if (target.success) {
			redirect(
				303,
				`${resolve('/(app)/organizations/[id=uuid]/affiliations/new', { id: target.data })}?person=${created.id}`
			);
		}

		redirect(303, `${resolve('/(app)/people/[id=uuid]', { id: created.id })}?done=created`);
	}
};
