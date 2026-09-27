import { redirect } from '@sveltejs/kit';
import { fail, message, superValidate } from 'sveltekit-superforms';
import { zod4 } from 'sveltekit-superforms/adapters';
import { resolve } from '$app/paths';
import { createAffiliationSchema } from '$lib/contracts/directory';
import { actorFromEvent } from '$lib/server/actor';
import { getPerson, listPersonAffiliations } from '$lib/server/directory/read';
import { updateAffiliation } from '$lib/server/directory/write';
import { ConflictError, NotFoundError, ValidationError } from '$lib/server/errors';
import { toActionFailure, toPageError } from '$lib/server/http';
import { requirePermission } from '$lib/server/rbac';
import type { Actions, PageServerLoad } from './$types';

/**
 * Правка роли с карточки человека. Поля те же, что при заведении, но человек и
 * организация уже заданы: форма их только несёт, а сервис не меняет. Роль
 * ищется среди ролей этого человека — чужая по подставленному адресу не
 * откроется.
 */
export const load: PageServerLoad = async (event) => {
	const ctx = actorFromEvent(event);

	try {
		requirePermission(ctx, 'people.write');

		const [person, affiliations] = await Promise.all([
			getPerson(ctx, event.params.id),
			listPersonAffiliations(ctx, event.params.id)
		]);
		const row = affiliations.find((item) => item.affiliation.id === event.params.affiliationId);

		if (row === undefined) {
			throw new NotFoundError('Роль не найдена');
		}

		const { affiliation } = row;

		return {
			person,
			organization: row.organization,
			form: await superValidate(
				{
					personId: person.id,
					organizationId: affiliation.organizationId,
					siteId: affiliation.siteId,
					position: affiliation.position,
					roleKind: affiliation.roleKind,
					isPrimary: affiliation.isPrimary,
					validFrom: affiliation.validFrom,
					validTo: affiliation.validTo,
					channel: affiliation.channel
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
			await updateAffiliation(actorFromEvent(event), {
				id: event.params.affiliationId,
				position: form.data.position,
				roleKind: form.data.roleKind,
				isPrimary: form.data.isPrimary,
				validFrom: form.data.validFrom,
				validTo: form.data.validTo,
				channel: form.data.channel
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
			`${resolve('/(app)/people/[id=uuid]', { id: event.params.id })}?done=affiliation_updated`
		);
	}
};
