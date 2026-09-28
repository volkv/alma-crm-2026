import { redirect, type RequestEvent } from '@sveltejs/kit';
import { fail, message, superValidate } from 'sveltekit-superforms';
import { zod4 } from 'sveltekit-superforms/adapters';
import { resolve } from '$app/paths';
import { wantsCreate } from '$lib/components/create-dialog/open-param';
import { createProductSchema } from '$lib/contracts/directory';
import { actorFromEvent, type ActorContext } from '$lib/server/actor';
import { listOrganizationOptions } from '$lib/server/directory/read';
import { createProduct } from '$lib/server/directory/write';
import { ConflictError, ValidationError } from '$lib/server/errors';
import { toActionFailure } from '$lib/server/http';
import { can } from '$lib/server/rbac';

/**
 * Окно «Новый продукт» живёт на странице списка: отдельной страницы у формы
 * нет. Здесь — то, что окну нужно от сервера, и сама команда создания.
 */

/** Идентификатор формы: страница может получить и другие действия. */
const FORM_ID = 'create-product';

/**
 * Данные окна создания. `null` — нет права заводить продукты: кнопки нет, и
 * список правообладателей не выбирается зря.
 */
export async function loadCreateProductForm(event: RequestEvent, ctx: ActorContext) {
	if (!can(ctx, 'products.write')) {
		return null;
	}

	const [form, organizations] = await Promise.all([
		superValidate(zod4(createProductSchema), { id: FORM_ID }),
		listOrganizationOptions(ctx)
	]);

	return {
		form,
		organizations,
		/** Открыть окно сразу: на него вели ссылкой `?create`. */
		openOnLoad: wantsCreate(event.url)
	};
}

/** Команда создания: после неё — сразу в карточку нового продукта. */
export async function createProductAction(event: RequestEvent) {
	const form = await superValidate(event.request, zod4(createProductSchema), { id: FORM_ID });

	if (!form.valid) {
		return fail(400, { form });
	}

	let created;

	try {
		created = await createProduct(actorFromEvent(event), form.data);
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

	redirect(303, `${resolve('/(app)/products/[id=uuid]', { id: created.id })}?done=created`);
}
