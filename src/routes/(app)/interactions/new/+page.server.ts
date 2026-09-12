import { redirect } from '@sveltejs/kit';
import { fail, message, superValidate } from 'sveltekit-superforms';
import { zod4 } from 'sveltekit-superforms/adapters';
import { catalogListQuerySchema } from '$lib/contracts/directory';
import { createInteractionSchema } from '$lib/contracts/interactions';
import { actorFromEvent } from '$lib/server/actor';
import { listProducts, listPrograms } from '$lib/server/directory/read';
import { toActionFailure, toPageError } from '$lib/server/http';
import { createInteraction } from '$lib/server/interactions/write';
import { requirePermission } from '$lib/server/rbac';
import { getDefaultRoute } from '$lib/server/stages/routes';
import { responsibleOptions } from '../responsible';
import type { Actions, PageServerLoad } from './$types';

const catalogPage = catalogListQuerySchema.parse({ status: 'active', pageSize: 100 });

export const load: PageServerLoad = async (event) => {
	const ctx = actorFromEvent(event);

	// Форма заведения открывается только с правом на запись: без него страница
	// показала бы заполняемые поля и отказала бы в самом конце — как и у
	// остальных «new», отказ здесь, а не после работы.
	try {
		requirePermission(ctx, 'interactions.write');
	} catch (cause) {
		toPageError(cause);
	}

	const [route, programs, products, users, form] = await Promise.all([
		getDefaultRoute(ctx),
		listPrograms(ctx, catalogPage),
		listProducts(ctx, catalogPage),
		responsibleOptions(event),
		superValidate(zod4(createInteractionSchema))
	]);

	// Маршрут и ответственный по умолчанию подставляются сразу: в девяти случаях
	// из десяти это и есть правильный ответ, а менять их можно тут же.
	form.data.routeId = route.id;
	form.data.ownerUserId = event.locals.user?.id ?? '';

	return {
		form,
		route: { id: route.id, name: route.name, stages: route.stages.length },
		programs: programs.items,
		products: products.items,
		users
	};
};

export const actions: Actions = {
	default: async (event) => {
		// Стороны и программы приезжают вложенными списками, поэтому форма
		// отправляется одним JSON, а не парами «поле — значение».
		const form = await superValidate(event.request, zod4(createInteractionSchema));

		if (!form.valid) {
			return fail(400, { form });
		}

		let createdId: string;

		try {
			const created = await createInteraction(actorFromEvent(event), form.data);
			createdId = created.id;
		} catch (error) {
			// Соответствие предметной ошибки и кода ответа живёт в одном месте;
			// здесь оно только переносится в сообщение формы, чтобы человек остался
			// на заполненной странице, а не получил голый отказ.
			const failure = toActionFailure(error);

			return message(form, failure.data.message, {
				status: failure.status as 400 | 403 | 404 | 409
			});
		}

		redirect(303, `/interactions/${createdId}`);
	}
};
