import { actorFromEvent } from '$lib/server/actor';
import { toPageError } from '$lib/server/directory/page';
import { getProduct } from '$lib/server/directory/read';
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
