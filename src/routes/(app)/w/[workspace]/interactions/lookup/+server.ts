import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { id } from '$lib/contracts/common';
import { registryPickQuerySchema, registryPickSchema } from '$lib/contracts/enrichment';
import { actorFromEvent } from '$lib/server/actor';
import { listOrganizationContracts } from '$lib/server/directory/contracts';
import { listAffiliations, listSites, lookupOrganizations } from '$lib/server/directory/read';
import { EnrichmentRefusal } from '$lib/server/enrichment/access';
import { DadataError } from '$lib/server/enrichment/dadata';
import { createFromRegistry, searchRegistryCandidates } from '$lib/server/enrichment/pick';
import { AppError, statusForError } from '$lib/server/errors';
import type { RequestHandler } from './$types';

/**
 * Подсказки для формы взаимодействия: организации по поиску, их площадки,
 * контактные лица и договоры; организации из реестра (ЕГРЮЛ), если в
 * справочнике нужной нет, и `POST` — завести выбранную строку реестра.
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
		z.object({ kind: z.literal('registry'), ...registryPickQuerySchema.shape }),
		z.object({
			kind: z.enum(['sites', 'contacts', 'contracts']),
			organizationId: id('Не указана организация или её идентификатор некорректен')
		})
	],
	{ error: 'Неизвестный вид подсказки' }
);

export const GET: RequestHandler = async (event) => {
	const ctx = actorFromEvent(event);

	const query = lookupQuerySchema.safeParse({
		kind: event.url.searchParams.get('kind'),
		organizationId: event.url.searchParams.get('organizationId') ?? undefined,
		q: event.url.searchParams.get('q') ?? undefined,
		role: event.url.searchParams.get('role') ?? undefined
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

		if (query.data.kind === 'registry') {
			return json({
				items: await searchRegistryCandidates(ctx, query.data.q, query.data.role)
			});
		}

		// Договоры приезжают целиком, с позициями: форма выбирает договор и
		// подмножество его позиций, и подпись «продукт, лицензия до, статус»
		// собирается из тех же полей, что показывает карточка контрагента.
		if (query.data.kind === 'contracts') {
			return json({ items: await listOrganizationContracts(ctx, query.data.organizationId) });
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
		return failure(error);
	}
};

/**
 * Завести организацию из строки реестра, выбранной в поле формы. Тело — номер
 * строки и поле; реквизиты сервер берёт из своей копии, а не из запроса.
 * Ответ — организация в том же виде, что и подсказки справочника.
 */
export const POST: RequestHandler = async (event) => {
	let body: unknown;

	try {
		body = await event.request.json();
	} catch {
		return json({ error: 'Тело запроса — не JSON' }, { status: 400 });
	}

	const parsed = registryPickSchema.safeParse(body);

	if (!parsed.success) {
		return json(
			{ error: parsed.error.issues.map((issue) => issue.message).join('. ') },
			{ status: 400 }
		);
	}

	try {
		return json({
			item: await createFromRegistry(actorFromEvent(event), parsed.data.token, parsed.data.role)
		});
	} catch (error) {
		return failure(error);
	}
};

/**
 * Предметную ошибку переводит транспорт по той же таблице, что страницы и
 * формы. Отказ внешних источников — выключено, квота, поставщик не ответил —
 * тоже понятен сотруднику; причину отказа поставщика слышит только лог. Всё
 * остальное — сбой, и подменять его вежливым ответом нельзя.
 */
function failure(error: unknown): Response {
	if (error instanceof AppError) {
		return json({ error: error.message }, { status: statusForError(error) });
	}

	if (error instanceof EnrichmentRefusal) {
		return json({ error: error.message }, { status: error.status });
	}

	if (error instanceof DadataError) {
		console.error(`[enrichment] справочник организаций отказал: ${error.code}`, error.status);

		return json({ error: error.message }, { status: 502 });
	}

	throw error;
}
