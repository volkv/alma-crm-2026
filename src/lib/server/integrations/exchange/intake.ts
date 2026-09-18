/**
 * Приём заявки с сайта: направление 1 контракта обмена.
 *
 * Заявка не заводит в системе третью сущность рядом с контрагентом и
 * взаимодействием. Она сразу становится тем, чем является: обращением, которое
 * кто-то должен вести. Поэтому здесь только сборка — найти или завести
 * контрагента, контактное лицо и его роль, — а дальше работают обычные сервисы
 * справочника, взаимодействий и стадий, с их правами, проверками и журналом.
 *
 * **Кто применяет заявку.** Ключом её приносит машинный субъект роли `service`:
 * у него есть право `exchange.intake` и нет ни `organizations.write`, ни
 * `interactions.write` — и это правильно, чужая система не ведёт справочник.
 * Доменные операции выполняет сотрудник из настройки
 * `exchange.cms.defaultOwnerUserId`: он принимает входящие, он же становится
 * ответственным, его именем подписан первый комментарий и его права проверяются.
 * Ключ при этом не теряется — он остаётся в каждой записи журнала (`api_key_id`).
 *
 * **Сопоставление контрагента идёт по всей базе**, без области доступа: CMS не
 * знает, кто ведёт вуз, а вторая организация с тем же ИНН — это не решение, а
 * поломка справочника. Назначение на сотрудника создаётся до создания
 * взаимодействия — иначе заявка пришла бы и в ту же секунду пропала из виду у
 * того, кому её поручили.
 *
 * **Атомарность.** Строка журнала обмена, доменные изменения и сохранённый
 * ответ пишутся одной транзакцией (`docs/exchange-contract.md`, раздел 2).
 * Строка журнала вставляется **первой**: её уникальность `(direction, system,
 * instance, event_id)` и есть защита от второй обработки того же сообщения, в
 * том числе от двух одновременных доставок.
 */
import { createHash } from 'node:crypto';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import {
	APPLICATION_STATUSES,
	EXCHANGE_SCHEMA_VERSION,
	PROCESS_GROUP_BY_APPLICANT,
	externalSourceOf,
	isSupportedSchemaVersion,
	type ApplicationIntakeResponse,
	type ApplicationSubmittedData,
	type ApplicationSubmittedMessage,
	type ExchangeResult
} from '$lib/contracts/exchange';
import type { PartyRole } from '$lib/contracts/interactions';
import { formatIsoDay } from '$lib/format';
import type { ActorContext } from '../../actor';
import { recordAuditEvent } from '../../audit';
import { loadSessionUser } from '../../auth/session';
import { getDb } from '../../db';
import {
	affiliations,
	consents,
	contractItems,
	exchangeMessages,
	interactionContractItems,
	interactionProducts,
	interactionPrograms,
	interactions,
	organizationResponsibles,
	organizations,
	people,
	processGroups,
	products,
	programs,
	users
} from '../../db/schema';
import { withTransaction, type Tx } from '../../db/transaction';
import { createAffiliation, createOrganization, createPerson } from '../../directory/write';
import { AppError, ConflictError, ForbiddenError, ValidationError } from '../../errors';
import { createInteractionIn } from '../../interactions/write';
import { hashEmail, hashPhone, phoneColumns } from '../../people/pii';
import { withPiiTrace } from '../../people/pii-trace';
import { requirePermission } from '../../rbac';
import { addComment } from '../../stages/commands';
import { getExchangeSettings } from '../settings';
import { enqueueApplicationStatus } from './outbox';

/** Код PostgreSQL «нарушена уникальность». */
const UNIQUE_VIOLATION = '23505';

/** Должность контактного лица, когда сайт её не спросил. */
const DEFAULT_POSITION = 'Контактное лицо (заявка с сайта)';

/** Кем контрагент участвует во взаимодействии — по его виду в справочнике. */
const PARTY_ROLE_BY_KIND: Record<string, PartyRole> = {
	// Контрагент группы B2C учится сам и сам платит: в ролях сторон это заказчик.
	individual: 'customer',
	legal_entity: 'customer',
	educational_institution: 'educational_institution'
};

function isUniqueViolation(error: unknown): boolean {
	let current: unknown = error;

	while (current instanceof Error) {
		if ((current as { code?: unknown }).code === UNIQUE_VIOLATION) {
			return true;
		}

		current = current.cause;
	}

	return false;
}

/** Отпечаток запроса: по нему настоящий повтор отличается от другого тела. */
export function hashMessage(message: unknown): string {
	return createHash('sha256').update(JSON.stringify(message), 'utf8').digest('hex');
}

/** Отпечаток адреса почты: по нему видно «тот же контакт или другой», и только. */
function contactFingerprint(email: string): string {
	return createHash('sha256').update(email.trim().toLowerCase(), 'utf8').digest('hex');
}

/**
 * Что от заявки остаётся в журнале обмена.
 *
 * Не сама заявка. ФИО, почта и телефон заявителя уже легли в `people`, где
 * работают маскирование, срок хранения и обезличивание; вторая копия в
 * `exchange_messages` этих правил не знает и пережила бы обезличивание человека
 * целиком — журнал обмена никто не чистит. Хранить персональные данные дольше,
 * чем нужно для цели, ради которой их собрали, нельзя, а цель журнала обмена
 * другая: «что приезжало, когда и чем ответили».
 *
 * Поэтому здесь остаются идентификаторы, коды, суммы и отпечатки — всего этого
 * хватает, чтобы разобрать обмен: ключ заявки, ревизия, вид заявителя и его
 * реквизиты, коды справочника, ссылки на вложения. Свободный текст заявителя
 * (интерес, комментарий) уезжает в первый комментарий взаимодействия и здесь не
 * повторяется: в нём бывает и фамилия, и телефон.
 */
