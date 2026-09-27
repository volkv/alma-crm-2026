/**
 * Контрагент, которого нет в справочнике, — заведённый прямо из формы дела.
 *
 * Организацию заводит сервис справочника (`createOrganization`) — тем же
 * путём, что форма «Организации → Новая»: те же проверки ИНН, то же
 * назначение автора ответственным. Физическое лицо справочник формой не
 * заводит: его строка неотделима от человека, и появляется она тем же
 * способом, что у заявки с сайта, — человек, организация вида «физлицо» и его
 * собственная роль в ней одной операцией.
 */
import type { LookupOption } from '$lib/contracts/directory';
import type { ActorContext } from '../actor';
import { withTransaction } from '../db/transaction';
import { pickOrganization } from '../directory/read';
import { ConflictError, ForbiddenError } from '../errors';
import {
	ensureOwnAffiliation,
	ensureResponsible,
	findOrCreateIndividual,
	type ApplicantPerson
} from '../integrations/exchange/applicant';
import { requirePermission } from '../rbac';

/** Роль физического лица в собственной организации, когда его заводит сотрудник. */
const LEARNER_POSITION = 'Слушатель';

/**
 * Физическое лицо контрагентом. Уже заведённый по почте или телефону человек
 * не дублируется: находится он. Ответственным за нового становится тот, кто
 * завёл, — иначе контрагент пропал бы у него из виду в ту же секунду.
 * Контактное лицо стороны — сам человек, его роль и возвращается.
 */
export async function createIndividualCounterparty(
	ctx: ActorContext,
	person: ApplicantPerson
): Promise<{ option: LookupOption; contactAffiliationId: string | null }> {
	requirePermission(ctx, 'organizations.write');
	requirePermission(ctx, 'people.write');

	const user = ctx.user;

	if (user === null) {
		throw new ForbiddenError('Физическое лицо из формы заводит сотрудник');
	}

	const created = await withTransaction(ctx, async (tx) => {
		const individual = await findOrCreateIndividual(ctx, tx, person);

		await ensureResponsible(ctx, tx, individual.organizationId, user.id);

		const contactAffiliationId =
			individual.personId === null
				? null
				: await ensureOwnAffiliation(ctx, tx, {
						organizationId: individual.organizationId,
						personId: individual.personId,
						position: LEARNER_POSITION,
						isPrimary: true
					});

		return { organizationId: individual.organizationId, contactAffiliationId };
	});

	// Нашёлся человек, которого ведёт другой сотрудник: выбрать его стороной
	// нельзя, и сказать это надо сейчас, а не отказом всей формы в конце.
	const option = await pickOrganization(ctx, created.organizationId);

	if (option === null) {
		throw new ConflictError(
			'Человек с такой почтой или телефоном уже заведён контрагентом, но вне вашей области доступа: попросите руководителя назначить его вам'
		);
	}

	return { option, contactAffiliationId: created.contactAffiliationId };
}
