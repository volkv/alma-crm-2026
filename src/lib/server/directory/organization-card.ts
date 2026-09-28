/**
 * Карточка организации сверх справочника: откуда реквизиты, какая работа идёт
 * по пространствам и как кандидат с сайта вуза становится контактом.
 */
import { and, asc, desc, eq, isNotNull, or } from 'drizzle-orm';
import { z } from 'zod';
import {
	affiliationPositionSchema,
	createPersonSchema,
	isAffiliationCurrent,
	type AffiliationView,
	type CreateAffiliationInput,
	type CreatePersonInput,
	type PersonView
} from '$lib/contracts/directory';
import {
	FIELD_SOURCES,
	MANAGEMENT_UNIT,
	normalizeUnitName,
	PASSPORT_FIELDS,
	PASSPORT_VIA,
	type ContactCandidate,
	type FieldSource,
	type PassportField,
	type PassportVia
} from '$lib/contracts/enrichment';
import { interactionListQuerySchema, type InteractionListItem } from '$lib/contracts/interactions';
import {
	normalizePersonName,
	roleKindFromPost,
	splitPersonName,
	type AddSiteContactInput,
	type SiteSourceView
} from '$lib/contracts/organization-card';
import { formatDateTime, formatIsoDay } from '$lib/format';
import type { ActorContext } from '../actor';
import { invalidateDirectoryOptions } from '../cache/directory';
import { getDb } from '../db';
import {
	affiliations as affiliationsTable,
	auditEvents,
	directoryImportRows,
	directoryImports,
	people
} from '../db/schema';
import { withTransaction, type Tx } from '../db/transaction';
import { lookupSite } from '../enrichment';
import { ConflictError, NotFoundError, ValidationError } from '../errors';
import { listInteractions } from '../interactions/read';
import { recordProcessingBasis } from '../people/consents';
import { hashEmail, hashPhone } from '../people/pii';
import { can, requirePermission } from '../rbac';
import { currentAffiliationFilter } from './affiliation-current';
import { getOrganization, listAffiliations, listSites } from './read';
import { siteSourceOf } from './site-offers';
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

/**
 * Как организация появилась в справочнике: загрузкой каталога или вручную.
 * Отвечает на вопрос «откуда реквизиты», когда приёмки из паспорта не было.
 */
export type OrganizationOriginView =
	| { kind: 'import'; at: Date }
	| { kind: 'manual'; at: Date; actorLabel: string }
	| { kind: 'individual'; at: Date };

/**
 * Происхождение организации: подтверждённая загрузка каталога, строка
 * которой её завела, либо событие `organizations.created` журнала. Импорт
 * проверяется первым: он заводит организацию тем же сервисом, и событие
 * создания у импортированной тоже есть. Организация, заведённая до журнала
 * (демо-данные), происхождения не имеет — `null`.
 *
 * Права здесь те же, что у `readPassportApplied`: одна строка о той
 * организации, которую вызывающий уже видит.
 */
