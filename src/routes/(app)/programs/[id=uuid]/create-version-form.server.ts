import { redirect, type RequestEvent } from '@sveltejs/kit';
import { fail, message, superValidate } from 'sveltekit-superforms';
import { zod4 } from 'sveltekit-superforms/adapters';
import { resolve } from '$app/paths';
import { wantsCreate } from '$lib/components/create-dialog/open-param';
import { createProgramVersionSchema } from '$lib/contracts/directory';
import { formatIsoDay } from '$lib/format';
import { actorFromEvent, type ActorContext } from '$lib/server/actor';
import { addProgramVersion } from '$lib/server/directory/write';
import { ConflictError, ValidationError } from '$lib/server/errors';
import { toActionFailure } from '$lib/server/http';
import { can } from '$lib/server/rbac';

/**
 * Окно «Новая версия» живёт на карточке программы: отдельной страницы у формы
 * нет. Здесь — то, что окну нужно от сервера, и сама команда добавления.
 */

/** Идентификатор формы: на карточке могут появиться и другие действия. */
const FORM_ID = 'create-program-version';

/** Данные окна. `null` — нет права менять программы, кнопки нет. */
export async function loadCreateVersionForm(
	event: RequestEvent,
	ctx: ActorContext,
	programId: string
) {
	if (!can(ctx, 'programs.write')) {
		return null;
	}

	return {
		// Новая версия чаще всего действует с сегодняшнего дня.
		form: await superValidate(
			{ programId, effectiveFrom: formatIsoDay() },
			zod4(createProgramVersionSchema),
			{ id: FORM_ID, errors: false }
		),
		/** Открыть окно сразу: на него вели ссылкой `?create`. */
		openOnLoad: wantsCreate(event.url)
	};
}

/** Команда добавления: после неё — на ту же карточку, где уже видна новая версия. */
export async function createVersionAction(event: RequestEvent<{ id: string }>) {
	const form = await superValidate(event.request, zod4(createProgramVersionSchema), {
		id: FORM_ID
	});

	if (!form.valid) {
		return fail(400, { form });
	}

	try {
		// Программа берётся из адреса, а не из скрытого поля: версию добавляют
		// той карточке, на которой открыто окно.
		await addProgramVersion(actorFromEvent(event), {
			...form.data,
			programId: event.params.id
		});
	} catch (error) {
		// Нарушенное правило показывается в окне: человек остаётся в
		// заполненной форме, а не получает голый отказ.
		if (error instanceof ConflictError || error instanceof ValidationError) {
			return message(
				form,
				{ text: error.message },
				{ status: error instanceof ConflictError ? 409 : 400 }
			);
		}

		return toActionFailure(error);
	}

	redirect(
		303,
		`${resolve('/(app)/programs/[id=uuid]', { id: event.params.id })}?done=version_created`
	);
}
