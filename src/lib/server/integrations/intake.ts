/**
 * Приём заявки с сайта.
 *
 * Заявка не заводит в системе третью сущность рядом с организацией и
 * взаимодействием. Она сразу становится тем, чем является: обращением
 * организации, которое кто-то должен вести. Поэтому здесь только сборка —
 * найти или завести организацию, контактное лицо и его роль, — а дальше
 * работают обычные сервисы справочника и взаимодействий, с их правами,
 * проверками и журналом.
 *
 * Повтор не создаёт дубля: у взаимодействия есть внешняя ссылка
 * (`external_source = 'site'`, `external_id` — идентификатор заявки), и на ней
 * стоит частичная уникальность. Повторный запрос с тем же идентификатором
 * возвращает ту же запись и `created: false`.
 */
import { and, eq } from 'drizzle-orm';
import type { ApplicationIntakeInput, ApplicationResult } from '$lib/contracts/integrations';
import type { PartyRole } from '$lib/contracts/interactions';
import type { OrganizationKind } from '$lib/contracts/directory';
import { formatIsoDay } from '$lib/format';
import type { ActorContext } from '../actor';
import { recordAuditEvent } from '../audit';
import { getDb } from '../db';
import { affiliations, interactions, people, products, programs } from '../db/schema';
import { createAffiliation, createOrganization, createPerson } from '../directory/write';
import { findOrganizationByInn } from '../directory/read';
import { ValidationError } from '../errors';
import { createInteraction } from '../interactions/write';
import { requirePermission } from '../rbac';
import { addComment } from '../stages/commands';
import { getDefaultRoute } from '../stages/routes';

/** Внешняя система, из которой приходят заявки. */
const EXTERNAL_SOURCE = 'site';

/**
 * Должность контактного лица, когда сайт её не спросил. Это не выдуманные
 * данные, а то, чем человек является в этой записи: он отозвался на форму и
 * ждёт ответа.
 */
const DEFAULT_POSITION = 'Контактное лицо (заявка с сайта)';

/** Кем организация участвует во взаимодействии — по её виду в справочнике. */
const PARTY_ROLE_BY_KIND: Record<OrganizationKind, PartyRole> = {
	educational_institution: 'educational_institution',
	customer_company: 'customer',
	operator: 'operator'
};

/** Взаимодействие, которым уже стала заявка с этим идентификатором. */
async function findExistingInteraction(externalId: string): Promise<string | null> {
	// Область доступа здесь не применяется намеренно: заявка адресуется своим
	// идентификатором, и повтор обязан вернуть ту же запись, а не наткнуться на
	// нарушение уникальности, если область ключа с тех пор сузилась.
	const [row] = await getDb()
		.select({ id: interactions.id })
		.from(interactions)
		.where(
			and(eq(interactions.externalSource, EXTERNAL_SOURCE), eq(interactions.externalId, externalId))
		)
		.limit(1);

	return row?.id ?? null;
}

/** Человек, который уже числится в этой организации под тем же адресом почты. */
async function findContact(organizationId: string, email: string): Promise<string | null> {
	const [row] = await getDb()
		.select({ id: affiliations.id })
		.from(affiliations)
		.innerJoin(people, eq(people.id, affiliations.personId))
		.where(and(eq(affiliations.organizationId, organizationId), eq(people.email, email)))
		.limit(1);

	return row?.id ?? null;
}

async function assertProgramExists(programId: string): Promise<void> {
	const [row] = await getDb()
		.select({ id: programs.id })
		.from(programs)
		.where(eq(programs.id, programId))
		.limit(1);

	if (row === undefined) {
		throw new ValidationError('Программа не найдена', [
			'Укажите идентификатор программы из справочника или оставьте поле пустым'
		]);
	}
}

async function assertProductExists(productId: string): Promise<void> {
	const [row] = await getDb()
		.select({ id: products.id })
		.from(products)
		.where(eq(products.id, productId))
		.limit(1);

	if (row === undefined) {
		throw new ValidationError('Продукт не найден', [
			'Укажите идентификатор продукта из справочника или оставьте поле пустым'
		]);
	}
}