function journalPayload(message: ApplicationSubmittedMessage): Record<string, unknown> {
	const data = message.data;
	const applicant = data.applicant;

	return {
		schemaVersion: message.schemaVersion,
		eventId: message.eventId,
		eventType: message.eventType,
		occurredAt: message.occurredAt,
		source: message.source,
		data: {
			externalId: data.externalId,
			revision: data.revision,
			form: data.form,
			applicant:
				applicant.kind === 'individual'
					? { kind: applicant.kind }
					: {
							kind: applicant.kind,
							inn: applicant.inn,
							ogrn: applicant.ogrn,
							...(applicant.kind === 'educational_institution'
								? { educationLevel: applicant.educationLevel }
								: {})
						},
			contact: { emailHash: contactFingerprint(data.contact.email) },
			programCodes: data.programCodes,
			productCodes: data.productCodes,
			transferStatus: data.transferStatus,
			consent:
				data.consent === null
					? null
					: {
							given: data.consent.given,
							at: data.consent.at,
							policyVersion: data.consent.policyVersion
						},
			// Имя файла остаётся у документа, а не в журнале обмена: «Скан паспорта
			// Иванова.pdf» — такие же персональные данные, как и сама фамилия.
			attachments: data.attachments.map((file) => ({
				documentId: file.documentId,
				mime: file.mime,
				sizeBytes: file.sizeBytes,
				sha256: file.sha256,
				storageKey: file.storageKey
			}))
		}
	};
}

/** Название взаимодействия: по нему заявку узнают в списке. */
function interactionTitle(name: string, interest: string | null): string {
	const base = `Заявка с сайта: ${name}`;

	return (interest === null ? base : `${base} — ${interest}`).slice(0, 300);
}

/** Имя контрагента-физлица: ФИО из заявки, отдельной копии не появляется. */
function applicantName(data: ApplicationSubmittedData): string {
	const applicant = data.applicant;

	if (applicant.kind === 'individual') {
		return [applicant.lastName, applicant.firstName, applicant.middleName]
			.filter((part) => part !== null && part !== '')
			.join(' ');
	}

	return applicant.name;
}

/**
 * Первый комментарий: то, что написал заявитель, слово в слово, и расхождения
 * справочника рядом. Неизвестный код программы заявку не отвергает — заявка,
 * потерянная из-за опечатки в коде продукта, это потерянный вуз.
 */
function intakeComment(
	data: ApplicationSubmittedData,
	unknownCodes: readonly string[],
	transferStatusApplied: boolean
): string {
	const lines: string[] = [];

	if (data.interest !== null) {
		lines.push(`Интересует: ${data.interest}`);
	}

	if (data.comment !== null) {
		lines.push(data.comment);
	}

	if (unknownCodes.length > 0) {
		lines.push(`Коды справочника не опознаны: ${unknownCodes.join(', ')}`);
	}

	// Статус по передаче ложится на позицию договора, а у новой заявки договора
	// ещё нет. Потерять присланное нельзя: сотрудник свяжет заявку с договором и
	// проставит статус сам, а по комментарию будет видно, какой именно.
	if (data.transferStatus !== null && !transferStatusApplied) {
		lines.push(
			`Статус по передаче из каталога заказчика: ${data.transferStatus}. Позиции договора, к которой его отнести, у заявки нет — проставьте статус, когда свяжете её с договором.`
		);
	}

	if (data.attachments.length > 0) {
		lines.push(
			`К заявке приложены файлы (${data.attachments.map((file) => file.name).join(', ')}); ` +
				'заберите их у отправителя и приложите к карточке.'
		);
	}

	return lines.join('\n\n').slice(0, 4000);
}

/**
 * Сотрудник, который принимает входящие заявки.
 *
 * Настройка не задана — берём демонстрационного менеджера, если он в системе
 * есть: стенд обязан принимать заявку сразу после сида, не требуя похода в
 * настройки. Нет и его — заявка отвергается с указанием, что настроить: тихо
 * назначить робота хуже, чем отказать.
 */
async function resolveIntakeOwner(tx: Tx, configured: string | null): Promise<string> {
	if (configured !== null) {
		const [row] = await tx
			.select({ id: users.id, roleId: users.roleId })
			.from(users)
			.where(and(eq(users.id, configured), eq(users.isActive, true)))
			.limit(1);

		if (row === undefined) {
			throw new ValidationError('Ответственный за входящие заявки недоступен', [
				'Настройка «Ответственный за входящие» указывает на выключенного или несуществующего сотрудника'
			]);
		}

		if (row.roleId === 'service') {
			throw new ValidationError('Ответственный за входящие заявки указан неверно', [
				'Машинный субъект не ведёт заявки: выберите живого сотрудника'
			]);
		}

		return row.id;
	}

	const [demo] = await tx
		.select({ id: users.id })
		.from(users)
		.where(and(eq(users.isDemo, true), eq(users.isActive, true), eq(users.roleId, 'manager')))
		.orderBy(users.email)
		.limit(1);

	if (demo === undefined) {
		throw new ValidationError('Ответственный за входящие заявки не настроен', [
			'Укажите сотрудника в разделе «Настройки → Интеграции», поле «Ответственный за входящие заявки»'
		]);
	}

	return demo.id;
}

