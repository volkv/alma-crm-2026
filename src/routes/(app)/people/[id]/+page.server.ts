import { fail, redirect } from '@sveltejs/kit';
import { resolve } from '$app/paths';
import { endAffiliationSchema } from '$lib/contracts/directory';
import { actorFromEvent } from '$lib/server/actor';
import { toPageError } from '$lib/server/directory/page';
import { getPerson, listPersonAffiliations } from '$lib/server/directory/read';
import { endAffiliation } from '$lib/server/directory/write';
import { toActionFailure } from '$lib/server/http';
import { can } from '$lib/server/rbac';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const ctx = actorFromEvent(event);

	try {
		const [person, affiliations] = await Promise.all([
			getPerson(ctx, event.params.id),
			listPersonAffiliations(ctx, event.params.id)
		]);

		return {
			person,
			affiliations,
			canWrite: can(ctx, 'people.write'),
			// Полномочия закрывают сегодняшним днём по Москве — по нему живёт процесс.
			today: new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(new Date())
		};
	} catch (error) {
		toPageError(error);
	}
};

export const actions: Actions = {
	endAffiliation: async (event) => {
		const parsed = endAffiliationSchema.safeParse(
			Object.fromEntries(await event.request.formData())
		);

		if (!parsed.success) {
			return fail(400, {
				message: 'Полномочия не закрыты',
				issues: parsed.error.issues.map((issue) => issue.message)
			});
		}

		try {
			await endAffiliation(actorFromEvent(event), parsed.data);
		} catch (error) {
			return toActionFailure(error);
		}

		redirect(
			303,
			`${resolve('/(app)/people/[id]', { id: event.params.id })}?done=affiliation_ended`
		);
	}
};
