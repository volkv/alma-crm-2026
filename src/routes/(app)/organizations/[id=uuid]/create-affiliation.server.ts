import { redirect, type RequestEvent } from '@sveltejs/kit';
import { z } from 'zod';
import { fail, message, superValidate } from 'sveltekit-superforms';
import { zod4 } from 'sveltekit-superforms/adapters';
import { resolve } from '$app/paths';
import { createAffiliationSchema, type SiteView } from '$lib/contracts/directory';
import { actorFromEvent, type ActorContext } from '$lib/server/actor';
import { listPersonPickerOptions } from '$lib/server/directory/read';
import { createAffiliation } from '$lib/server/directory/write';
import { ConflictError, ValidationError } from '$lib/server/errors';
import { formatIsoDay } from '$lib/format';
import { toActionFailure } from '$lib/server/http';
import { can } from '$lib/server/rbac';
import { CREATE_AFFILIATION, PERSON_PARAM, requestedCreate } from './create-params';

/**
 * Окно «Добавить контакт» живёт на карточке организации: контакт — это роль
 * человека в ней, с площадкой или без.
 */

/** Идентификатор формы: у карточки много других действий. */
const FORM_ID = 'create-organization-affiliation';

/** Данные окна. `null` — назначать роли нельзя, и кнопки нет. */
export async function loadCreateAffiliation(
	event: RequestEvent,
	ctx: ActorContext,
	organizationId: string,
	sites: readonly Pick<SiteView, 'id' | 'name'>[]
) {
	if (!can(ctx, 'people.write')) {
		return null;
	}

	const people = await listPersonPickerOptions(ctx);

	// Человек, только что заведённый из этого окна (`/people?create&for=…`),
	// приходит выбранным. Чужой или несуществующий идентификатор выбора не
	// даёт: подставляется только тот, кто есть в списке.
	const requested = z.uuid().safeParse(event.url.searchParams.get(PERSON_PARAM));
	const personId =
		requested.success && people.some((person) => person.id === requested.data)
			? requested.data
			: undefined;

	return {
		people,
		siteOptions: sites.map((site) => ({ id: site.id, label: site.name })),
		form: await superValidate(
			{
				organizationId,
				personId,
				roleKind: 'coordinator' as const,
				validFrom: formatIsoDay()
			},
			zod4(createAffiliationSchema),
			{ id: FORM_ID, errors: false }
		),
		/** Открыть окно сразу: `?create=affiliation` — с другого экрана или после заведения человека. */
		openOnLoad: requestedCreate(event.url) === CREATE_AFFILIATION
	};
}

/**
 * Команда создания. Окно закрывается переходом на ту же карточку с `?done`:
 * так контакт появляется в списке, а тост говорит, что он добавлен.
 */
export async function createAffiliationAction(event: RequestEvent<{ id: string }>) {
	const form = await superValidate(event.request, zod4(createAffiliationSchema), { id: FORM_ID });

	if (!form.valid) {
		return fail(400, { form });
	}

	try {
		await createAffiliation(actorFromEvent(event), {
			...form.data,
			organizationId: event.params.id
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
		`${resolve('/(app)/organizations/[id=uuid]', { id: event.params.id })}?done=affiliation_created`
	);
}
