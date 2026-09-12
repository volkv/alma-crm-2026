import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { id } from '$lib/contracts/common';
import { actorFromEvent } from '$lib/server/actor';
import { listAffiliations, listSites, lookupOrganizations } from '$lib/server/directory/read';
import { AppError, statusForError } from '$lib/server/errors';
import type { RequestHandler } from './$types';

/**
 * Подсказки для формы взаимодействия: организации по поиску, их площадки и
 * контактные лица.
 *
 * Маршрут лежит внутри оболочки приложения, а не в `/api`: это подсказка для
 * страницы, она ходит с сессией и правами того, кто заполняет форму. Публичный
 * API живёт отдельно и представляется ключом.
 */

/**
 * Вид подсказки и, если он требует организации, её идентификатор. Проверяется
 * схемой, а не «строка непустая»: `organizationId` уходит в условие выборки, и
 * `?organizationId=abc` без проверки доезжал бы до PostgreSQL, где `abc` не
 * разбирается как `uuid`, — то есть отвечал бы пятисотой на кривой запрос.
 */
const lookupQuerySchema = z.discriminatedUnion(
	'kind',
	[
		z.object({ kind: z.literal('organizations') }),
		z.object({
			kind: z.enum(['sites', 'contacts']),
			organizationId: id('Не указана организация или её идентификатор некорректен')
		})
	],
	{ error: 'Неизвестный вид подсказки' }
);

export const GET: RequestHandler = async (event) => {
	const ctx = actorFromEvent(event);

	const query = lookupQuerySchema.safeParse({
		kind: event.url.searchParams.get('kind'),
		organizationId: event.url.searchParams.get('organizationId') ?? undefined
	});

	if (!query.success) {
		return json(
			{ error: query.error.issues.map((issue) => issue.message).join('. ') },
			{ status: 400 }
		);
	}

	try {
		if (query.data.kind === 'organizations') {
			return json({ items: await lookupOrganizations(ctx, event.url.searchParams.get('q')) });
		}

		if (query.data.kind === 'sites') {
			const sites = await listSites(ctx, query.data.organizationId);

			return json({ items: sites.map((site) => ({ id: site.id, label: site.name })) });
		}

		const affiliations = await listAffiliations(ctx, query.data.organizationId);

		return json({
			items: affiliations.map((affiliation) => ({
				id: affiliation.id,
				label: `${affiliation.person.lastName} ${affiliation.person.firstName} — ${affiliation.position}`
			}))
		});
	} catch (error) {
		// Предметную ошибку переводит транспорт по той же таблице, что страницы и
		// формы; всё остальное — это сбой, и подменять его вежливым ответом нельзя.
		if (error instanceof AppError) {
			return json({ error: error.message }, { status: statusForError(error) });
		}

		throw error;
	}
};