/**
 * Действующее лицо доменных операций: сотрудник, принимающий входящие.
 *
 * Ключ, запрос и адрес остаются теми же — меняется только тот, от чьего имени
 * заводятся записи. Так в журнале видно и живого ответственного, и ключ, которым
 * заявку принесли, а права и область считаются по обычным правилам.
 */
async function ownerActor(ctx: ActorContext, ownerUserId: string): Promise<ActorContext> {
	const owner = await loadSessionUser(ownerUserId);

	if (owner === null) {
		throw new ValidationError('Ответственный за входящие заявки недоступен', [
			'Учётная запись ответственного выключена: заявку некому вести'
		]);
	}

	return { ...ctx, user: owner, scope: owner.scope };
}

type Counterparty = {
	organizationId: string;
	personId: string | null;
	/** Реквизитов не прислали — контрагента завели вслепую, нужна сверка. */
	needsReview: boolean;
	created: boolean;
};

/** Организация по ИНН, а при его отсутствии — по ОГРН. По названию — никогда. */
async function findOrganization(
	tx: Tx,
	inn: string | null,
	ogrn: string | null
): Promise<{ id: string; inn: string | null } | null> {
	if (inn !== null) {
		const [row] = await tx
			.select({ id: organizations.id, inn: organizations.inn })
			.from(organizations)
			.where(eq(organizations.inn, inn))
			.limit(1);

		return row ?? null;
	}

	if (ogrn !== null) {
		const [row] = await tx
			.select({ id: organizations.id, inn: organizations.inn })
			.from(organizations)
			.where(eq(organizations.ogrn, ogrn))
			.limit(1);

		return row ?? null;
	}

	return null;
}

/**
 * Контрагент-физлицо: по ключу сравнения почты, затем по ключу телефона.
 *
 * Не по самим контактам: в базе они лежат шифртекстом, и у одного и того же
 * адреса он каждый раз новый. Нормализацию (регистр почты, вид записи номера)
 * знает `people/pii.ts`, и она здесь одна на обе стороны сравнения.
 */
async function findIndividual(
	tx: Tx,
	email: string,
	phone: string | null
): Promise<{ id: string; personId: string | null } | null> {
	const emailKey = hashEmail(email);

	if (emailKey !== null) {
		const [byEmail] = await tx
			.select({ id: organizations.id, personId: organizations.personId })
			.from(organizations)
			.innerJoin(people, eq(people.id, organizations.personId))
			.where(and(eq(organizations.kind, 'individual'), eq(people.emailHash, emailKey)))
			.limit(1);

		if (byEmail !== undefined) {
			return byEmail;
		}
	}

	const phoneKey = phone === null ? null : hashPhone(phone);

	if (phoneKey === null) {
		return null;
	}

	const [byPhone] = await tx
		.select({ id: organizations.id, personId: organizations.personId })
		.from(organizations)
		.innerJoin(people, eq(people.id, organizations.personId))
		.where(and(eq(organizations.kind, 'individual'), eq(people.phoneHash, phoneKey)))
		.limit(1);

	return byPhone ?? null;
}

/**
 * Контрагент-физлицо заводится здесь, а не сервисом справочника: форма
 * справочника такого контрагента не заводит вовсе (`ORGANIZATION_FORM_KINDS`), а
 * `createOrganization` не принимает `person_id` — связь организации с человеком
 * появляется только вместе с заявкой. ФИО, контакты и согласие ложатся в
 * `people`, где работают маскирование, срок хранения и обезличивание; копии ФИО
 * в полях организации не появляется — название и есть ФИО.
 */
async function createIndividual(
	ctx: ActorContext,
	tx: Tx,
	data: ApplicationSubmittedData
): Promise<{ organizationId: string; personId: string }> {
	const applicant = data.applicant;

	if (applicant.kind !== 'individual') {
		throw new ValidationError('Заявитель — не физическое лицо', []);
	}

	const person = await createPerson(
		ctx,
		{
			lastName: applicant.lastName,
			firstName: applicant.firstName,
			middleName: applicant.middleName,
			email: data.contact.email,
			phone: data.contact.phone,
			notes: null
		},
		tx
	);

	const name = applicantName(data);
	const [organization] = await tx
		.insert(organizations)
		.values({
			kind: 'individual',
			educationLevel: null,
			legalName: name,
			shortName: name.slice(0, 200),
			personId: person.id,
			isActive: true
		})
		.returning({ id: organizations.id });

	await recordAuditEvent(
		ctx,
		{
			type: 'organizations.created',
			outcome: 'success',
			subject: { type: 'organization', id: organization.id },
			details: { personId: person.id }
		},
		tx
	);

	return { organizationId: organization.id, personId: person.id };
}

/**
 * Действующее назначение сотрудника на контрагента; нет — создаётся.
 *
 * Не `assignResponsible`: тот открывает свою транзакцию и требует
 * `responsibles.manage` — права, которого у принимающего сотрудника нет и не
 * должно быть. Здесь другой случай: назначение не раздают, а достраивают до
 * того, что уже решено настройкой, и только когда действующего назначения нет
 * ни одного. Прежних назначений эта строка не трогает.
 */
