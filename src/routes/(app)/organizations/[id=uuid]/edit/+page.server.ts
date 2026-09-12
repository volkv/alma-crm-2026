import { redirect } from '@sveltejs/kit';
import { fail, message, superValidate } from 'sveltekit-superforms';
import { zod4 } from 'sveltekit-superforms/adapters';
import { resolve } from '$app/paths';
import { createOrganizationSchema } from '$lib/contracts/directory';
import { actorFromEvent } from '$lib/server/actor';
import { findOrganizationByInn, getOrganization } from '$lib/server/directory/read';
import { updateOrganization } from '$lib/server/directory/write';
import { ConflictError, ValidationError } from '$lib/server/errors';
import { toActionFailure, toPageError } from '$lib/server/http';
import { requirePermission } from '$lib/server/rbac';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const ctx = actorFromEvent(event);

	try {
		requirePermission(ctx, 'organizations.write');
		const organization = await getOrganization(ctx, event.params.id);

		return {
			organization,
			form: await superValidate(organization, zod4(createOrganizationSchema), { errors: false })
		};
	} catch (error) {
		toPageError(error);
	}
};

export const actions: Actions = {
	default: async (event) => {
		const form = await superValidate(event.request, zod4(createOrganizationSchema));

		if (!form.valid) {
			return fail(400, { form });
		}

		const ctx = actorFromEvent(event);

		try {
			// Какую запись правим, говорит адрес, а не скрытое поле формы.
			await updateOrganization(ctx, { ...form.data, id: event.params.id });
		} catch (error) {
			if (error instanceof ConflictError) {
				const existing =
					form.data.inn === null ? null : await findOrganizationByInn(ctx, form.data.inn);

				return message(
					form,
					{
						text: error.message,
						...(existing === null
							? {}
							: {
									conflictsWith: existing,
									conflictHref: resolve('/(app)/organizations/[id=uuid]', { id: existing.id })
								})
					},
					{ status: 409 }
				);
			}

			if (error instanceof ValidationError) {
				return message(form, { text: error.message }, { status: 400 });
			}

			return toActionFailure(error);
		}

		redirect(
			303,
			`${resolve('/(app)/organizations/[id=uuid]', { id: event.params.id })}?done=updated`
		);
	}
};
