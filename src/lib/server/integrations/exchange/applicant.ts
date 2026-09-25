/**
 * Входящий с сайта человек и дело по нему: общее у приёма заявки и загрузки
 * оплат.
 *
 * Оба пути приносят одно и то же — физлицо с ФИО, почтой и телефоном и номер
 * заказа сайта — и обязаны прийти к одним и тем же записям: тот же человек
 * узнаётся по тем же ключам сравнения, дело с тем же номером находится по той
 * же внешней ссылке, а ведёт его тот же сотрудник по тем же правилам. Поэтому
 * эти правила живут здесь один раз, а `intake.ts` и `payments.ts` их только
 * зовут.
 */
import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import type { ConsentBasis } from '$lib/contracts/directory';
import { formatIsoDay } from '$lib/format';
import type { ActorContext } from '../../actor';
import { recordAuditEvent } from '../../audit';
import { loadSessionUser } from '../../auth/session';
import { getConfig } from '../../config';
import {
	affiliations,
	consents,
	interactions,
	organizationResponsibles,
	organizations,
	people,
	stageEntries,
	users,
	workspaces
} from '../../db/schema';
import type { Tx } from '../../db/transaction';
import { createAffiliation, createPerson } from '../../directory/write';
import { ValidationError } from '../../errors';
import { formatPhone, hashEmail, hashPhone } from '../../people/pii';
import { mayWorkIn } from '../../rbac/workspaces';
import { markChecklistItemIn } from '../../stages/commands';

/** Код PostgreSQL «нарушена уникальность». */
const UNIQUE_VIOLATION = '23505';

export function isUniqueViolation(error: unknown): boolean {
	let current: unknown = error;

	while (current instanceof Error) {
		if ((current as { code?: unknown }).code === UNIQUE_VIOLATION) {
			return true;
		}

		current = current.cause;
	}

	return false;
}

/** Физлицо, которое приносит сайт: ФИО и контакты. */
export type ApplicantPerson = {
	lastName: string;
	firstName: string;
	middleName: string | null;
	email: string;
	phone: string | null;
};

/** Имя контрагента-физлица: ФИО одной строкой, отдельной копии не появляется. */
export function applicantPersonName(person: ApplicantPerson): string {
	return [person.lastName, person.firstName, person.middleName]
		.filter((part) => part !== null && part !== '')
		.join(' ');
}

/**
 * Сотрудник, который принимает входящие с сайта.
 *
 * Настройка не задана — на демонстрационном стенде берём демонстрационного
 * менеджера, если он в системе есть: стенд обязан принимать заявку сразу после
 * сида, не требуя похода в настройки. Нет и его — заявка отвергается с
 * указанием, что настроить: тихо назначить робота хуже, чем отказать.
 */
