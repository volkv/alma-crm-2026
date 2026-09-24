/**
 * Карточка организации сверх справочника: откуда реквизиты, какая работа идёт
 * по пространствам и как кандидат с сайта вуза становится контактом.
 */
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import {
	affiliationPositionSchema,
	createPersonSchema,
	type AffiliationView,
	type PersonView
} from '$lib/contracts/directory';
import {
	FIELD_SOURCES,
	PASSPORT_FIELDS,
	PASSPORT_VIA,
	type FieldSource,
	type PassportField,
	type PassportVia
} from '$lib/contracts/enrichment';
import { interactionListQuerySchema, type InteractionListItem } from '$lib/contracts/interactions';
import {
	normalizePersonName,
	roleKindFromPost,
	splitPersonName,
	type AddSiteContactInput
} from '$lib/contracts/organization-card';
import { formatDateTime, formatIsoDay } from '$lib/format';
import type { ActorContext } from '../actor';
import { invalidateDirectoryOptions } from '../cache/directory';
import { getDb } from '../db';
import { auditEvents } from '../db/schema';
import { withTransaction } from '../db/transaction';
import { lookupSite } from '../enrichment';
import { ConflictError, NotFoundError, ValidationError } from '../errors';
import { listInteractions } from '../interactions/read';
import { can, requirePermission } from '../rbac';
import { getOrganization, listAffiliations } from './read';
import { createAffiliation, createPerson } from './write';

/* ------------------------------------------------------------------------- *
 * Откуда реквизиты.
 * ------------------------------------------------------------------------- */

/** Последняя приёмка полей из паспорта: кто, когда и из какого источника. */
export type PassportAppliedView = {
	occurredAt: Date;
	actorLabel: string;
	provenance: { field: PassportField; source: FieldSource; fetchedAt: string; via: PassportVia }[];
};

const provenanceSchema = z.array(
	z.object({
		field: z.enum(PASSPORT_FIELDS),
		source: z.enum(FIELD_SOURCES),
		fetchedAt: z.string(),
		via: z.enum(PASSPORT_VIA)
	})
);

/**
 * Последнее событие `organizations.passport_applied` по организации.
 *
 * Журнал — единственное место, где происхождение принятых полей записано:
 * сама карточка хранит значения, а не то, откуда они пришли. Права на журнал
 * здесь не нужно: показывается одна строка о той организации, которую
 * вызывающий уже видит, — её видимость проверил загрузчик карточки.
 */
export async function readPassportApplied(
	organizationId: string
): Promise<PassportAppliedView | null> {
	const [row] = await getDb()
		.select({
			occurredAt: auditEvents.occurredAt,
			actorLabel: auditEvents.actorLabel,
			details: auditEvents.details
		})
		.from(auditEvents)
		.where(
			and(
				eq(auditEvents.eventType, 'organizations.passport_applied'),
				eq(auditEvents.subjectType, 'organization'),
				eq(auditEvents.subjectId, organizationId)
			)
		)
		.orderBy(desc(auditEvents.occurredAt))
		.limit(1);

	if (row === undefined) {
		return null;
	}

	// Журнал неизменяем и пишется одним местом (`recordPassportProvenance`), но
	// поле `details` — JSON без схемы в базе: запись другого вида — поломка, и
	// показывать её за происхождение реквизитов нельзя.
	const provenance = provenanceSchema.parse(
		(row.details as { provenance?: unknown }).provenance ?? []
	);

	return {
		occurredAt: row.occurredAt,
		actorLabel: row.actorLabel,
		provenance
	};
}

/* ------------------------------------------------------------------------- *
 * Работа по пространствам.
 * ------------------------------------------------------------------------- */

/** Сколько последних записей пространства показывает карточка. */
const WORK_PREVIEW_SIZE = 5;

export type WorkspaceWork = {
	key: string;
	name: string;
	hasWorkflow: boolean;
	total: number;
	items: InteractionListItem[];
};

/**
 * Взаимодействия с организацией по пространствам сотрудника: по каждому —
 * несколько последних и общее число. Отбор тот же, что у списка пространства
 * (`listInteractions`), поэтому число на карточке и в списке по ссылке не
 * расходятся. `null` — нет права видеть взаимодействия.
 */
export async function listOrganizationWork(
	ctx: ActorContext,
	organizationId: string,
	workspaces: readonly { key: string; name: string; hasWorkflow: boolean }[]
): Promise<WorkspaceWork[] | null> {
	if (!can(ctx, 'interactions.read')) {
		return null;
	}

	return Promise.all(
		workspaces.map(async (workspace) => {
			const page = await listInteractions(
				ctx,
				interactionListQuerySchema.parse({
					organizationId,
					workspace: workspace.key,
					pageSize: WORK_PREVIEW_SIZE
				})
			);

			return { ...workspace, total: page.total, items: page.items };
		})
	);
}

/* ------------------------------------------------------------------------- *
 * Кандидат с сайта — в контакты.
 * ------------------------------------------------------------------------- */