async function ensureResponsible(
	ctx: ActorContext,
	tx: Tx,
	organizationId: string,
	userId: string
): Promise<void> {
	const existing = await tx
		.select({ id: organizationResponsibles.id, userId: organizationResponsibles.userId })
		.from(organizationResponsibles)
		.where(
			and(
				eq(organizationResponsibles.organizationId, organizationId),
				sql`${organizationResponsibles.validTo} is null`
			)
		);

	if (existing.length > 0) {
		return;
	}

	await tx.insert(organizationResponsibles).values({ organizationId, userId });

	await recordAuditEvent(
		ctx,
		{
			type: 'directory.responsible_assigned',
			outcome: 'success',
			subject: { type: 'organization', id: organizationId },
			details: { organizationId, userId }
		},
		tx
	);
}

/**
 * Действующий ответственный за контрагента; `null` — его нет.
 *
 * Именно от его имени и ведётся заявка по знакомому вузу. Иначе выходит
 * бессмыслица: заявка приходит по вузу, который ведёт один КАМ, а применяет её
 * сотрудник из настройки — со своей областью доступа, в которую этот вуз не
 * входит. Ни найти организацию, ни завести взаимодействие он не может, и
 * заявка отвергается «организация не найдена», хотя организация есть.
 *
 * Машинный субъект ответственным не бывает (`ne(users.roleId, 'service')`), а
 * выключенная запись заявку вести не может — оба случая равны «ответственного
 * нет», и тогда работает сотрудник из настройки.
 */
async function currentResponsible(tx: Tx, organizationId: string): Promise<string | null> {
	const [row] = await tx
		.select({ userId: organizationResponsibles.userId })
		.from(organizationResponsibles)
		.innerJoin(users, eq(users.id, organizationResponsibles.userId))
		.where(
			and(
				eq(organizationResponsibles.organizationId, organizationId),
				sql`${organizationResponsibles.validTo} is null`,
				eq(users.isActive, true),
				ne(users.roleId, 'service')
			)
		)
		.limit(1);

	return row?.userId ?? null;
}

/**
 * Контрагент заявки, если он в справочнике уже есть. Только чтение: правила
 * сопоставления те же, что у `resolveCounterparty`, и заводить здесь ничего
 * нельзя — до выбора действующего лица ещё не решено, чьими правами заводить.
 */
async function findApplicantOrganization(
	tx: Tx,
	data: ApplicationSubmittedData
): Promise<string | null> {
	const applicant = data.applicant;

	if (applicant.kind === 'individual') {
		const found = await findIndividual(tx, data.contact.email.toLowerCase(), data.contact.phone);

		return found?.id ?? null;
	}

	const found = await findOrganization(tx, applicant.inn, applicant.ogrn);

	return found?.id ?? null;
}

/** Контакт, который уже числится в этой организации под тем же адресом почты. */
async function findContact(
	tx: Tx,
	organizationId: string,
	email: string
): Promise<{ affiliationId: string; personId: string } | null> {
	const emailKey = hashEmail(email);

	if (emailKey === null) {
		return null;
	}

	const [row] = await tx
		.select({ affiliationId: affiliations.id, personId: people.id })
		.from(affiliations)
		.innerJoin(people, eq(people.id, affiliations.personId))
		.where(and(eq(affiliations.organizationId, organizationId), eq(people.emailHash, emailKey)))
		.limit(1);

	return row ?? null;
}

/** Коды справочника → идентификаторы; неопознанные возвращаются отдельно. */
async function resolveCatalogue(
	tx: Tx,
	data: ApplicationSubmittedData
): Promise<{ programIds: string[]; productIds: string[]; unknown: string[] }> {
	const unknown: string[] = [];
	const programIds: string[] = [];
	const productIds: string[] = [];

	if (data.programCodes.length > 0) {
		const rows = await tx
			.select({ id: programs.id, code: programs.code })
			.from(programs)
			.where(inArray(programs.code, data.programCodes));

		const found = new Map(rows.map((row) => [row.code, row.id]));

		for (const code of data.programCodes) {
			const id = found.get(code);

			if (id === undefined) {
				unknown.push(code);
			} else {
				programIds.push(id);
			}
		}
	}

	if (data.productCodes.length > 0) {
		const rows = await tx
			.select({ id: products.id, code: products.code })
			.from(products)
			.where(inArray(products.code, data.productCodes));

		const found = new Map(rows.map((row) => [row.code, row.id]));

		for (const code of data.productCodes) {
			const id = found.get(code);

			if (id === undefined) {
				unknown.push(code);
			} else {
				productIds.push(id);
			}
		}
	}

	return { programIds, productIds, unknown };
}

/**
 * Статус по передаче ложится на позицию договора, а не на взаимодействие и уж
 * тем более не на стадию: стадию меняет только действие человека. Позиции
 * берутся те, что уже выбраны взаимодействием и относятся к продуктам заявки —
 * чужие позиции того же договора остаются как были.
 */
async function applyTransferStatus(
	tx: Tx,
	interactionId: string,
	productIds: readonly string[],
	transferStatus: string | null
): Promise<boolean> {
	if (transferStatus === null || productIds.length === 0) {
		return false;
	}

	const rows = await tx
		.select({ id: contractItems.id })
		.from(interactionContractItems)
		.innerJoin(contractItems, eq(contractItems.id, interactionContractItems.contractItemId))
		.where(
			and(
				eq(interactionContractItems.interactionId, interactionId),
				inArray(contractItems.productId, [...productIds])
			)
		);

	if (rows.length === 0) {
		return false;
	}

	await tx
		.update(contractItems)
		.set({ transferStatus, updatedAt: sql`now()` })
		.where(
			inArray(
				contractItems.id,
				rows.map((row) => row.id)
			)
		);

	return true;
}

