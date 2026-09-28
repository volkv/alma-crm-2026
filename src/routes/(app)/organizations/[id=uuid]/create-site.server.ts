import { redirect, type RequestEvent } from '@sveltejs/kit';
import { fail, message, superValidate } from 'sveltekit-superforms';
import { zod4 } from 'sveltekit-superforms/adapters';
import { resolve } from '$app/paths';
import { createSiteSchema } from '$lib/contracts/directory';
import { actorFromEvent, type ActorContext } from '$lib/server/actor';
import { createSite } from '$lib/server/directory/write';
import { ConflictError, ValidationError } from '$lib/server/errors';
import { toActionFailure } from '$lib/server/http';
import { can } from '$lib/server/rbac';
import { CREATE_SITE, requestedCreate } from './create-params';

/** Окно «Добавить площадку» живёт на карточке организации. */

/** Идентификатор формы: у карточки много других действий. */
const FORM_ID = 'create-site';

/** Данные окна. `null` — править организацию нельзя, и кнопки нет. */
export async function loadCreateSite(
	event: RequestEvent,
	ctx: ActorContext,
	organizationId: string
) {
	if (!can(ctx, 'organizations.write')) {
		return null;
	}

	return {
		form: await superValidate({ organizationId, kind: 'campus' as const }, zod4(createSiteSchema), {
			id: FORM_ID,
			errors: false
		}),
		/** Открыть окно сразу: пришли по ссылке `?create=site` с другого экрана. */
		openOnLoad: requestedCreate(event.url) === CREATE_SITE
	};
}

/**
 * Команда создания. Окно закрывается переходом на ту же карточку с `?done`:
 * так площадка появляется в списке, а тост говорит, что она добавлена.
 */
export async function createSiteAction(event: RequestEvent<{ id: string }>) {
	const form = await superValidate(event.request, zod4(createSiteSchema), { id: FORM_ID });

	if (!form.valid) {
		return fail(400, { form });
	}

	try {
		await createSite(actorFromEvent(event), { ...form.data, organizationId: event.params.id });
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
		`${resolve('/(app)/organizations/[id=uuid]', { id: event.params.id })}?done=site_created`
	);
}
