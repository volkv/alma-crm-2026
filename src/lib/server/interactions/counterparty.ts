/**
 * Контрагент, которого нет в справочнике, — заведённый прямо из формы дела.
 *
 * Организацию заводит сервис справочника (`createOrganization`) — тем же
 * путём, что форма «Организации → Новая»: те же проверки ИНН, то же
 * назначение автора ответственным. Физическое лицо справочник формой не
 * заводит: его строка неотделима от человека, и появляется она тем же
 * способом, что у заявки с сайта, — человек, организация вида «физлицо» и его
 * собственная роль в ней одной операцией, вместе с основанием обработки его
 * данных.
 */
import { and, eq, isNull, type SQL } from 'drizzle-orm';
import type { LookupOption } from '$lib/contracts/directory';
import type { IndividualCounterpartyInput } from '$lib/contracts/interactions';
import { formatIsoDay } from '$lib/format';
import type { ActorContext } from '../actor';
import { organizations, people } from '../db/schema';
import { withTransaction, type Tx } from '../db/transaction';
import { pickOrganization } from '../directory/read';
import { ConflictError, ForbiddenError } from '../errors';
import {
	createIndividual,
	ensureOwnAffiliation,
	ensureResponsible
} from '../integrations/exchange/applicant';
import { personInScope } from '../people/access';
import { recordProcessingBasis } from '../people/consents';
import { hashEmail, hashPhone } from '../people/pii';
import { can, requirePermission, scopeFilter } from '../rbac';

/** Роль физического лица в собственной организации, когда его заводит сотрудник. */
const LEARNER_POSITION = 'Слушатель';

/**
 * Уже заведённое физлицо с той же почтой, затем с тем же телефоном — но только
 * среди тех, кого автор и так видит.
 *
 * У заявки с сайта (`exchange/applicant.ts`, `findIndividual`) сравнение идёт
 * по всей базе: там источник доверенный, и человек не узнаёт из ответа ничего,
 * кроме номера своего дела. Здесь почту набирает сотрудник, и поиск по всей
 * базе сказал бы ему, что за адресом стоит чужой клиент, — а заодно отдал бы
 * этого клиента в его дело. Поэтому условия те же, что у поиска людей
 * (`search/index.ts`): точная почта или телефон — только при праве видеть
 * контакты без маски, человек — в области списка (`personInScope`),
 * организация-физлицо — в области автора. Вне этих условий совпадения для
 * автора нет вовсе: заводится новая запись. Дубль человека разводится
 * руководителем, утечку назад не вернуть.
 */
async function findVisibleIndividual(
	ctx: ActorContext,
	tx: Tx,
	email: string,
	phone: string | null
): Promise<{ organizationId: string; personId: string; isActive: boolean } | null> {
	if (!can(ctx, 'people.read_pii')) {
		return null;
	}

	const lookup = async (match: SQL) => {
		const [row] = await tx
			.select({
				organizationId: organizations.id,
				personId: people.id,
				isActive: organizations.isActive
			})
			.from(organizations)
			.innerJoin(people, eq(people.id, organizations.personId))
			.where(
				and(
					eq(organizations.kind, 'individual'),
					isNull(people.anonymizedAt),
					scopeFilter(ctx, organizations.id),
					personInScope(ctx),
					match
				)
			)
			.limit(1);

		return row ?? null;
	};

	const emailKey = hashEmail(email);
	const byEmail = emailKey === null ? null : await lookup(eq(people.emailHash, emailKey));

	if (byEmail !== null) {
		return byEmail;
	}

	const phoneKey = phone === null ? null : hashPhone(phone);

	return phoneKey === null ? null : lookup(eq(people.phoneHash, phoneKey));
}

/**
 * Физическое лицо контрагентом. Уже заведённый человек, которого автор видит,
 * не дублируется: находится он ({@link findVisibleIndividual}). Ответственным
 * за нового становится тот, кто завёл, — иначе контрагент пропал бы у него из
 * виду в ту же секунду. Основание обработки, выбранное в форме, ложится в той
 * же транзакции. Контактное лицо стороны — сам человек, его роль и
 * возвращается.
 */
export async function createIndividualCounterparty(
	ctx: ActorContext,
	input: IndividualCounterpartyInput
): Promise<{ option: LookupOption; contactAffiliationId: string }> {
	requirePermission(ctx, 'organizations.write');
	requirePermission(ctx, 'people.write');

	const user = ctx.user;

	if (user === null) {
		throw new ForbiddenError('Физическое лицо из формы заводит сотрудник');
	}

	const { basis, ...person } = input;

	const created = await withTransaction(ctx, async (tx) => {
		const found = await findVisibleIndividual(ctx, tx, person.email, person.phone);

		// Архивное физлицо автор видит, поэтому сказать о нём можно — и нужно
		// до записи: заводить рядом второе значило бы плодить дубль видимого.
		if (found !== null && !found.isActive) {
			throw new ConflictError(
				'Физическое лицо с такой почтой или телефоном уже есть в справочнике, но в архиве: верните его из архива в карточке организации'
			);
		}

		const individual = found ?? (await createIndividual(ctx, tx, person));

		await ensureResponsible(ctx, tx, individual.organizationId, user.id);

		const day = formatIsoDay();

		// Версия текста — день записи, как у импорта каталога: подписанного
		// текста у выбора в форме нет, есть дата, когда сотрудник его сделал.
		await recordProcessingBasis(ctx, tx, individual.personId, {
			basis,
			textVersion: day,
			givenAt: day
		});

		const contactAffiliationId = await ensureOwnAffiliation(ctx, tx, {
			organizationId: individual.organizationId,
			personId: individual.personId,
			position: LEARNER_POSITION,
			isPrimary: true
		});

		return { organizationId: individual.organizationId, contactAffiliationId };
	});

	// Найденный — действующий и в области автора, заведённый — за ним
	// ответственным: не выбирается он только при нарушенной области доступа.
	const option = await pickOrganization(ctx, created.organizationId);

	if (option === null) {
		throw new Error(
			`Физлицо ${created.organizationId} заведено из формы, но вне области доступа автора`
		);
	}

	return { option, contactAffiliationId: created.contactAffiliationId };
}
