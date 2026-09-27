import { redirect } from '@sveltejs/kit';
import { personFullName } from '$lib/components/organization-card/model';
import { fail, message, superValidate } from 'sveltekit-superforms';
import { zod4 } from 'sveltekit-superforms/adapters';
import { resolve } from '$app/paths';
import { createOrganizationSchema, isAffiliationCurrent } from '$lib/contracts/directory';
import { addSiteContactSchema, normalizePersonName } from '$lib/contracts/organization-card';
import { formatIsoDay } from '$lib/format';
import { actorFromEvent } from '$lib/server/actor';
import { passportAvailability } from '$lib/server/enrichment/access';
import { resolveAcceptance } from '$lib/server/enrichment/passports';
import { addSiteContact } from '$lib/server/directory/organization-card';
import {
	findOrganizationByInn,
	getOrganization,
	listAffiliations
} from '$lib/server/directory/read';
import { updateOrganization } from '$lib/server/directory/write';
import { ConflictError, ValidationError } from '$lib/server/errors';
import { toActionFailure, toPageError } from '$lib/server/http';
import { can, requirePermission } from '$lib/server/rbac';
import { passportActions, readAcceptance } from '../../passport/actions.server';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const ctx = actorFromEvent(event);

	try {
		requirePermission(ctx, 'organizations.write');
		const organization = await getOrganization(ctx, event.params.id);

		// Физическое лицо ведётся карточкой человека: формы организации у него нет
		// (`ORGANIZATION_FORM_KINDS`), и открытая форма не смогла бы его сохранить.
		if (organization.personId !== null) {
			redirect(303, resolve('/(app)/people/[id=uuid]/edit', { id: organization.personId }));
		}

		const today = formatIsoDay();

		return {
			organization,
			form: await superValidate(organization, zod4(createOrganizationSchema), { errors: false }),
			passport: await passportAvailability(ctx),
			// Сменить вид на вендора может только полный доступ (`updateOrganization`).
			allowVendor: ctx.scope.kind === 'all',
			// Кандидатов с сайта заводит контактами тот, кто вправе заводить людей.
			contacts: can(ctx, 'people.write')
				? {
						savedWebsite: organization.website,
						names: (await listAffiliations(ctx, organization.id))
							.filter((row) => isAffiliationCurrent(row, today))
							.map((row) => normalizePersonName(personFullName(row)))
					}
				: null
		};
	} catch (error) {
		toPageError(error);
	}
};

export const actions: Actions = {
	...passportActions,

	/**
	 * Кандидат из «Сведений» — в контакты, не уходя из формы. Тот же сервис, что
	 * на карточке: данные кандидата сервер берёт из раздела сайта, записанного в
	 * карточке, а форма называет только, кого завести.
	 */
	addSiteContact: async (event) => {
		const parsed = addSiteContactSchema.safeParse(
			Object.fromEntries(await event.request.formData())
		);

		if (!parsed.success) {
			return fail(400, {
				message: parsed.error.issues[0]?.message ?? 'Контакт не добавлен'
			});
		}

		try {
			const added = await addSiteContact(actorFromEvent(event), event.params.id, parsed.data);

			return { addedContact: `${added.person.lastName} ${added.person.firstName}` };
		} catch (error) {
			return toActionFailure(error);
		}
	},

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

		try {
			const provenance = await resolveAcceptance(ctx, readAcceptance(formData), form.data);

			// Какую запись правим, говорит адрес, а не скрытое поле формы.
			await updateOrganization(ctx, { ...form.data, id: event.params.id }, provenance);
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
