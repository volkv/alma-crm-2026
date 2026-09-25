import { redirect } from '@sveltejs/kit';
import { fail, message, superValidate } from 'sveltekit-superforms';
import { zod4 } from 'sveltekit-superforms/adapters';
import { resolve } from '$app/paths';
import { createOrganizationSchema } from '$lib/contracts/directory';
import { actorFromEvent } from '$lib/server/actor';
import { passportAvailability } from '$lib/server/enrichment/access';
import { resolveAcceptance } from '$lib/server/enrichment/passports';
import { findOrganizationByInn } from '$lib/server/directory/read';
import { createOrganization } from '$lib/server/directory/write';
import { ConflictError, ValidationError } from '$lib/server/errors';
import { toActionFailure, toPageError } from '$lib/server/http';
import { requirePermission } from '$lib/server/rbac';
import { passportActions, readAcceptance } from '../passport/actions.server';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const ctx = actorFromEvent(event);

	try {
		requirePermission(ctx, 'organizations.write');
	} catch (error) {
		toPageError(error);
	}

	// Самый частый случай — вуз, поэтому форма открывается уже настроенной на него.
	return {
		form: await superValidate(
			{ kind: 'educational_institution' as const, educationLevel: 'vo' as const },
			zod4(createOrganizationSchema),
			{ errors: false }
		),
		passport: await passportAvailability(ctx),
		// Вендора заводит только полный доступ (`createOrganization` откажет и так).
		allowVendor: ctx.scope.kind === 'all'
	};
};

export const actions: Actions = {
	...passportActions,

	/**
	 * Сохранение карточки. Вместе с реквизитами форма присылает отметки полей,
	 * принятых из паспорта: их происхождение сверяется с выданным паспортом и
	 * ложится в журнал той же транзакцией, что и сами поля.
	 */
	save: async (event) => {
		const formData = await event.request.formData();
		const form = await superValidate(formData, zod4(createOrganizationSchema));

		if (!form.valid) {
			return fail(400, { form });
		}

		const ctx = actorFromEvent(event);
		let created;

		try {
			const provenance = await resolveAcceptance(ctx, readAcceptance(formData), form.data);

			created = await createOrganization(ctx, form.data, undefined, provenance);
		} catch (error) {
			if (error instanceof ConflictError) {
				// Дубль уже найден — покажем, на какой организации споткнулись, вместо
				// того чтобы отправлять человека искать её поиском.
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

		redirect(303, `${resolve('/(app)/organizations/[id=uuid]', { id: created.id })}?done=created`);
	}
};