/** Согласие физлица: запись, а не галочка, — у неё есть версия текста и дата. */
async function recordApplicationConsent(
	ctx: ActorContext,
	tx: Tx,
	personId: string,
	consent: { given: boolean; at: string; policyVersion: string }
): Promise<void> {
	const existing = await tx
		.select({ id: consents.id })
		.from(consents)
		.where(and(eq(consents.personId, personId), eq(consents.textVersion, consent.policyVersion)))
		.limit(1);

	if (existing.length > 0) {
		return;
	}

	const [row] = await tx
		.insert(consents)
		.values({
			personId,
			basis: 'consent',
			textVersion: consent.policyVersion,
			givenAt: consent.at.slice(0, 10),
			recordedBy: ctx.user?.id ?? null
		})
		.returning({ id: consents.id });

	await recordAuditEvent(
		ctx,
		{
			type: 'people.consent_recorded',
			outcome: 'success',
			subject: { type: 'consent', id: row.id },
			details: { personId }
		},
		tx
	);
}

/** Контрагент заявки: найден или заведён. */
async function resolveCounterparty(
	ctx: ActorContext,
	tx: Tx,
	data: ApplicationSubmittedData
): Promise<Counterparty> {
	const applicant = data.applicant;

	if (applicant.kind === 'individual') {
		if (data.consent === null || !data.consent.given) {
			throw new ValidationError('Заявка физического лица без согласия не принимается', [
				'data.consent: без согласия на обработку персональных данных физическое лицо не заводится'
			]);
		}

		const found = await findIndividual(tx, data.contact.email.toLowerCase(), data.contact.phone);

		if (found !== null) {
			return {
				organizationId: found.id,
				personId: found.personId,
				needsReview: false,
				created: false
			};
		}

		const created = await createIndividual(ctx, tx, data);

		return {
			organizationId: created.organizationId,
			personId: created.personId,
			needsReview: false,
			created: true
		};
	}

	const found = await findOrganization(tx, applicant.inn, applicant.ogrn);

	if (found !== null) {
		return { organizationId: found.id, personId: null, needsReview: false, created: false };
	}

	const organization = await createOrganization(
		ctx,
		{
			kind: applicant.kind,
			educationLevel:
				applicant.kind === 'educational_institution' ? applicant.educationLevel : null,
			// С сайта приходит одно название; полным и кратким становится оно же,
			// пока сотрудник не уточнит реквизиты.
			legalName: applicant.name,
			shortName: applicant.name.slice(0, 200),
			inn: applicant.inn,
			kpp: null,
			ogrn: applicant.ogrn,
			region: null,
			website: null,
			notes: null,
			isActive: true,
			externalSource: null,
			externalId: null
		},
		tx
	);

	return {
		organizationId: organization.id,
		personId: null,
		// Ни ИНН, ни ОГРН: контрагента завели вслепую, и это честнее отказа —
		// заявка с сайта часто приходит без реквизитов, и терять её нельзя.
		needsReview: applicant.inn === null && applicant.ogrn === null,
		created: true
	};
}

type ApplyOutcome = {
	result: ExchangeResult;
	interactionId: string;
	organizationId: string;
	contactPersonId: string | null;
	processGroup: string;
	needsReview: boolean;
};

/** Обновление существующего взаимодействия: CMS — хозяин данных заявителя. */
async function updateExisting(
	ctx: ActorContext,
	tx: Tx,
	existing: { id: string; externalRevision: number | null; organizationId: string },
	data: ApplicationSubmittedData
): Promise<ApplyOutcome | null> {
	// Порядок определяется ревизией отправителя, а не временем: сравнение и
	// запись идут под блокировкой строки взаимодействия, иначе два параллельных
	// обновления оба сочли бы себя новее.
	const [locked] = await tx
		.select({ id: interactions.id, externalRevision: interactions.externalRevision })
		.from(interactions)
		.where(eq(interactions.id, existing.id))
		.for('update');

	if (locked.externalRevision !== null && locked.externalRevision >= data.revision) {
		return null;
	}

	const contact = await findContact(tx, existing.organizationId, data.contact.email);
	let contactPersonId = contact?.personId ?? null;

	if (contact === null) {
		const person = await createPerson(
			ctx,
			{
				lastName: data.contact.lastName,
				firstName: data.contact.firstName,
				middleName: data.contact.middleName,
				email: data.contact.email,
				phone: data.contact.phone,
				notes: null
			},
			tx
		);

		contactPersonId = person.id;

		await createAffiliation(
			ctx,
			{
				personId: person.id,
				organizationId: existing.organizationId,
				siteId: null,
				position: data.contact.position ?? DEFAULT_POSITION,
				roleKind: 'other',
				isPrimary: false,
				validFrom: formatIsoDay(),
				validTo: null,
				channel: null
			},
			tx
		);
	} else {
		// Контакты заявителя обновляются: их хозяин — сайт. Ответственный, стадия,
		// история и контрагент не трогаются никогда. Почта не переписывается: по
		// ней контакт и нашёлся, а телефон едет через `people/pii.ts` — шифртекст
		// и ключ сравнения одним оператором.
		await tx
			.update(people)
			.set({
				lastName: data.contact.lastName,
				firstName: data.contact.firstName,
				middleName: data.contact.middleName,
				...phoneColumns(data.contact.phone),
				updatedAt: sql`now()`
			})
			.where(eq(people.id, contact.personId));
	}

	const catalogue = await resolveCatalogue(tx, data);

	if (catalogue.programIds.length > 0) {
		await tx
			.insert(interactionPrograms)
			.values(
				catalogue.programIds.map((programId) => ({
					interactionId: existing.id,
					programId,
					programVersionId: null
				}))
			)
			.onConflictDoNothing();
	}

	if (catalogue.productIds.length > 0) {
		await tx
			.insert(interactionProducts)
			.values(catalogue.productIds.map((productId) => ({ interactionId: existing.id, productId })))
			.onConflictDoNothing();
	}

	const transferStatusApplied = await applyTransferStatus(
		tx,
		existing.id,
		catalogue.productIds,
		data.transferStatus
	);

	await tx
		.update(interactions)
		.set({ externalRevision: data.revision, updatedAt: sql`now()` })
		.where(eq(interactions.id, existing.id));

	const comment = intakeComment(data, catalogue.unknown, transferStatusApplied);

	if (comment !== '') {
		// Комментарий приписывается, а не затирает прежний: повтор ничего не
		// удаляет.
		await addComment(ctx, { interactionId: existing.id, body: comment }, tx);
	}

	const [{ personId }] = await tx
		.select({ personId: organizations.personId })
		.from(organizations)
		.where(eq(organizations.id, existing.organizationId))
		.limit(1);

	if (personId !== null && data.consent !== null && data.consent.given) {
		await recordApplicationConsent(ctx, tx, personId, data.consent);
	}

	const [group] = await tx
		.select({ key: processGroups.key })
		.from(interactions)
		.innerJoin(processGroups, eq(processGroups.id, interactions.processGroupId))
		.where(eq(interactions.id, existing.id))
		.limit(1);

	return {
		result: 'updated',
		interactionId: existing.id,
		organizationId: existing.organizationId,
		contactPersonId: contactPersonId,
		processGroup: group.key,
		needsReview: false
	};
}

