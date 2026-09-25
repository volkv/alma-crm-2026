import { actorFromEvent } from '$lib/server/actor';
import { getProduct, listProductContacts } from '$lib/server/directory/read';
import { toPageError } from '$lib/server/http';
import { can } from '$lib/server/rbac';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const ctx = actorFromEvent(event);

	try {
		const detail = await getProduct(ctx, event.params.id);
		// Контакты — люди, и право на них своё: без него блок объясняет, почему
		// пуст, а не делает вид, что контактов нет.
		const contacts = can(ctx, 'people.read')
			? await listProductContacts(ctx, detail.product.id)
			: null;

		return { ...detail, contacts, canWrite: can(ctx, 'products.write') };
	} catch (error) {
		toPageError(error);
	}
};
