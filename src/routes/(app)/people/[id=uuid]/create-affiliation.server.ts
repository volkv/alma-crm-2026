import { redirect, type RequestEvent } from '@sveltejs/kit';
import { fail, message, superValidate } from 'sveltekit-superforms';
import { zod4 } from 'sveltekit-superforms/adapters';
import { resolve } from '$app/paths';
import { wantsCreate } from '$lib/components/create-dialog/open-param';
import { createAffiliationSchema } from '$lib/contracts/directory';
import { actorFromEvent, type ActorContext } from '$lib/server/actor';
import { listOrganizationOptions } from '$lib/server/directory/read';
import { createAffiliation } from '$lib/server/directory/write';
import { ConflictError, ValidationError } from '$lib/server/errors';
import { formatIsoDay } from '$lib/format';
import { toActionFailure } from '$lib/server/http';
import { can } from '$lib/server/rbac';

/**
 * Окно «Добавить роль» живёт на карточке человека. Площадку здесь не
 * спрашивают: она обязана принадлежать выбранной организации, а её список
 * зависит от выбора — роль с площадкой заводят из карточки организации.
 */

/** Идентификатор формы: у карточки есть и другие действия. */
const FORM_ID = 'create-person-affiliation';

/** Данные окна. `null` — назначать роли нельзя, и кнопки нет. */
export async function loadCreateAffiliation(
	event: RequestEvent,
	ctx: ActorContext,
	personId: string
) {
	if (!can(ctx, 'people.write')) {
		return null;
	}

	const [organizations, form] = await Promise.all([
		listOrganizationOptions(ctx),
		superValidate(
			{
				personId,
				roleKind: 'coordinator' as const,
				validFrom: formatIsoDay()
			},
			zod4(createAffiliationSchema),
			{ id: FORM_ID, errors: false }
		)
	]);

	return {
		form,
		organizations,
		/** Открыть окно сразу: пришли по ссылке `?create` с другого экрана. */
		openOnLoad: wantsCreate(event.url)
	};
}

/**
 * Команда создания. Окно закрывается переходом на ту же карточку с `?done`:
 * так роль появляется в таблице, а тост говорит, что она добавлена.
 */
export async function createAffiliationAction(event: RequestEvent<{ id: string }>) {
	const form = await superValidate(event.request, zod4(createAffiliationSchema), { id: FORM_ID });

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