/** Заведение взаимодействия по заявке. */
async function createFromApplication(
	ctx: ActorContext,
	tx: Tx,
	data: ApplicationSubmittedData,
	source: string,
	ownerUserId: string
): Promise<ApplyOutcome> {
	const counterparty = await resolveCounterparty(ctx, tx, data);

	// Назначение — до создания взаимодействия: область считается по действующим
	// назначениям, и без него сотрудник не увидел бы ни контрагента, ни заявку.
	await ensureResponsible(ctx, tx, counterparty.organizationId, ownerUserId);

	const contact = await findContact(tx, counterparty.organizationId, data.contact.email);
	let contactPersonId = contact?.personId ?? counterparty.personId;
	let affiliationId = contact?.affiliationId ?? null;

	if (contact === null) {
		const person = await createPerson(
			ctx,
			{
				lastName: data.contact.lastName,
				firstName: data.contact.firstName,
				middleName: data.contact.middleName,
				email: data.contact.email,
				phone: data.contact.phone,
				notes: null
			},
			tx
		);

		const affiliation = await createAffiliation(
			ctx,
			{
				personId: person.id,
				organizationId: counterparty.organizationId,
				siteId: null,
				position: data.contact.position ?? DEFAULT_POSITION,
				roleKind: 'other',
				isPrimary: true,
				validFrom: formatIsoDay(),
				validTo: null,
				channel: null
			},
			tx
		);

		affiliationId = affiliation.id;
		contactPersonId = person.id;
	}

	const catalogue = await resolveCatalogue(tx, data);

	// Группа процесса и её действующая редакция читаются внутри транзакции, под
	// разделяемой блокировкой группы: это делает `createInteractionIn`. Группа
	// выводится из вида контрагента — единственной таблицей соответствий.
	const interactionId = await createInteractionIn(ctx, tx, {
		title: interactionTitle(applicantName(data), data.interest),
		agreementPeriodStart: null,
		agreementPeriodEnd: null,
		academicPeriodStart: null,
		academicPeriodEnd: null,
		ownerUserId,
		parties: [
			{
				organizationId: counterparty.organizationId,
				partyRole: PARTY_ROLE_BY_KIND[data.applicant.kind],
				isPrimary: true,
				contactAffiliationId: affiliationId,
				siteIds: []
			}
		],
		programs: catalogue.programIds.map((programId) => ({ programId, programVersionId: null })),
		productIds: catalogue.productIds,
		externalSource: source,
		externalId: data.externalId
	});

	await tx
		.update(interactions)
		.set({ externalRevision: data.revision })
		.where(eq(interactions.id, interactionId));

	// Позиций договора у новой заявки, как правило, нет — и присланный статус
	// уходит в комментарий. Вызов всё равно стоит здесь: заявка приходит и по
	// взаимодействию, у которого договор уже подобран.
	const transferStatusApplied = await applyTransferStatus(
		tx,
		interactionId,
		catalogue.productIds,
		data.transferStatus
	);

	const comment = intakeComment(data, catalogue.unknown, transferStatusApplied);

	if (comment !== '') {
		await addComment(ctx, { interactionId, body: comment }, tx);
	}

	if (counterparty.personId !== null && data.consent !== null && data.consent.given) {
		await recordApplicationConsent(ctx, tx, counterparty.personId, data.consent);
	}

	return {
		result: 'created',
		interactionId,
		organizationId: counterparty.organizationId,
		contactPersonId,
		processGroup: PROCESS_GROUP_BY_APPLICANT[data.applicant.kind],
		needsReview: counterparty.needsReview
	};
}

