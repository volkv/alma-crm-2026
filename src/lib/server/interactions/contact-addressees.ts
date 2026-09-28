/**
 * Кому из контактов основной стороны дела можно написать письмо: описание
 * программ (`program-offer.ts`) и приглашение на встречу (модуль «Встречи»)
 * спрашивают одно и то же и должны отвечать одинаково.
 *
 * Адреса в браузер не уходят и из браузера не принимаются. Окно видит контакты
 * именем и должностью и присылает идентификаторы ролей; сервер сверяет их с
 * контактами основной стороны этого дела и подставляет адреса сам — по
 * действующему праву на контакты людей, а не по тому, что было на экране.
 * Чтение идёт через справочник (`listAffiliations`) и оставляет след
 * просмотра персональных данных, как любое другое.
 */
import type { AuditEventType } from '$lib/contracts/audit';
import type { AffiliationView } from '$lib/contracts/directory';
import type { InteractionView } from '$lib/contracts/interactions';
import { formatDate, formatIsoDay } from '$lib/format';
import type { ActorContext } from '../actor';
import { listAffiliations } from '../directory/read';
import { ValidationError } from '../errors';
import { LEARNER_POSITION } from '../integrations/exchange/roster';
import { can, requirePermission } from '../rbac';

export function contactPersonName(person: AffiliationView['person']): string {
	return [person.lastName, person.firstName, person.middleName].filter(Boolean).join(' ');
}

/** Обращение в письме — по имени и отчеству, как принято в деловой переписке. */
export function contactGreetingName(person: AffiliationView['person']): string | null {
	const name = [person.firstName, person.middleName].filter(Boolean).join(' ').trim();

	return name === '' ? null : name;
}

/**
 * Почему этому контакту письмо не отправить; `null` — можно. Роль, которая уже
 * закончилась, — человек там больше не работает, и письмо по делу ему не
 * адресуется, даже если он записан контактным лицом дела.
 */
export function contactUnavailableReason(contact: AffiliationView, today: string): string | null {
	if (contact.person.anonymizedAt !== null) {
		return 'Данные человека обезличены';
	}

	if (contact.validTo !== null && contact.validTo < today) {
		return `Роль закончилась ${formatDate(contact.validTo)}`;
	}

	if (contact.person.contactsMasked) {
		return 'Почта скрыта: нет права видеть контакты людей';
	}

	if (contact.person.email === null) {
		return 'Почта не указана в карточке человека';
	}

	return null;
}

function primaryParty(interaction: InteractionView) {
	return interaction.parties.find((party) => party.isPrimary) ?? null;
}

/**
 * Слушатель учебной группы — связь, которую завёл список группы, а не
 * представитель вуза: письма по делу ему не адресуются, а в списке
 * получателей десятки таких строк заслонили бы тех, с кем ведут переговоры.
 * Контактное лицо дела остаётся всегда — его выбрал человек.
 */
function isCaseAddressee(contact: AffiliationView, caseContactId: string | null): boolean {
	return (
		contact.id === caseContactId ||
		!(contact.roleKind === 'other' && contact.position === LEARNER_POSITION)
	);
}

/** Контакты основной стороны, кому пишут по делу; `null` — читать их не из чего или нечем (права). */
export async function readCaseContacts(
	ctx: ActorContext,
	interaction: InteractionView
): Promise<AffiliationView[] | null> {
	const primary = primaryParty(interaction);

	if (primary === null || !can(ctx, 'people.read')) {
		return null;
	}

	const contacts = await listAffiliations(ctx, primary.organizationId);

	return contacts.filter((contact) => isCaseAddressee(contact, primary.contactAffiliationId));
}

/** Выбранный контакт с адресом, если писать ему можно, или причиной, почему нельзя. */
export type CaseContactAddressee =
	| { contact: AffiliationView; email: string; reason: null }
	| { contact: AffiliationView; email: null; reason: string };

/**
 * Выбранные в окне контакты — только контакты основной стороны этого дела,
 * прочитанные сейчас, с правом на их контакты. Чужой идентификатор — отказ
 * всей отправки, а не молчаливый пропуск: окно показывало одно, а ушло бы
 * другое. Чей адрес закрыт, решает вызывающий: описание программ отказывает
 * целиком, приглашение называет человека в повестке без адреса.
 */
export async function resolveCaseContacts(
	ctx: ActorContext,
	interaction: InteractionView,
	contactIds: readonly string[],
	auditType: AuditEventType
): Promise<CaseContactAddressee[]> {
	const auditDenied = {
		type: auditType,
		subject: { type: 'interaction', id: interaction.id }
	} as const;

	await requirePermission(ctx, 'people.read', auditDenied);
	await requirePermission(ctx, 'people.read_pii', auditDenied);

	const contacts = (await readCaseContacts(ctx, interaction)) ?? [];
	const byId = new Map(contacts.map((contact) => [contact.id, contact]));
	const today = formatIsoDay();

	return [...new Set(contactIds)].map((id): CaseContactAddressee => {
		const contact = byId.get(id);

		if (contact === undefined) {
			throw new ValidationError('Получатель не найден среди контактных лиц основной стороны дела');
		}

		const reason = contactUnavailableReason(contact, today);

		return reason === null && contact.person.email !== null
			? { contact, email: contact.person.email, reason: null }
			: { contact, email: null, reason: reason ?? 'Почта не указана в карточке человека' };
	});
}
