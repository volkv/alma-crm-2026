import { redirect, type RequestEvent } from '@sveltejs/kit';
import { fail, message, superValidate } from 'sveltekit-superforms';
import { zod4 } from 'sveltekit-superforms/adapters';
import { resolve } from '$app/paths';
import { wantsCreate } from '$lib/components/create-dialog/open-param';
import { createDirectionSchema } from '$lib/contracts/directory';
import { actorFromEvent, type ActorContext } from '$lib/server/actor';
import { createDirection } from '$lib/server/directory/write';
import { ConflictError, ValidationError } from '$lib/server/errors';
import { toActionFailure } from '$lib/server/http';
import { can } from '$lib/server/rbac';

/**
 * Окно «Новое направление» живёт на странице списка: отдельной страницы у
 * формы нет. Здесь — то, что окну нужно от сервера, и сама команда создания.
 */

/** Идентификатор формы: страница может получить и другие действия. */
const FORM_ID = 'create-direction';

/** Данные окна создания. `null` — нет права заводить направления, кнопки нет. */
export async function loadCreateDirectionForm(event: RequestEvent, ctx: ActorContext) {
	if (!can(ctx, 'directions.write')) {
		return null;
	}

	return {
		form: await superValidate(zod4(createDirectionSchema), { id: FORM_ID }),
		/** Открыть окно сразу: на него вели ссылкой `?create`. */
		openOnLoad: wantsCreate(event.url)
	};
}

/** Команда создания: после неё — сразу в карточку нового направления. */
export async function createDirectionAction(event: RequestEvent) {
	const form = await superValidate(event.request, zod4(createDirectionSchema), { id: FORM_ID });

	if (!form.valid) {
		return fail(400, { form });
	}

	let created;

	try {
		created = await createDirection(actorFromEvent(event), form.data);
	} catch (error) {
		// Занятый код и нарушенное правило показываются в окне: человек остаётся
		// в заполненной форме, а не получает голый отказ.
		if (error instanceof ConflictError || error instanceof ValidationError) {
			return message(
				form,
				{ text: error.message },
				{ status: error instanceof ConflictError ? 409 : 400 }
			);
		}

		return toActionFailure(error);
	}

	redirect(303, `${resolve('/(app)/directions/[id=uuid]', { id: created.id })}?done=created`);
}