/** Взаимодействие, которым уже стала заявка с этим ключом. */
async function findExisting(
	tx: Tx,
	source: string,
	externalId: string
): Promise<{ id: string; externalRevision: number | null; organizationId: string } | null> {
	const [row] = await tx
		.select({
			id: interactions.id,
			externalRevision: interactions.externalRevision
		})
		.from(interactions)
		.where(and(eq(interactions.externalSource, source), eq(interactions.externalId, externalId)))
		.limit(1);

	if (row === undefined) {
		return null;
	}

	const [primary] = await tx.execute<{ organization_id: string }>(
		sql`select organization_id from interaction_parties where interaction_id = ${row.id} and is_primary limit 1`
	);

	return {
		id: row.id,
		externalRevision: row.externalRevision,
		organizationId: primary.organization_id
	};
}

/**
 * Ответ на повтор: тот же, что был сохранён при первом приёме. `null` — этого
 * сообщения в журнале нет, значит, на уникальности разошлось что-то другое.
 */
async function savedResponse(
	instance: string,
	eventId: string,
	requestHash: string
): Promise<ApplicationIntakeResponse | null> {
	const [row] = await getDb()
		.select({
			requestHash: exchangeMessages.requestHash,
			responseBody: exchangeMessages.responseBody
		})
		.from(exchangeMessages)
		.where(
			and(
				eq(exchangeMessages.direction, 'inbound'),
				eq(exchangeMessages.system, 'cms'),
				eq(exchangeMessages.instance, instance),
				eq(exchangeMessages.eventId, eventId)
			)
		)
		.limit(1);

	if (row === undefined) {
		return null;
	}

	if (row.requestHash !== requestHash) {
		// Тот же `eventId` с другим телом — это другой запрос под старым именем.
		// Повторять его бессмысленно, поэтому отказ окончательный.
		throw new ConflictError(
			'Событие с этим eventId уже принято с другим телом: повтор обязан нести то же сообщение'
		);
	}

	if (row.responseBody === null) {
		// Строка есть, а ответа в ней нет: первый приём упал, не дойдя до записи
		// ответа. Отправитель повторит по своему расписанию, и тогда сообщение
		// либо найдёт готовый ответ, либо применится заново.
		throw new ConflictError('Сообщение с этим eventId ещё обрабатывается: повторите запрос позже');
	}

	const body = row.responseBody as ApplicationIntakeResponse;

	return { ...body, result: 'unchanged' };
}

