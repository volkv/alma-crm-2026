import { redirect } from '@sveltejs/kit';
import { fail, message, superValidate } from 'sveltekit-superforms';
import { zod4 } from 'sveltekit-superforms/adapters';
import { resolve } from '$app/paths';
import { createAffiliationSchema } from '$lib/contracts/directory';
import { actorFromEvent } from '$lib/server/actor';
import { getPerson, listOrganizationOptions } from '$lib/server/directory/read';
import { createAffiliation } from '$lib/server/directory/write';
import { ConflictError, ValidationError } from '$lib/server/errors';
import { formatIsoDay } from '$lib/format';
import { toActionFailure, toPageError } from '$lib/server/http';
import { requirePermission } from '$lib/server/rbac';
import type { Actions, PageServerLoad } from './$types';

/**
 * Роль, добавляемая из карточки человека. Площадку здесь не спрашивают: она
 * обязана принадлежать выбранной организации, а её список зависит от выбора —
 * роль с площадкой заводят из карточки организации.
 */
export const load: PageServerLoad = async (event) => {
	const ctx = actorFromEvent(event);

	try {
		requirePermission(ctx, 'people.write');

		const [person, organizations] = await Promise.all([
			getPerson(ctx, event.params.id),
			listOrganizationOptions(ctx)
		]);

		return {
			person,
			organizations,
			form: await superValidate(
				{
					personId: person.id,
					roleKind: 'coordinator' as const,
					validFrom: formatIsoDay()
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
				personId: event.params.id,
				siteId: null
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
			`${resolve('/(app)/people/[id=uuid]', { id: event.params.id })}?done=affiliation_created`
		);
	}
};
