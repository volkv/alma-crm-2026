import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { id } from '$lib/contracts/common';
import {
	createOrganizationSchema,
	createSiteSchema,
	isAffiliationCurrent,
	ORGANIZATION_KINDS,
	type LookupOption,
	type OrganizationKind
} from '$lib/contracts/directory';
import {
	REGISTRY_PICK_KINDS,
	registryPickQuerySchema,
	registryPickSchema
} from '$lib/contracts/enrichment';
import { individualCounterpartySchema } from '$lib/contracts/interactions';
import { formatIsoDay } from '$lib/format';
import { actorFromEvent, type ActorContext } from '$lib/server/actor';
import { listOrganizationContracts } from '$lib/server/directory/contracts';
import {
	listAffiliations,
	listOrganizations,
	listSites,
	lookupOrganizations
} from '$lib/server/directory/read';
import { createOrganization, createSite } from '$lib/server/directory/write';
import { EnrichmentRefusal } from '$lib/server/enrichment/access';
import { DadataError } from '$lib/server/enrichment/dadata';
import { createFromRegistry, searchRegistryCandidates } from '$lib/server/enrichment/pick';
import { AppError, statusForError } from '$lib/server/errors';
import { createIndividualCounterparty } from '$lib/server/interactions/counterparty';
import type { RequestHandler } from './$types';

/**
 * Подсказки для формы взаимодействия: организации по поиску, их площадки,
 * контактные лица и договоры; организации из реестра (ЕГРЮЛ), если в
 * справочнике нужной нет, и `POST` — завести контрагента, которого в
 * справочнике нет: строку реестра, организацию вручную или физическое лицо.
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
		z.object({
			kind: z.literal('organizations'),
			/** Каких видов искать: `kinds=legal_entity,customer_company`; нет — любых. */
			kinds: z
				.string()
				.optional()
				.transform((value) => (value === undefined || value === '' ? [] : value.split(',')))
				.pipe(z.array(z.enum(ORGANIZATION_KINDS, { error: 'Неизвестный вид организации' })))
		}),
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
		kinds: event.url.searchParams.get('kinds') ?? undefined,
		q: event.url.searchParams.get('q') ?? undefined
	});

	if (!query.success) {
		return json(
			{ error: query.error.issues.map((issue) => issue.message).join('. ') },
			{ status: 400 }
		);
	}

	try {
		if (query.data.kind === 'organizations') {
			const q = event.url.searchParams.get('q');

			return json({
				items:
					query.data.kinds.length === 0
						? await lookupOrganizations(ctx, q)
						: await lookupOrganizationsOfKinds(ctx, q, query.data.kinds)
			});
		}

		if (query.data.kind === 'registry') {
			return json({ items: await searchRegistryCandidates(ctx, query.data.q) });
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

		// Контактным лицом выбирают только действующую роль: прежняя — это
		// человек, который в организации уже не работает с нами.
		const affiliations = await listAffiliations(ctx, query.data.organizationId);
		const today = formatIsoDay();

		return json({
			items: affiliations
				.filter((affiliation) => isAffiliationCurrent(affiliation, today))
				.map((affiliation) => ({
					id: affiliation.id,
					label: `${affiliation.person.lastName} ${affiliation.person.firstName} — ${affiliation.position}`
				}))
		});
	} catch (error) {
		return failure(error);
	}
};

/** Сколько подсказок отдаёт поле: столько же, сколько поиск справочника. */
const LOOKUP_LIMIT = 20;

/**
 * Подсказки только нужных видов: поле «Компания» не предлагает вузов и
 * физлиц. Ищет тот же список справочника, что раздел «Организации», — по виду,
 * с той же областью доступа; выбрать сторону можно только из действующих.
 */
async function lookupOrganizationsOfKinds(
	ctx: ActorContext,
	q: string | null,
	kinds: readonly OrganizationKind[]
): Promise<LookupOption[]> {
	const pages = await Promise.all(
		kinds.map((kind) =>
			listOrganizations(ctx, {
				kind,
				q: q === null || q.trim() === '' ? null : q.trim(),
				page: 1,
				pageSize: LOOKUP_LIMIT
			})
		)
	);

	return pages
		.flatMap((page) => page.items)
		.filter((organization) => organization.isActive)
		.sort((left, right) => left.shortName.localeCompare(right.shortName, 'ru'))
		.slice(0, LOOKUP_LIMIT)
		.map((organization) => ({ id: organization.id, label: organization.shortName }));
}

/**
 * Что можно завести из поля формы: строку реестра, организацию вручную (тем же
 * описанием, что у формы справочника), физическое лицо — или площадку
 * организации стороны, её подразделение, не уходя из карточки дела.
 */
const createBodySchema = z.union([
	registryPickSchema,
	z.object({ create: z.literal('organization'), organization: createOrganizationSchema }),
	z.object({ create: z.literal('individual'), person: individualCounterpartySchema }),
	z.object({ create: z.literal('site'), site: createSiteSchema })
]);

/**
 * Завести контрагента, которого нет в справочнике, из поля формы. Строку
 * реестра сервер заводит по своей копии, а не по запросу; организацию вручную
 * — сервисом справочника, с его проверками; физическое лицо — вместе с
 * человеком и его ролью. Ответ — организация в том же виде, что и подсказки
 * справочника, у физического лица — ещё и его роль: он же контактное лицо.
 */
export const POST: RequestHandler = async (event) => {
	let body: unknown;

	try {
		body = await event.request.json();
	} catch {
		return json({ error: 'Тело запроса — не JSON' }, { status: 400 });
	}

	const parsed = createBodySchema.safeParse(body);

	if (!parsed.success) {
		return json(
			{ error: parsed.error.issues.map((issue) => issue.message).join('. ') },
			{ status: 400 }
		);
	}

	const ctx = actorFromEvent(event);
	const request = parsed.data;

	try {
		if ('token' in request) {
			const { created: _created, ...item } = await createFromRegistry(
				ctx,
				request.token,
				REGISTRY_PICK_KINDS[request.role]
			);

			return json({ item });
		}

		if (request.create === 'organization') {
			const created = await createOrganization(ctx, request.organization);

			return json({ item: { id: created.id, label: created.shortName } });
		}

		// Площадка заводится тем же сервисом справочника, что форма площадки в
		// карточке организации: право, проверка организации и журнал — его.
		if (request.create === 'site') {
			const created = await createSite(ctx, request.site);

			return json({ item: { id: created.id, label: created.name } });
		}

		const created = await createIndividualCounterparty(ctx, request.person);

		return json({ item: created.option, contactAffiliationId: created.contactAffiliationId });
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
