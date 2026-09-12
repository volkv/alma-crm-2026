import { actorFromEvent } from '$lib/server/actor';
import { getProgram } from '$lib/server/directory/read';
import { toPageError } from '$lib/server/http';
import { can } from '$lib/server/rbac';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const ctx = actorFromEvent(event);

	try {
		const detail = await getProgram(ctx, event.params.id);

		return { ...detail, canWrite: can(ctx, 'programs.write') };
	} catch (error) {
		toPageError(error);
	}
};
