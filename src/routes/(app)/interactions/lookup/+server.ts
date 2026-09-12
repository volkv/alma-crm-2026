import { json } from '@sveltejs/kit';
import { actorFromEvent } from '$lib/server/actor';
import { listAffiliations, listSites, lookupOrganizations } from '$lib/server/directory/read';
import { AppError } from '$lib/server/errors';
import type { RequestHandler } from './$types';

/**
 * Подсказки для формы взаимодействия: организации по поиску, их площадки и
 * контактные лица.
 *
 * Маршрут лежит внутри оболочки приложения, а не в `/api`: это подсказка для
 * страницы, она ходит с сессией и правами того, кто заполняет форму. Публичный
 * API живёт отдельно и представляется ключом.
 */
export const GET: RequestHandler = async (event) => {
	const ctx = actorFromEvent(event);
	const kind = event.url.searchParams.get('kind');
	const organizationId = event.url.searchParams.get('organizationId');

	try {
		if (kind === 'organizations') {
			return json({ items: await lookupOrganizations(ctx, event.url.searchParams.get('q')) });
		}

		if (organizationId === null) {
			return json({ error: 'Не указана организация' }, { status: 400 });
		}

		if (kind === 'sites') {
			const sites = await listSites(ctx, organizationId);

			return json({ items: sites.map((site) => ({ id: site.id, label: site.name })) });
		}

		if (kind === 'contacts') {
			const affiliations = await listAffiliations(ctx, organizationId);

			return json({
				items: affiliations.map((affiliation) => ({
					id: affiliation.id,
					label: `${affiliation.person.lastName} ${affiliation.person.firstName} — ${affiliation.position}`
				}))
			});
		}

		return json({ error: 'Неизвестный вид подсказки' }, { status: 400 });
	} catch (error) {
		// Предметную ошибку переводит транспорт; всё остальное — это сбой, и
		// подменять его вежливым ответом нельзя.
		if (error instanceof AppError) {
			return json({ error: error.message }, { status: error.code === 'forbidden' ? 403 : 400 });
		}

		throw error;
	}
};
