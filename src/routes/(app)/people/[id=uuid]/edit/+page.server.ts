import { redirect } from '@sveltejs/kit';
import { fail, message, superValidate } from 'sveltekit-superforms';
import { zod4 } from 'sveltekit-superforms/adapters';
import { resolve } from '$app/paths';
import { createPersonSchema } from '$lib/contracts/directory';
import { actorFromEvent } from '$lib/server/actor';
import { getPerson } from '$lib/server/directory/read';
import { updatePerson } from '$lib/server/directory/write';
import { ConflictError, ForbiddenError, ValidationError } from '$lib/server/errors';
import { toActionFailure, toPageError } from '$lib/server/http';
import { can, requirePermission } from '$lib/server/rbac';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const ctx = actorFromEvent(event);

	try {
		requirePermission(ctx, 'people.write');

		// Править контакты можно только видя их целиком: иначе сохранение формы
		// записало бы в базу маску «i***@vuz.ru» вместо адреса.
		if (!can(ctx, 'people.read_pii')) {
			throw new ForbiddenError(
				'Изменение человека требует права «Просмотр контактов людей без маскирования»'
			);
		}

		const person = await getPerson(ctx, event.params.id);

		return {
			person,
			form: await superValidate(person, zod4(createPersonSchema), { errors: false })
		};
	} catch (error) {
		toPageError(error);
	}
};

export const actions: Actions = {
	default: async (event) => {
		const form = await superValidate(event.request, zod4(createPersonSchema));

		if (!form.valid) {
			return fail(400, { form });
		}

		try {
			await updatePerson(actorFromEvent(event), { ...form.data, id: event.params.id });
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

		redirect(303, `${resolve('/(app)/people/[id=uuid]', { id: event.params.id })}?done=updated`);
	}
};