const emailSchema = z.email();

/** Действующий контакт организации с тем же ФИО: второй такой не нужен. */
function sameActiveContact(
	affiliations: readonly AffiliationView[],
	name: string
): AffiliationView | undefined {
	const wanted = normalizePersonName(name);

	return affiliations.find(
		(row) =>
			row.validTo === null &&
			normalizePersonName(
				[row.person.lastName, row.person.firstName, row.person.middleName]
					.filter((part) => part !== null && part !== '')
					.join(' ')
			) === wanted
	);
}

/**
 * Должность роли: как её написал сайт, с подразделением, если оно в ней не
 * названо. Без должности — руководитель подразделения: подраздел «Структура»
 * перечисляет подразделения и их руководителей, другой роли у строки нет.
 */
function positionOf(post: string | null, unit: string): string {
	if (post === null) {
		return `Руководитель подразделения «${unit}»`;
	}

	const combined = `${post}, ${unit}`;

	return post.toLocaleLowerCase('ru').includes(unit.toLocaleLowerCase('ru')) ||
		!affiliationPositionSchema.safeParse(combined).success
		? post
		: combined;
}

export type AddedSiteContact = { person: PersonView; affiliation: AffiliationView };

/**
 * Заводит кандидата из подраздела «Структура» человеком и его ролью в
 * организации — одной транзакцией.
 *
 * Данные кандидата сервер берёт не из формы, а из раздела `/sveden` той
 * организации, чей сайт стоит в карточке (`lookupSite` — ответ живёт в кэше
 * сутки, повторное чтение квоту не тратит). Форма называет только, кого
 * добавить; кем он был на сайте и когда сайт прочитан, подделать браузером
 * нельзя. Источник и дата остаются в примечании человека.
 */
export async function addSiteContact(
	ctx: ActorContext,
	organizationId: string,
	input: AddSiteContactInput
): Promise<AddedSiteContact> {
	requirePermission(ctx, 'people.write');

	const organization = await getOrganization(ctx, organizationId);

	if (organization.website === null) {
		throw new ValidationError('У организации не указан сайт: кандидатов в контакты брать неоткуда');
	}

	const site = (await lookupSite(ctx, organization.website)).passport.site;
	const wanted = normalizePersonName(input.name);
	const candidate = site?.contacts.find(
		(row) =>
			row.unit === input.unit && row.name !== null && normalizePersonName(row.name) === wanted
	);

	if (site === null || candidate === undefined || candidate.name === null) {
		throw new NotFoundError(
			'Этого человека в подразделе «Структура» сайта больше нет: прочитайте «Сведения» заново'
		);
	}

	const parts = splitPersonName(candidate.name);

	if (parts === null) {
		throw new ValidationError(
			`На сайте вместо ФИО одно слово («${candidate.name}»): заведите человека вручную`
		);
	}

	const existing = sameActiveContact(await listAffiliations(ctx, organizationId), candidate.name);

	if (existing !== undefined) {
		throw new ConflictError(`${candidate.name} уже в контактах организации`);
	}

	// Почту с сайта кладём в карточку, только если она похожа на почту: ячейку
	// заполняли руками, и в ней бывает «priem[at]vuz.ru». Такая остаётся в
	// примечании как есть — сотрудник поправит её сам.
	const email =
		candidate.email !== null && emailSchema.safeParse(candidate.email.trim()).success
			? candidate.email.trim()
			: null;
	const notes = [
		`Из раздела «Сведения об образовательной организации» сайта ${site.website} (${site.struct.url}), прочитан ${formatDateTime(site.fetchedAt)}.`,
		`Подразделение: ${candidate.unit}.`,
		candidate.address === null ? null : `Адрес подразделения: ${candidate.address}.`,
		candidate.email !== null && email === null
			? `Почта на сайте записана как «${candidate.email}» — проверьте адрес.`
			: null
	]
		.filter((line) => line !== null)
		.join('\n');

	const person = createPersonSchema.safeParse({ ...parts, email, phone: null, notes });

	if (!person.success) {
		throw new ValidationError(
			'Кандидата не завести автоматически: заведите человека вручную',
			person.error.issues.map((issue) => issue.message)
		);
	}

	const added = await withTransaction(ctx, async (tx) => {
		const created = await createPerson(ctx, person.data, tx);
		const affiliation = await createAffiliation(
			ctx,
			{
				personId: created.id,
				organizationId,
				siteId: null,
				position: positionOf(candidate.post, candidate.unit),
				roleKind: roleKindFromPost(candidate.post),
				isPrimary: false,
				validFrom: formatIsoDay(),
				validTo: null,
				channel: null
			},
			tx
		);

		return { person: created, affiliation };
	});

	// Вложенные записи обесценили кэш выпадающих списков до фиксации; после неё —
	// ещё раз, чтобы в окне между ними никто не собрал список без нового человека.
	await invalidateDirectoryOptions();

	return added;
}
