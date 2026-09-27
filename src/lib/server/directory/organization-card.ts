/**
 * Карточка организации сверх справочника: откуда реквизиты, какая работа идёт
 * по пространствам и как кандидат с сайта вуза становится контактом.
 */
import { and, asc, desc, eq } from 'drizzle-orm';
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
import { auditEvents, directoryImportRows, directoryImports } from '../db/schema';
import { withTransaction, type Tx } from '../db/transaction';
import { lookupSite, peekSiteReport } from '../enrichment';
import { ConflictError, NotFoundError, ValidationError } from '../errors';
import { listInteractions } from '../interactions/read';
import { recordProcessingBasis } from '../people/consents';
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
};

/**
 * Кандидаты в контакты из уже прочитанного паспорта организации: только из
 * кэша, наружу чтение не ходит и квоты не тратит. Не прочитан паспорт, нет
 * сайта или права читать паспорт — список пуст: предлагать нечего. Кандидаты
 * с ФИО из одного слова и те, кто уже в действующих контактах, не предлагаются.
 */
export async function listSiteContactCandidates(
	ctx: ActorContext,
	organizationId: string
): Promise<SiteContactCandidate[]> {
	if (!can(ctx, 'people.write') || !can(ctx, 'organizations.write')) {
		return [];
	}

	const organization = await getOrganization(ctx, organizationId);

	if (organization.website === null) {
		return [];
	}

	const site = await peekSiteReport(ctx, organization.website);

	if (site === null) {
		return [];
	}

	const contacts = await listAffiliations(ctx, organizationId);
	const today = formatIsoDay();

	return site.contacts.flatMap((row) =>
		splitPersonName(row.name) === null || sameActiveContact(contacts, row.name, today) !== undefined
			? []
			: [{ unit: row.unit, name: row.name, position: positionOf(row.post, row.unit) }]
	);
}

/**
 * Кандидат из подраздела «Структура» — человеком и его ролью в организации,
 * ещё не записанными.
 *
 * Данные кандидата сервер берёт не из формы, а из раздела `/sveden` той
 * организации, чей сайт стоит в карточке (`lookupSite` — ответ живёт в кэше
 * сутки, повторное чтение квоту не тратит). Форма называет только, кого
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
			`На сайте вместо ФИО одно слово («${candidate.name}»): заведите человека вручную`
		);
	}

	const existing = sameActiveContact(
		await listAffiliations(ctx, organizationId),
		candidate.name,
		formatIsoDay()
	);

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
	// Номер — так же: в карточку, если его пропускает форма человека, иначе в
	// примечание как есть.
	const phone =
		candidate.phone !== null && createPersonSchema.shape.phone.safeParse(candidate.phone).success
			? candidate.phone
			: null;
	const notes = [
		`Из раздела «Сведения об образовательной организации» сайта ${site.website} (${site.struct.url}), прочитан ${formatDateTime(site.fetchedAt)}.`,
		`Подразделение: ${candidate.unit}.`,
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
			'Кандидата не завести автоматически: заведите человека вручную',
			person.error.issues.map((issue) => issue.message)
		);
	}

	return {
		person: person.data,
		role: {
			siteId: null,
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