/** Название взаимодействия: по нему заявку узнают в списке. */
function interactionTitle(organizationName: string, interest: string | null): string {
	const base = `Заявка с сайта: ${organizationName}`;
	const full = interest === null ? base : `${base} — ${interest}`;

	return full.slice(0, 300);
}

/** Первый комментарий: то, что написал заявитель, слово в слово. */
function intakeComment(input: ApplicationIntakeInput): string | null {
	const lines: string[] = [];

	if (input.interest !== null) {
		lines.push(`Интересует: ${input.interest}`);
	}

	if (input.comment !== null) {
		lines.push(input.comment);
	}

	return lines.length === 0 ? null : lines.join('\n\n').slice(0, 4000);
}

/**
 * Приём заявки. Ответственным становится владелец ключа, которым её принесли:
 * у заявки, у которой нет ответственного, нет и срока — она просто лежит.
 */
export async function receiveApplication(
	ctx: ActorContext,
	input: ApplicationIntakeInput
): Promise<ApplicationResult> {
	requirePermission(ctx, 'interactions.write');

	const ownerUserId = ctx.user?.id ?? null;

	if (ownerUserId === null) {
		throw new ValidationError('Заявку принимает ключ доступа', [
			'У ключа должен быть владелец: он и станет ответственным за взаимодействие'
		]);
	}

	const existing = await findExistingInteraction(input.externalId);

	if (existing !== null) {
		return { interactionId: existing, created: false };
	}

	if (input.programId !== null) {
		await assertProgramExists(input.programId);
	}

	if (input.productId !== null) {
		await assertProductExists(input.productId);
	}

	// Сверка только по ИНН: по названию организации не объединяются — «Сибирский
	// институт» и «СИВТ» одно и то же лицо или два разных, знает человек, а не
	// строка из формы.
	const found =
		input.organization.inn === null
			? null
			: await findOrganizationByInn(ctx, input.organization.inn);

	const organizationId =
		found?.id ??
		(
			await createOrganization(ctx, {
				kind: input.organization.kind,
				educationLevel: input.organization.educationLevel,
				// С сайта приходит одно название; полным и кратким становится оно же,
				// пока сотрудник не уточнит реквизиты.
				legalName: input.organization.name,
				shortName: input.organization.name.slice(0, 200),
				inn: input.organization.inn,
				kpp: null,
				ogrn: null,
				region: null,
				website: null,
				notes: null,
				isActive: true,
				externalSource: null,
				externalId: null
			})
		).id;

	let affiliationId = await findContact(organizationId, input.contact.email);

	if (affiliationId === null) {
		const person = await createPerson(ctx, {
			lastName: input.contact.lastName,
			firstName: input.contact.firstName,
			middleName: input.contact.middleName,
			email: input.contact.email,
			phone: input.contact.phone,
			notes: null
		});

		const affiliation = await createAffiliation(ctx, {
			personId: person.id,
			organizationId,
			siteId: null,
			position: input.contact.position ?? DEFAULT_POSITION,
			roleKind: 'other',
			isPrimary: true,
			validFrom: formatIsoDay(),
			validTo: null,
			channel: null
		});

		affiliationId = affiliation.id;
	}

	const route = await getDefaultRoute(ctx);

	const interaction = await createInteraction(ctx, {
		title: interactionTitle(input.organization.name, input.interest),
		routeId: route.id,
		agreementPeriodStart: null,
		agreementPeriodEnd: null,
		academicPeriodStart: null,
		academicPeriodEnd: null,
		ownerUserId,
		parties: [
			{
				organizationId,
				partyRole: PARTY_ROLE_BY_KIND[input.organization.kind],
				isPrimary: true,
				contactAffiliationId: affiliationId,
				siteIds: []
			}
		],
		programs:
			input.programId === null ? [] : [{ programId: input.programId, programVersionId: null }],
		productIds: input.productId === null ? [] : [input.productId],
		externalSource: EXTERNAL_SOURCE,
		externalId: input.externalId
	});

	const comment = intakeComment(input);

	if (comment !== null) {
		await addComment(ctx, { interactionId: interaction.id, body: comment });
	}

	await recordAuditEvent(ctx, {
		type: 'integrations.application_received',
		outcome: 'success',
		subject: { type: 'interaction', id: interaction.id },
		details: { interactionId: interaction.id, organizationId }
	});

	return { interactionId: interaction.id, created: true };
}
