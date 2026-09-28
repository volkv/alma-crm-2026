import { redirect, type RequestEvent } from '@sveltejs/kit';
import { z } from 'zod';
import { fail, message, superValidate } from 'sveltekit-superforms';
import { zod4 } from 'sveltekit-superforms/adapters';
import { resolve } from '$app/paths';
import { wantsCreate } from '$lib/components/create-dialog/open-param';
import { newPersonSchema } from '$lib/contracts/directory';
import { actorFromEvent, type ActorContext } from '$lib/server/actor';
import { createPersonWithBasis } from '$lib/server/directory/write';
import { ConflictError, ValidationError } from '$lib/server/errors';
import { toActionFailure } from '$lib/server/http';
import { can } from '$lib/server/rbac';
import { affiliationCreateHref } from '../organizations/[id=uuid]/create-params';
import { FOR_ORGANIZATION_PARAM } from './create-params';

/**
 * Окно «Добавить контакт» живёт на списке людей: отдельной страницы у формы
 * нет. Здесь — то, что окну нужно от сервера, и сама команда создания.
 */

/** Идентификатор формы: на странице списка могут появиться и другие действия. */
const FORM_ID = 'create-person';

/** Параметр — только идентификатор; видна ли организация, проверит её окно. */
function returnOrganization(url: URL): string | null {
	const parsed = z.uuid().safeParse(url.searchParams.get(FOR_ORGANIZATION_PARAM));

	return parsed.success ? parsed.data : null;
}

/** Данные окна. `null` — заводить людей нельзя, и кнопки нет. */
export async function loadCreatePerson(event: RequestEvent, ctx: ActorContext) {
	if (!can(ctx, 'people.write')) {
		return null;
	}

	const forOrganization = returnOrganization(event.url);

	return {
		form: await superValidate(zod4(newPersonSchema), { id: FORM_ID }),
		/** Заведён из окна контакта организации: после создания — туда, уже с ним. */
		forOrganization,
		/** Открыть окно сразу: пришли по ссылке `?create` с другого экрана. */
		openOnLoad: wantsCreate(event.url) || forOrganization !== null
	};
}

/** Команда создания: после неё — в карточку человека или обратно в форму контакта. */
export async function createPersonAction(event: RequestEvent) {
	const form = await superValidate(event.request, zod4(newPersonSchema), { id: FORM_ID });

	if (!form.valid) {
		return fail(400, { form });
	}

	let created;

	try {
		created = await createPersonWithBasis(actorFromEvent(event), form.data);
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

	// Заведён из окна контакта организации: туда и вернуться, уже с ним.
	const target = returnOrganization(event.url);

	if (target !== null) {
		redirect(303, affiliationCreateHref(target, created.id));
	}

	redirect(303, `${resolve('/(app)/people/[id=uuid]', { id: created.id })}?done=created`);
}