export async function resolveIntakeOwner(tx: Tx, configured: string | null): Promise<string> {
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

	// Право взять демонстрационную запись даёт режим установки, а не наличие
	// такой записи в базе: у заказчика сид не запускают, и сегодня отказ выходит
	// внятным только поэтому. Правило должно читаться из кода, а не из порядка
	// развёртывания.
	const [demo] = getConfig().DEMO_MODE
		? await tx
				.select({ id: users.id })
				.from(users)
				.where(and(eq(users.isDemo, true), eq(users.isActive, true), eq(users.roleId, 'manager')))
				.orderBy(users.email)
				.limit(1)
		: [];

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
 * заводятся записи. Так в журнале видно и живого ответственного, и того, кто
 * принёс данные, а права и область считаются по обычным правилам.
 */
export async function ownerActor(ctx: ActorContext, ownerUserId: string): Promise<ActorContext> {
	const owner = await loadSessionUser(ownerUserId);

	if (owner === null) {
		throw new ValidationError('Ответственный за входящие заявки недоступен', [
			'Учётная запись ответственного выключена: заявку некому вести'
		]);
	}

	return { ...ctx, user: owner, scope: owner.scope };
}

/**
 * Действующий ответственный за контрагента; `null` — его нет.
 *
 * Именно от его имени и ведётся входящее по знакомому контрагенту. Иначе выходит
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
 * От чьего имени ведём входящее. У знакомого контрагента уже есть действующий
 * ответственный — входящее по нему и ведётся от его имени: он его видит, его
 * область к нему применяется, его имя стоит в журнале. Настройка
 * «Ответственный за входящие» работает только там, где ответственного ещё нет, —
 * и тогда же он и назначается.
 *
 * Пространство — граница доступа: от имени сотрудника вне пространства дело не
 * провести, он не видит записи, которую ему заводят. Такой ответственный за
 * контрагента уступает сотруднику из настройки, а если вне пространства и тот —
 * входящее отклоняется с причиной.
 */
export async function chooseIntakeOwner(
	tx: Tx,
	options: {
		organizationId: string | null;
		workspace: { id: string; name: string };
		configuredOwnerUserId: string | null;
	}
): Promise<string> {
	const responsible =
		options.organizationId === null ? null : await currentResponsible(tx, options.organizationId);
	const ownerUserId =
		responsible !== null && (await mayWorkIn(tx, responsible, options.workspace.id))
			? responsible
			: await resolveIntakeOwner(tx, options.configuredOwnerUserId);

	if (!(await mayWorkIn(tx, ownerUserId, options.workspace.id))) {
		throw new ValidationError('Заявку некому вести в её пространстве', [
			`Ни ответственный за вуз, ни сотрудник из настройки «Ответственный за входящие» не включены в пространство «${options.workspace.name}». Включите сотрудника в разделе «Настройки → Пространства» и повторите сообщение`
		]);
	}

	return ownerUserId;
}

/** Пункт чек-листа, которым процесс отмечает, что у дела есть ответственный. */
const OWNER_ASSIGNED_CHECKLIST_KEY = 'owner_assigned';

/**
 * Отметка «Назначен ответственный» у дела, которое входящее с сайта только что
 * завело: ответственный назначен тем же входящим, и оставлять пункт сотруднику
 * значило бы просить его подтвердить то, что система сделала сама. Отмечается в
 * транзакции вызывающего и только там, где процесс объявил такой пункт на
 * открытой стадии: у процесса без него отмечать нечего.
 */
export async function markOwnerAssigned(
	ctx: ActorContext,
	tx: Tx,
	interactionId: string
): Promise<void> {
	const [entry] = await tx
		.select({ snapshot: stageEntries.stageSnapshot, checklistState: stageEntries.checklistState })
		.from(stageEntries)
		.where(and(eq(stageEntries.interactionId, interactionId), isNull(stageEntries.leftAt)))
		.limit(1);

	if (
		entry === undefined ||
		entry.checklistState[OWNER_ASSIGNED_CHECKLIST_KEY] === true ||
		!entry.snapshot.checklist.some((item) => item.key === OWNER_ASSIGNED_CHECKLIST_KEY)
	) {
		return;
	}

	await markChecklistItemIn(ctx, tx, interactionId, OWNER_ASSIGNED_CHECKLIST_KEY);
}

/**
 * Контрагент-физлицо: по ключу сравнения почты, затем по ключу телефона.
 *
 * Не по самим контактам: в базе они лежат шифртекстом, и у одного и того же
 * адреса он каждый раз новый. Нормализацию (регистр почты, вид записи номера)
 * знает `people/pii.ts`, и она здесь одна на обе стороны сравнения.
 */
export async function findIndividual(
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
 * появляется только вместе с входящим с сайта. ФИО, контакты и согласие ложатся
 * в `people`, где работают маскирование, срок хранения и обезличивание; копии
 * ФИО в полях организации не появляется — название и есть ФИО.
 *
 * Роль этого человека в его собственной организации заводится отдельно
 * ({@link ensureOwnAffiliation}): контактное лицо здесь — он сам, и второй
 * записи `people` о том же человеке не появляется.
 */
async function createIndividual(
	ctx: ActorContext,
	tx: Tx,
	person: ApplicantPerson
): Promise<{ organizationId: string; personId: string }> {
	const created = await createPerson(
		ctx,
		{
			lastName: person.lastName,
			firstName: person.firstName,
			middleName: person.middleName,
			email: person.email,
			phone: person.phone === null ? null : formatPhone(person.phone),
			notes: null
		},
		tx
	);

	const name = applicantPersonName(person);
	const [organization] = await tx
		.insert(organizations)
		.values({
			kind: 'individual',
			educationLevel: null,
			legalName: name,
			shortName: name.slice(0, 200),
			personId: created.id,
			isActive: true
		})
		.returning({ id: organizations.id });

	await recordAuditEvent(
		ctx,
		{
			type: 'organizations.created',
			outcome: 'success',
			subject: { type: 'organization', id: organization.id },
			details: { personId: created.id }
		},
		tx
	);

	return { organizationId: organization.id, personId: created.id };
}

/** Контрагент-физлицо: найден по ключам сравнения или заведён. */
export async function findOrCreateIndividual(
	ctx: ActorContext,
	tx: Tx,
	person: ApplicantPerson
): Promise<{ organizationId: string; personId: string | null; created: boolean }> {
	const found = await findIndividual(tx, person.email, person.phone);

	if (found !== null) {
		return { organizationId: found.id, personId: found.personId, created: false };
	}

	const created = await createIndividual(ctx, tx, person);

	return { ...created, created: true };
}

/**
 * Открытая роль человека в организации; нет — заводится.
 *
 * У физлица контактное лицо — он сам, и роль в собственной организации у него
 * либо уже есть (нашёлся по телефону, а почта новая; пришёл второй раз), либо
 * появляется здесь — второй такой же не нужно.
 */
export async function ensureOwnAffiliation(
	ctx: ActorContext,
	tx: Tx,
	options: { organizationId: string; personId: string; position: string; isPrimary: boolean }
): Promise<string> {
	const [role] = await tx
		.select({ id: affiliations.id })
		.from(affiliations)
		.where(
			and(
				eq(affiliations.personId, options.personId),
				eq(affiliations.organizationId, options.organizationId),
				isNull(affiliations.validTo)
			)
		)
		.limit(1);

	if (role !== undefined) {
		return role.id;
	}

	const affiliation = await createAffiliation(
		ctx,
		{
			personId: options.personId,
			organizationId: options.organizationId,
			siteId: null,
			position: options.position,
			roleKind: 'other',
			isPrimary: options.isPrimary,
			validFrom: formatIsoDay(),
			validTo: null,
			channel: null
		},
		tx
	);

	return affiliation.id;
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
export async function ensureResponsible(
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

/** Взаимодействие, которым уже стал заказ сайта с этим ключом. */
export async function findExisting(
	tx: Tx,
	source: string,
	externalId: string
): Promise<{
	id: string;
	externalRevision: number | null;
	organizationId: string;
	workspaceId: string;
	workspaceName: string;
} | null> {
	const [row] = await tx
		.select({
			id: interactions.id,
			externalRevision: interactions.externalRevision,
			workspaceId: interactions.workspaceId,
			workspaceName: workspaces.name
		})
		.from(interactions)
		.innerJoin(workspaces, eq(workspaces.id, interactions.workspaceId))
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
		organizationId: primary.organization_id,
		workspaceId: row.workspaceId,
		workspaceName: row.workspaceName
	};
}

/**
 * Основание обработки данных физлица: запись, а не галочка, — у неё есть вид,
 * версия текста и дата. Заявка приносит согласие (`consent`), оплата —
 * заключённый договор-оферту (`contract`). Запись с той же версией текста
 * второй раз не заводится.
 */
export async function recordApplicationConsent(
	ctx: ActorContext,
	tx: Tx,
	personId: string,
	consent: { basis: ConsentBasis; textVersion: string; givenAt: string }
): Promise<void> {
	const existing = await tx
		.select({ id: consents.id })
		.from(consents)
		.where(and(eq(consents.personId, personId), eq(consents.textVersion, consent.textVersion)))
		.limit(1);

	if (existing.length > 0) {
		return;
	}

	const [row] = await tx
		.insert(consents)
		.values({
			personId,
			basis: consent.basis,
			textVersion: consent.textVersion,
			givenAt: consent.givenAt,
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
