import { actorFromEvent } from '$lib/server/actor';
import { getProduct } from '$lib/server/directory/read';
import { toPageError } from '$lib/server/http';
import { can } from '$lib/server/rbac';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const ctx = actorFromEvent(event);

	try {
		const detail = await getProduct(ctx, event.params.id);

		return { ...detail, canWrite: can(ctx, 'products.write') };
	} catch (error) {
		toPageError(error);
	}
};
