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
import { listWorkspacesForWork } from '$lib/server/stages/process';
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

	const [workspaces, programs, products, users, form] = await Promise.all([
		// Пространства читаются не ради выбора: процесс выводится из вида
		// основной стороны. Форма показывает ими, что произойдёт после
		// сохранения, — и говорит заранее, если в пространстве процесса ещё нет.
		// Право здесь то же, что у самого заведения, а не право настраивать
		// процесс.
		listWorkspacesForWork(ctx),
		listPrograms(ctx, catalogPage),
		listProducts(ctx, catalogPage),
		responsibleOptions(event),
		superValidate(zod4(createInteractionSchema))
	]);

	// Ответственный по умолчанию подставляется сразу: в девяти случаях из десяти
	// это и есть правильный ответ, а менять его можно тут же.
	form.data.ownerUserId = event.locals.user?.id ?? '';

	return {
		form,
		workspaces,
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

		// Прямо в карточку её пространства, а не через прежний адрес: место
		// известно — это то, в котором стоит форма.
		redirect(303, `/w/${encodeURIComponent(event.params.workspace)}/interactions/${createdId}`);
	}
};