export async function receiveApplication(
	ctx: ActorContext,
	message: ApplicationSubmittedMessage
): Promise<ApplicationIntakeResponse> {
	requirePermission(ctx, 'exchange.intake');

	if (!isSupportedSchemaVersion(message.schemaVersion)) {
		throw new ValidationError('Версия схемы сообщения не поддерживается', [
			`schemaVersion: ${message.schemaVersion} несовместима с ${EXCHANGE_SCHEMA_VERSION}`
		]);
	}

	const settings = await getExchangeSettings();

	// Экземпляр определяется подключением, а не полем из тела: иначе отправитель
	// переписал бы себе чужой экземпляр одной строкой в JSON и заявка со стенда
	// склеилась бы с боевой.
	if (message.source.instance !== settings.cms.instance) {
		throw new ForbiddenError(
			`Экземпляр «${message.source.instance}» не совпадает с подключением обмена`
		);
	}

	const declared = PROCESS_GROUP_BY_APPLICANT[message.data.applicant.kind];

	if (message.data.form !== declared) {
		throw new ValidationError('Форма заявки не совпадает с видом заявителя', [
			`data.form: прислано ${message.data.form}, по виду заявителя «${message.data.applicant.kind}» — ${declared}`
		]);
	}

	const source = externalSourceOf('cms', message.source.instance);
	const requestHash = hashMessage(message);
	const journal = journalPayload(message);

	const apply = async (): Promise<ApplicationIntakeResponse> =>
		// Одна область следа просмотра на всю сборку: заявка — это один запрос, и
		// событие о раскрытых контактах у него одно. Область снаружи транзакции
		// потому, что след пишется другим соединением.
		withPiiTrace(ctx, () =>
			withTransaction(ctx, async (tx) => {
				const [row] = await tx
					.insert(exchangeMessages)
					.values({
						direction: 'inbound',
						system: 'cms',
						instance: message.source.instance,
						eventType: message.eventType,
						eventId: message.eventId,
						externalId: message.data.externalId,
						state: 'processed',
						payload: journal,
						requestHash
					})
					// Строка о неудавшемся приёме занимает то же место в ключе
					// дедупликации, но повтором быть не перестаёт: отправитель вправе
					// прислать то же сообщение ещё раз, когда причину отказа поправят.
					// Поэтому такая строка переписывается, а закрытая — нет.
					.onConflictDoUpdate({
						target: [
							exchangeMessages.direction,
							exchangeMessages.system,
							exchangeMessages.instance,
							exchangeMessages.eventId
						],
						set: {
							eventType: message.eventType,
							externalId: message.data.externalId,
							state: 'processed',
							payload: journal,
							requestHash,
							lastError: null,
							responseBody: null,
							closedAt: null
						},
						setWhere: eq(exchangeMessages.state, 'failed')
					})
					.returning({ id: exchangeMessages.id });

				if (row === undefined) {
					// Конфликт с закрытой строкой: это сообщение уже принимали, и повтор
					// обязан получить тот же ответ, что и первый запрос.
					const replay = await savedResponse(message.source.instance, message.eventId, requestHash);

					if (replay === null) {
						throw new ConflictError(
							'Эту заявку прямо сейчас принимает другой запрос: повторите сообщение'
						);
					}

					return replay;
				}

				const existing = await findExisting(tx, source, message.data.externalId);

				// От чьего имени ведём заявку. У знакомого вуза уже есть действующий
				// ответственный — заявка по нему и ведётся от его имени: он её видит,
				// его область к ней применяется, его имя стоит в журнале. Настройка
				// «Ответственный за входящие» работает только там, где ответственного
				// ещё нет, — и тогда же он и назначается.
				const organizationId =
					existing?.organizationId ?? (await findApplicantOrganization(tx, message.data));
				const responsible =
					organizationId === null ? null : await currentResponsible(tx, organizationId);
				const ownerUserId =
					responsible ?? (await resolveIntakeOwner(tx, settings.cms.defaultOwnerUserId));
				const owner = await ownerActor(ctx, ownerUserId);

				let outcome: ApplyOutcome;
				let state: 'processed' | 'ignored_stale' = 'processed';

				if (existing === null) {
					outcome = await createFromApplication(owner, tx, message.data, source, ownerUserId);
				} else {
					const updated = await updateExisting(owner, tx, existing, message.data);

					if (updated === null) {
						state = 'ignored_stale';
						outcome = {
							result: 'unchanged',
							interactionId: existing.id,
							organizationId: existing.organizationId,
							contactPersonId: null,
							processGroup: message.data.form,
							needsReview: false
						};
					} else {
						outcome = updated;
					}
				}

				const response: ApplicationIntakeResponse = {
					schemaVersion: EXCHANGE_SCHEMA_VERSION,
					result: outcome.result,
					data: {
						externalId: message.data.externalId,
						interactionId: outcome.interactionId,
						organizationId: outcome.organizationId,
						contactPersonId: outcome.contactPersonId,
						applicationStatus: APPLICATION_STATUSES[0],
						processGroup: outcome.processGroup,
						needsReview: outcome.needsReview
					}
				};

				await tx
					.update(exchangeMessages)
					.set({
						state,
						interactionId: outcome.interactionId,
						responseBody: response,
						closedAt: sql`now()`
					})
					.where(eq(exchangeMessages.id, row.id));

				if (state === 'processed') {
					// Снимок статуса уходит на сайт после приёма — в этой же
					// транзакции, а отправляется после коммита (outbox).
					await enqueueApplicationStatus(tx, outcome.interactionId);
				}

				await recordAuditEvent(
					ctx,
					{
						type: 'exchange.message_received',
						outcome: 'success',
						subject: { type: 'interaction', id: outcome.interactionId },
						details: { exchangeMessageId: row.id, interactionId: outcome.interactionId }
					},
					tx
				);

				if (state === 'processed') {
					await recordAuditEvent(
						ctx,
						{
							type: 'integrations.application_received',
							outcome: 'success',
							subject: { type: 'interaction', id: outcome.interactionId },
							details: {
								interactionId: outcome.interactionId,
								organizationId: outcome.organizationId
							}
						},
						tx
					);
				}

				return response;
			})
		);

	/**
	 * Отказ доменной операции не должен уносить след сообщения.
	 *
	 * Транзакция приёма откатывается целиком — вместе со строкой журнала обмена,
	 * — и сообщение, которое приходило и было отвергнуто, исчезает бесследно:
	 * отправитель видит отказ, а на экране «Внешние системы» нет ничего, и
	 * разбирать нечего. Поэтому след пишется **после отката**, своей
	 * транзакцией, и несёт причину словами.
	 */
	const recordRefusal = async (reason: string): Promise<void> => {
		await getDb()
			.insert(exchangeMessages)
			.values({
				direction: 'inbound',
				system: 'cms',
				instance: message.source.instance,
				eventType: message.eventType,
				eventId: message.eventId,
				externalId: message.data.externalId,
				state: 'failed',
				payload: journal,
				requestHash,
				lastError: reason,
				closedAt: sql`now()`
			})
			// Строка того же сообщения уже есть — значит, его принимали раньше, и
			// исход той попытки важнее нашего отказа.
			.onConflictDoNothing();
	};

	const run = async (): Promise<ApplicationIntakeResponse> => {
		try {
			return await apply();
		} catch (error) {
			if (!isUniqueViolation(error)) {
				throw error;
			}

			// Это сообщение уже принимали: повтор отдаёт сохранённый ответ и ничего
			// не применяет заново.
			const replay = await savedResponse(message.source.instance, message.eventId, requestHash);

			if (replay !== null) {
				return replay;
			}

			// Разошлось другое ограничение: пока шла наша транзакция, соседний запрос
			// завёл ту же заявку (внешняя ссылка) или того же контрагента (ИНН). Наша
			// откатилась целиком — повторяем её один раз: теперь заявка найдётся, и
			// сообщение применится обновлением.
			try {
				return await apply();
			} catch (retried) {
				if (!isUniqueViolation(retried)) {
					throw retried;
				}

				throw new ConflictError(
					'Эту заявку прямо сейчас принимает другой запрос: повторите сообщение'
				);
			}
		}
	};

	try {
		return await run();
	} catch (error) {
		// Предметный отказ объясним словами, и эти слова читает сотрудник. Всё
		// остальное — наша поломка: её разбирают по логу, а не по журналу обмена,
		// и подсовывать туда текст неизвестного происхождения незачем.
		if (error instanceof AppError) {
			await recordRefusal(error.message);
		}

		throw error;
	}
}