export async function readOrganizationOrigin(
	organizationId: string
): Promise<OrganizationOriginView | null> {
	const db = getDb();
	const [imported] = await db
		.select({ at: directoryImports.confirmedAt })
		.from(directoryImportRows)
		.innerJoin(directoryImports, eq(directoryImports.id, directoryImportRows.importId))
		.where(
			and(
				eq(directoryImportRows.organizationId, organizationId),
				eq(directoryImportRows.action, 'create'),
				eq(directoryImports.status, 'confirmed')
			)
		)
		.orderBy(asc(directoryImports.confirmedAt))
		.limit(1);

	// У подтверждённой загрузки момент подтверждения есть всегда — это проверяет база.
	if (imported !== undefined && imported.at !== null) {
		return { kind: 'import', at: imported.at };
	}

	const [created] = await db
		.select({
			at: auditEvents.occurredAt,
			actorLabel: auditEvents.actorLabel,
			details: auditEvents.details
		})
		.from(auditEvents)
		.where(
			and(
				eq(auditEvents.eventType, 'organizations.created'),
				eq(auditEvents.subjectType, 'organization'),
				eq(auditEvents.subjectId, organizationId)
			)
		)
		.orderBy(asc(auditEvents.occurredAt))
		.limit(1);

	if (created === undefined) {
		return null;
	}

	// Контрагент-физлицо заводится вместе с человеком: в событии — его карточка.
	if ((created.details as { personId?: unknown } | null)?.personId !== undefined) {
		return { kind: 'individual', at: created.at };
	}

	return { kind: 'manual', at: created.at, actorLabel: created.actorLabel };
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
	name: string,
	today: string
): AffiliationView | undefined {
	const wanted = normalizePersonName(name);

	return affiliations.find(
		(row) =>
			isAffiliationCurrent(row, today) &&
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

export type AddedContact = { person: PersonView; affiliation: AffiliationView };

/** Контакт организации до записи: человек и его роль в ней. */
export type OrganizationContactDraft = {
	person: CreatePersonInput;
	role: Omit<CreateAffiliationInput, 'personId' | 'organizationId'>;
};

/**
 * Заводит контакт организации: человека и его роль в ней — в транзакции
 * вызывающего. Единственный путь, которым карточки заводят контакт одним
 * действием: кандидат с сайта и новый человек из карточки взаимодействия
 * проходят те же `createPerson` и `createAffiliation`, что и формы
 * справочника, — с их правами, шифрованием контактов и журналом, — и
 * получают основание обработки.
 */
export async function createOrganizationContact(
	ctx: ActorContext,
	organizationId: string,
	draft: OrganizationContactDraft,
	tx: Tx
): Promise<AddedContact> {
	const person = await createPerson(ctx, draft.person, tx);
	const affiliation = await createAffiliation(
		ctx,
		{ ...draft.role, personId: person.id, organizationId },
		tx
	);
	const day = formatIsoDay();

	// Представитель контрагента: его данные обрабатываются ради договора с
	// организацией, как и у контакта из импорта каталога (`import.ts`), —
	// основание «исполнение договора», версия текста — день записи.
	await recordProcessingBasis(ctx, tx, person.id, {
		basis: 'contract',
		textVersion: day,
		givenAt: day
	});

	return { person, affiliation };
}

/** Кандидат из паспорта, которого можно завести контактом одним щелчком. */
export type SiteContactCandidate = {
	unit: string;
	name: string;
	/** Должность, с которой он ляжет в роль. */
	position: string;
	/** Из подраздела «Руководство», а не из «Структуры». */
	fromManagement: boolean;
	/**
	 * Площадка организации, к которой ляжет его роль: подразделение с тем же
	 * названием уже в справочнике; `null` — не заведено.
	 */
	siteId: string | null;
};

/**
 * Кандидаты с сайта и в каком состоянии отчёт, из которого они взяты.
 * `source: null` — блока «с сайта» нет: организация не учебное заведение
 * (раздела `/sveden` у неё не бывает) или заводить людей некому.
 */
export type SiteContactOffers = {
	source: SiteSourceView | null;
	/** Сколько людей на сайте всего — вместе с уже заведёнными. */
	total: number;
	candidates: SiteContactCandidate[];
};

type ContactHashes = { emails: Set<string>; phones: Set<string> };

/**
 * Ключи сравнения почты и телефона действующих контактов организации — без
 * самих контактов: сверке кандидата с сайта хватает совпадения, а
 * расшифровывать ради неё персональные данные незачем.
 */
async function activeContactHashes(organizationId: string): Promise<ContactHashes> {
	const rows = await getDb()
		.select({ emailHash: people.emailHash, phoneHash: people.phoneHash })
		.from(affiliationsTable)
		.innerJoin(people, eq(people.id, affiliationsTable.personId))
		.where(
			and(
				eq(affiliationsTable.organizationId, organizationId),
				currentAffiliationFilter(),
				or(isNotNull(people.emailHash), isNotNull(people.phoneHash))
			)
		);

	return {
		emails: new Set(rows.flatMap((row) => (row.emailHash === null ? [] : [row.emailHash]))),
		phones: new Set(rows.flatMap((row) => (row.phoneHash === null ? [] : [row.phoneHash])))
	};
}

/**
 * Кандидат уже в действующих контактах: по ФИО или — если сайт их дал — по
 * почте и телефону. Почта с сайта бывает общей для кафедры, но и тогда её
 * владелец уже в справочнике, и второй контакт на тот же ящик не нужен.
 */
function alreadyContact(
	candidate: Pick<ContactCandidate, 'name' | 'email' | 'phone'>,
	contacts: readonly AffiliationView[],
	hashes: ContactHashes,
	today: string
): boolean {
	if (sameActiveContact(contacts, candidate.name, today) !== undefined) {
		return true;
	}

	const email = candidate.email === null ? null : hashEmail(candidate.email);
	const phone = candidate.phone === null ? null : hashPhone(candidate.phone);

	return (
		(email !== null && hashes.emails.has(email)) || (phone !== null && hashes.phones.has(phone))
	);
}

/**
 * Площадки организации по названию в виде для сверки — чтобы роль кандидата
 * легла к его подразделению, если оно уже заведено. Без права видеть
 * организации площадок нет: роль ляжет без подразделения.
 */
async function sitesByName(
	ctx: ActorContext,
	organizationId: string
): Promise<Map<string, string>> {
	if (!can(ctx, 'organizations.read')) {
		return new Map();
	}

	return new Map(
		(await listSites(ctx, organizationId)).map((site) => [normalizeUnitName(site.name), site.id])
	);
}

/**
 * Кандидаты в контакты из отчёта сайта организации: только из кэша, наружу
 * чтение не ходит и квоты не тратит; отчёта нет — его прогревают в фоне, и
 * состояние говорит «читается». Без права заводить людей и править
 * организации предлагать некому, у организации не вуза раздела нет — блока
 * нет вовсе. Кандидаты с ФИО из одного
 * слова и те, кто уже в действующих контактах (по ФИО, почте или телефону),
 * не предлагаются.
 */
export async function listSiteContactCandidates(
	ctx: ActorContext,
	organizationId: string
): Promise<SiteContactOffers> {
	if (!can(ctx, 'people.write') || !can(ctx, 'organizations.write')) {
		return { source: null, total: 0, candidates: [] };
	}

	const organization = await getOrganization(ctx, organizationId);

	if (organization.kind !== 'educational_institution') {
		return { source: null, total: 0, candidates: [] };
	}

	const { source, report } = await siteSourceOf(organization.website);

	if (report === null) {
		return { source, total: 0, candidates: [] };
	}

	if (report.contacts.length === 0 && !report.struct.found && report.managers?.found !== true) {
		return { source: { ...source, state: 'unreadable' }, total: 0, candidates: [] };
	}

	const [contacts, hashes, sites] = await Promise.all([
		listAffiliations(ctx, organizationId),
		activeContactHashes(organizationId),
		sitesByName(ctx, organizationId)
	]);
	const today = formatIsoDay();

	return {
		source,
		total: report.contacts.length,
		candidates: report.contacts.flatMap((row) =>
			splitPersonName(row.name) === null || alreadyContact(row, contacts, hashes, today)
				? []
				: [
						{
							unit: row.unit,
							name: row.name,
							position: positionOf(row.post, row.unit),
							fromManagement: row.unit === MANAGEMENT_UNIT,
							siteId: sites.get(normalizeUnitName(row.unit)) ?? null
						}
					]
		)
	};
}

/**
 * Кандидат из подразделов «Структура» и «Руководство» — человеком и его ролью
 * в организации, ещё не записанными.
 *
 * Данные кандидата сервер берёт не из формы, а из раздела `/sveden` той
 * организации, чей сайт стоит в карточке (`lookupSite` — отчёт живёт в кэше
 * неделю, повторное чтение квоту не тратит). Форма называет только, кого
 * добавить; кем он был на сайте и когда сайт прочитан, подделать браузером
 * нельзя. Источник и дата остаются в примечании человека.
 */
export async function siteContactDraft(
	ctx: ActorContext,
	organizationId: string,
	input: AddSiteContactInput
): Promise<OrganizationContactDraft> {
	requirePermission(ctx, 'people.write');

	const organization = await getOrganization(ctx, organizationId);

	if (organization.website === null) {
		throw new ValidationError('У организации не указан сайт: кандидатов в контакты брать неоткуда');
	}

	const site = (await lookupSite(ctx, organization.website)).passport.site;
	const wanted = normalizePersonName(input.name);
	const candidate = site?.contacts.find(
		(row) => row.unit === input.unit && normalizePersonName(row.name) === wanted
	);

	if (site === null || candidate === undefined) {
		throw new NotFoundError(
			'Этого человека в подразделе «Структура» сайта больше нет: прочитайте «Сведения» заново'
		);
	}

	const parts = splitPersonName(candidate.name);

	if (parts === null) {
		throw new ValidationError(
			`На сайте вместо ФИО одно слово («${candidate.name}»): добавьте человека вручную`
		);
	}

	const [contacts, hashes, sites] = await Promise.all([
		listAffiliations(ctx, organizationId),
		activeContactHashes(organizationId),
		sitesByName(ctx, organizationId)
	]);

	if (alreadyContact(candidate, contacts, hashes, formatIsoDay())) {
		throw new ConflictError(`${candidate.name} уже в контактах организации`);
	}

	// Почту с сайта кладём в карточку, только если она похожа на почту: ячейку
	// заполняли руками, и в ней бывает «priem[at]vuz.ru». Такая остаётся в
	// примечании как есть — сотрудник поправит её сам.
	const email =
		candidate.email !== null && emailSchema.safeParse(candidate.email.trim()).success
			? candidate.email.trim()
			: null;
	// Номер — так же: в карточку, если его пропускает форма человека, иначе в
	// примечание как есть.
	const phone =
		candidate.phone !== null && createPersonSchema.shape.phone.safeParse(candidate.phone).success
			? candidate.phone
			: null;
	const notes = [
		`Из раздела «Сведения об образовательной организации» сайта ${site.website} (${site.struct.url}), прочитан ${formatDateTime(site.fetchedAt)}.`,
		candidate.unit === MANAGEMENT_UNIT
			? 'Из подраздела «Руководство».'
			: `Подразделение: ${candidate.unit}.`,
		candidate.address === null ? null : `Адрес подразделения: ${candidate.address}.`,
		candidate.email !== null && email === null
			? `Почта на сайте записана как «${candidate.email}» — проверьте адрес.`
			: null,
		candidate.phone !== null && phone === null
			? `Телефон на сайте записан как «${candidate.phone}» — проверьте номер.`
			: null
	]
		.filter((line) => line !== null)
		.join('\n');

	const person = createPersonSchema.safeParse({ ...parts, email, phone, notes });

	if (!person.success) {
		throw new ValidationError(
			'Кандидата не добавить автоматически: добавьте человека вручную',
			person.error.issues.map((issue) => issue.message)
		);
	}

	return {
		person: person.data,
		role: {
			// Подразделение, уже заведённое площадкой, становится площадкой роли.
			// Незаведённое само не заводится: «Ученый совет» и «Ректорат» в
			// «Структуре» — органы управления, а не площадки, и решает это
			// сотрудник, импортируя подразделение в «Составе» дела.
			siteId: sites.get(normalizeUnitName(candidate.unit)) ?? null,
			position: positionOf(candidate.post, candidate.unit),
			roleKind: roleKindFromPost(candidate.post),
			isPrimary: false,
			validFrom: formatIsoDay(),
			validTo: null,
			channel: null
		}
	};
}

/** Кандидат из подраздела «Структура» — в контакты организации одной транзакцией. */
export async function addSiteContact(
	ctx: ActorContext,
	organizationId: string,
	input: AddSiteContactInput
): Promise<AddedContact> {
	const draft = await siteContactDraft(ctx, organizationId, input);
	const added = await withTransaction(ctx, (tx) =>
		createOrganizationContact(ctx, organizationId, draft, tx)
	);

	// Вложенные записи обесценили кэш выпадающих списков до фиксации; после неё —
	// ещё раз, чтобы в окне между ними никто не собрал список без нового человека.
	await invalidateDirectoryOptions();

	return added;
}
