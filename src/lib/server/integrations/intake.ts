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
 *
 * Сборка идёт одной транзакцией. Иначе три запроса с одним идентификатором,
 * посланные одновременно, оставляли бы в справочнике три организации и трёх
 * человек, из которых двое ни к чему не относятся: внешняя ссылка отсекает
 * только само взаимодействие, и отсекает она его последней. Проигравший в
 * гонке откатывается целиком и отвечает тем же, чем ответил бы обычный
 * повтор, — прежней записью и `created: false`.
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
import { withTransaction, type Tx } from '../db/transaction';
import { createAffiliation, createOrganization, createPerson } from '../directory/write';
import { findOrganizationByInn } from '../directory/read';
import { ConflictError, ValidationError } from '../errors';
import { createInteractionIn } from '../interactions/write';
import { withPiiTrace } from '../people/pii-trace';
import { requirePermission } from '../rbac';
import { addComment } from '../stages/commands';
import { getDefaultRoute } from '../stages/routes';

/** Внешняя система, из которой приходят заявки. */
const EXTERNAL_SOURCE = 'site';

/** Код PostgreSQL «нарушена уникальность». */
const UNIQUE_VIOLATION = '23505';

/**
 * Разошлись ли две одновременные заявки на уникальности.
 *
 * Ограничений тут два, и какое сработает — зависит от того, прислал ли сайт
 * ИНН: внешняя ссылка взаимодействия (`interactions_external_ref_key`) или ИНН
 * организации (`organizations_inn_key`, его сервис справочника уже перевёл в
 * `ConflictError`). Что именно сработало — не важно: важно, что запись,
 * которую мы заводили, завёл кто-то другой. Сам по себе этот признак ничего не
 * решает — ответ повтором даётся только после того, как найдено готовое
 * взаимодействие с тем же идентификатором заявки.
 */
function isUniqueRace(error: unknown): boolean {
	if (error instanceof ConflictError) {
		return true;
	}

	let current: unknown = error;

	while (current instanceof Error) {
		if ((current as { code?: unknown }).code === UNIQUE_VIOLATION) {
			return true;
		}

		current = current.cause;
	}

	return false;
}

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
async function findContact(tx: Tx, organizationId: string, email: string): Promise<string | null> {
	const [row] = await tx
		.select({ id: affiliations.id })
		.from(affiliations)
		.innerJoin(people, eq(people.id, affiliations.personId))
		.where(and(eq(affiliations.organizationId, organizationId), eq(people.email, email)))
		.limit(1);

	return row?.id ?? null;
}

async function assertProgramExists(tx: Tx, programId: string): Promise<void> {
	const [row] = await tx
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

async function assertProductExists(tx: Tx, productId: string): Promise<void> {
	const [row] = await tx
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

	// Маршрут по умолчанию читается до транзакции: он опубликован задолго до
	// заявки, и держать его чтение внутри операции незачем.
	const route = await getDefaultRoute(ctx);

	try {
		// Одна область следа просмотра на всю сборку: заявка — это один запрос, и
		// событие о раскрытых контактах у него одно, а не по событию на каждую
		// запись справочника, которую она завела. Область снаружи транзакции ещё и
		// потому, что след пишется другим соединением: открытая транзакция ждала
		// бы его из пула, не отпуская своего.
		return await withPiiTrace(ctx, () =>
			withTransaction(ctx, async (tx) => {
				if (input.programId !== null) {
					await assertProgramExists(tx, input.programId);
				}

				if (input.productId !== null) {
					await assertProductExists(tx, input.productId);
				}

				// Сверка только по ИНН: по названию организации не объединяются —
				// «Сибирский институт» и «СИВТ» одно и то же лицо или два разных, знает
				// человек, а не строка из формы.
				const found =
					input.organization.inn === null
						? null
						: await findOrganizationByInn(ctx, input.organization.inn, tx);

				const organizationId =
					found?.id ??
					(
						await createOrganization(
							ctx,
							{
								kind: input.organization.kind,
								educationLevel: input.organization.educationLevel,
								// С сайта приходит одно название; полным и кратким становится оно
								// же, пока сотрудник не уточнит реквизиты.
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
							},
							tx
						)
					).id;

				let affiliationId = await findContact(tx, organizationId, input.contact.email);

				if (affiliationId === null) {
					const person = await createPerson(
						ctx,
						{
							lastName: input.contact.lastName,
							firstName: input.contact.firstName,
							middleName: input.contact.middleName,
							email: input.contact.email,
							phone: input.contact.phone,
							notes: null
						},
						tx
					);

					const affiliation = await createAffiliation(
						ctx,
						{
							personId: person.id,
							organizationId,
							siteId: null,
							position: input.contact.position ?? DEFAULT_POSITION,
							roleKind: 'other',
							isPrimary: true,
							validFrom: formatIsoDay(),
							validTo: null,
							channel: null
						},
						tx
					);

					affiliationId = affiliation.id;
				}

				const interactionId = await createInteractionIn(ctx, tx, {
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
						input.programId === null
							? []
							: [{ programId: input.programId, programVersionId: null }],
					productIds: input.productId === null ? [] : [input.productId],
					externalSource: EXTERNAL_SOURCE,
					externalId: input.externalId
				});

				const comment = intakeComment(input);

				if (comment !== null) {
					await addComment(ctx, { interactionId, body: comment }, tx);
				}

				await recordAuditEvent(
					ctx,
					{
						type: 'integrations.application_received',
						outcome: 'success',
						subject: { type: 'interaction', id: interactionId },
						details: { interactionId, organizationId }
					},
					tx
				);

				return { interactionId, created: true };
			})
		);
	} catch (error) {
		if (!isUniqueRace(error)) {
			throw error;
		}

		// Пока шла наша транзакция, эту же заявку завёл соседний запрос: наша
		// откатилась целиком, а ответ обязан быть тем же, что у обычного повтора.
		const created = await findExistingInteraction(input.externalId);

		// Взаимодействия нет — значит, столкнулись не две одинаковые заявки, а
		// что-то другое (например, ИНН занят организацией из чужой заявки).
		// Такой отказ уходит наверх как есть: повтором он не является.
		if (created === null) {
			throw error;
		}

		return { interactionId: created, created: false };
	}
}
