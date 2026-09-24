/**
 * Продление лицензии по позиции договора (шаг 7 процесса).
 *
 * Лицензия живёт в позиции договора (`contract_items.license_until`), а работа
 * по её продлению — обычное взаимодействие в пространстве, куда уходят записи
 * контрагента этого вида: новый договор или допсоглашение проходят те же
 * стадии, что и первая продажа. Поэтому кнопка «Запустить продление» не заводит
 * своей сущности, а собирает черновик взаимодействия из позиции: сторона —
 * организация договора, продукт — продукт позиции, договор и позиция —
 * выбраны, ответственный — ответственный за вуз по направлению продукта.
 *
 * Право то же, что у заведения взаимодействия (`interactions.write`), и граница
 * пространства та же: сервис зовёт `createInteraction`, а не пишет в обход.
 */
import { and, asc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import type { InteractionView, PartyRole } from '$lib/contracts/interactions';
import { licenseState, renewalTitle } from '$lib/contracts/license';
import { formatDate, formatIsoDay } from '$lib/format';
import type { ActorContext } from '../actor';
import { getDb } from '../db';
import { withTransaction } from '../db/transaction';
import {
	contractItems,
	contracts,
	interactionContractItems,
	interactions,
	organizationResponsibles,
	organizations,
	productDirections,
	products,
	users
} from '../db/schema';
import { ConflictError, NotFoundError, ValidationError } from '../errors';
import { visibleOrganizationFilter } from '../interactions/access';
import { getInteraction } from '../interactions/read';
import { createStaffInteractionIn } from '../interactions/write';
import { requirePermission } from '../rbac';
import { getSetting } from '../settings';
import { resolveIntakeWorkspace, type Executor } from '../stages/process';

/** Кем контрагент участвует во взаимодействии — по его виду в справочнике. */
const PARTY_ROLE_BY_KIND: Partial<Record<string, PartyRole>> = {
	educational_institution: 'educational_institution',
	legal_entity: 'customer',
	individual: 'customer'
};

/**
 * Ответственный за вуз по продукту позиции; `null` — назначения нет.
 *
 * Назначения бывают по направлениям и общие, и вместе на одном вузе они не
 * живут (правило сервиса назначений). Если вуз разделён по направлениям,
 * лицензию ведёт тот, чьё направление совпадает с направлением продукта; иначе —
 * общий ответственный. Выключенная учётная запись и машинный субъект
 * ответственными не считаются: письмо ушло бы тому, кого в системе нет.
 */
export async function licenseResponsible(
	executor: Executor,
	organizationId: string,
	productId: string
): Promise<string | null> {
	const [row] = await executor
		.select({ userId: organizationResponsibles.userId })
		.from(organizationResponsibles)
		.innerJoin(users, eq(users.id, organizationResponsibles.userId))
		.where(
			and(
				eq(organizationResponsibles.organizationId, organizationId),
				isNull(organizationResponsibles.validTo),
				eq(users.isActive, true),
				ne(users.roleId, 'service'),
				or(
					isNull(organizationResponsibles.directionId),
					inArray(
						organizationResponsibles.directionId,
						executor
							.select({ id: productDirections.directionId })
							.from(productDirections)
							.where(eq(productDirections.productId, productId))
					)
				)
			)
		)
		// Совпадение по направлению точнее общего назначения; при нескольких
		// направлениях продукта — старшее назначение, чтобы выбор не прыгал.
		.orderBy(
			sql`${organizationResponsibles.directionId} is null`,
			asc(organizationResponsibles.validFrom)
		)
		.limit(1);

	return row?.userId ?? null;
}

/**
 * Завести взаимодействие продления по позиции договора.
 *
 * Отказы словами: у позиции нет срока лицензии — продлевать нечего; срок ещё
 * не в окне — кнопки на экране нет, и присланный руками запрос тоже не
 * проходит; у вуза нет ответственного — вести продление некому.
 *
 * Повторное нажатие не заводит вторую запись: если по этой позиции уже идёт
 * продление того же срока (то же название, та же позиция, запись не закрыта),
 * возвращается оно. Проверка и заведение идут одной транзакцией под
 * блокировкой строки позиции: два нажатия подряд встают в очередь, и второе
 * видит запись, которую завело первое.
 */
export async function startLicenseRenewal(
	ctx: ActorContext,
	contractItemId: string
): Promise<InteractionView & { reused: boolean }> {
	requirePermission(ctx, 'interactions.write');

	const db = getDb();
	const [item] = await db
		.select({
			itemId: contractItems.id,
			productId: contractItems.productId,
			productName: products.name,
			licenseUntil: contractItems.licenseUntil,
			contractId: contracts.id,
			contractNumber: contracts.number,
			organizationId: organizations.id,
			organizationKind: organizations.kind
		})
		.from(contractItems)
		.innerJoin(contracts, eq(contracts.id, contractItems.contractId))
		.innerJoin(organizations, eq(organizations.id, contracts.organizationId))
		.innerJoin(products, eq(products.id, contractItems.productId))
		.where(
			and(
				eq(contractItems.id, contractItemId),
				visibleOrganizationFilter(ctx, contracts.organizationId)
			)
		)
		.limit(1);

	if (item === undefined) {
		throw new NotFoundError('Позиция договора не найдена');
	}

	const windowDays = await getSetting('license_warning_days');
	const state = licenseState(item.licenseUntil, formatIsoDay(), windowDays);

	if (item.licenseUntil === null || state === null) {
		throw new ConflictError('У позиции не записан срок лицензии: продлевать нечего');
	}

	if (state === 'active') {
		throw new ConflictError(
			`Лицензия действует до ${formatDate(item.licenseUntil)}: продление запускают, когда до конца срока остаётся ${windowDays} дней или меньше`
		);
	}

	const partyRole = PARTY_ROLE_BY_KIND[item.organizationKind];

	if (partyRole === undefined) {
		throw new ValidationError('Этот вид организации не ведёт процесс', [
			'Продление запускается для учебного заведения, юридического или физического лица'
		]);
	}

	const title = renewalTitle({
		productName: item.productName,
		contractNumber: item.contractNumber,
		licenseUntilLabel: formatDate(item.licenseUntil)
	});

	const { interactionId, reused } = await withTransaction(ctx, async (tx) => {
		await tx
			.select({ id: contractItems.id })
			.from(contractItems)
			.where(eq(contractItems.id, item.itemId))
			.for('update');

		const [existing] = await tx
			.select({ id: interactions.id })
			.from(interactionContractItems)
			.innerJoin(interactions, eq(interactions.id, interactionContractItems.interactionId))
			.where(
				and(
					eq(interactionContractItems.contractItemId, item.itemId),
					eq(interactions.title, title),
					eq(interactions.status, 'active')
				)
			)
			.limit(1);

		if (existing !== undefined) {
			return { interactionId: existing.id, reused: true };
		}

		const ownerUserId = await licenseResponsible(tx, item.organizationId, item.productId);

		if (ownerUserId === null) {
			throw new ValidationError('Продление некому вести', [
				'У организации нет действующего ответственного по направлению продукта. Назначьте ответственного в блоке «Ответственные» этой карточки'
			]);
		}

		const workspace = await resolveIntakeWorkspace(tx, item.organizationKind);

		const created = await createStaffInteractionIn(ctx, tx, workspace.key, {
			title,
			ownerUserId,
			parties: [{ organizationId: item.organizationId, partyRole, isPrimary: true }],
			productIds: [item.productId],
			contractId: item.contractId,
			contractItemIds: [item.itemId]
		});

		return { interactionId: created, reused: false };
	});

	return { ...(await getInteraction(ctx, interactionId)), reused };
}
