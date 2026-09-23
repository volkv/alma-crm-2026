/**
 * Сборка тел исходящих сообщений.
 *
 * Оба направления несут **полный снимок текущего состояния**, а не разницу:
 * приёмник, пропустивший одно сообщение из десяти, при снимке догоняет
 * состояние следующим сообщением, а при разнице расходится навсегда
 * (`docs/exchange-contract.md`, разделы 4 и 5).
 *
 * Собирается снимок в момент отправки, поэтому область доступа здесь не
 * применяется: сообщение уходит от имени системы, а не от имени человека, и его
 * состав определяет контракт, а не то, кто нажал кнопку. Что именно уезжает,
 * решено раньше — постановкой сообщения в очередь под правами сотрудника.
 */
import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import {
	applicationStatusDataSchema,
	learningGroupRequestedDataSchema,
	type ApplicationStatus
} from '$lib/contracts/exchange';
import { getDb } from '../../db';
import {
	comments,
	contracts,
	interactionParties,
	interactions,
	learningGroupProducts,
	learningGroups,
	organizations,
	products,
	programs,
	stageEntries,
	stageEntryStatus,
	users
} from '../../db/schema';

/**
 * Состояние заявки для карточки на сайте.
 *
 * Правило простое и объяснимое заявителю: пока взаимодействие стоит на первой
 * стадии процесса, работа ещё не началась — это `received`; дальше идёт работа;
 * открытая пауза значит «ждём вас или документы». Завершение и отмена
 * взаимодействия сильнее всего остального.
 */
function applicationStatusOf(options: {
	status: string;
	position: number | null;
	paused: boolean;
}): ApplicationStatus {
	if (options.status === 'completed') {
		return 'completed';
	}

	if (options.status === 'cancelled') {
		return 'cancelled';
	}

	if (options.paused) {
		return 'on_hold';
	}

	return options.position === 1 ? 'received' : 'in_progress';
}

/** Тело `application.status`; `null` — взаимодействия больше нет. */
export async function buildApplicationStatus(
	interactionId: string | null,
	externalId: string | null
): Promise<Record<string, unknown> | null> {
	if (interactionId === null || externalId === null) {
		return null;
	}

	const db = getDb();

	const [interaction] = await db
		.select({
			id: interactions.id,
			status: interactions.status,
			updatedAt: interactions.updatedAt,
			ownerUserId: interactions.ownerUserId,
			ownerName: users.fullName
		})
		.from(interactions)
		.innerJoin(users, eq(users.id, interactions.ownerUserId))
		.where(eq(interactions.id, interactionId))
		.limit(1);

	if (interaction === undefined) {
		return null;
	}

	const [entry] = await db
		.select({
			id: stageEntries.id,
			snapshot: stageEntries.stageSnapshot,
			dueAt: stageEntryStatus.dueAt,
			isPaused: stageEntryStatus.isPaused
		})
		.from(stageEntries)
		.innerJoin(stageEntryStatus, eq(stageEntryStatus.stageEntryId, stageEntries.id))
		.where(and(eq(stageEntries.interactionId, interactionId), isNull(stageEntries.leftAt)))
		.limit(1);

	const [comment] = await db
		.select({ body: comments.body })
		.from(comments)
		.where(eq(comments.interactionId, interactionId))
		.orderBy(desc(comments.createdAt))
		.limit(1);

	return applicationStatusDataSchema.parse({
		externalId,
		interactionId: interaction.id,
		applicationStatus: applicationStatusOf({
			status: interaction.status,
			position: entry?.snapshot.position ?? null,
			paused: entry?.isPaused ?? false
		}),
		stage:
			entry === undefined
				? null
				: {
						key: entry.snapshot.key,
						name: entry.snapshot.name,
						position: entry.snapshot.position
					},
		responsible: { userId: interaction.ownerUserId, name: interaction.ownerName },
		dueAt: entry?.dueAt.toISOString() ?? null,
		// Комментарий уезжает обрезанным: карточка заявки показывает строку, а не
		// переписку, и высылать наружу четыре тысячи знаков внутренней работы
		// незачем.
		lastComment: comment === undefined ? null : comment.body.slice(0, 500),
		updatedAt: interaction.updatedAt.toISOString()
	});
}

/** Ключ заявки на группу: наш устойчивый идентификатор запроса. */
export function groupRequestExternalId(interactionId: string, streamNumber: number): string {
	return `crm-group-${interactionId}-${streamNumber}`;
}

/** Тело `learning_group.requested`; `null` — взаимодействия или группы больше нет. */
export async function buildLearningGroupRequest(
	payload: unknown
): Promise<Record<string, unknown> | null> {
	const seed = payload as {
		interactionId?: unknown;
		streamNumber?: unknown;
		plannedSeats?: unknown;
		startsOn?: unknown;
		endsOn?: unknown;
	};

	const interactionId = typeof seed.interactionId === 'string' ? seed.interactionId : null;
	const streamNumber = Number(seed.streamNumber);

	if (interactionId === null || !Number.isInteger(streamNumber)) {
		return null;
	}

	const db = getDb();

	const [interaction] = await db
		.select({
			id: interactions.id,
			ownerUserId: interactions.ownerUserId,
			contractId: interactions.contractId
		})
		.from(interactions)
		.where(eq(interactions.id, interactionId))
		.limit(1);

	if (interaction === undefined) {
		return null;
	}

	const [organization] = await db
		.select({ id: organizations.id, inn: organizations.inn, name: organizations.shortName })
		.from(interactionParties)
		.innerJoin(organizations, eq(organizations.id, interactionParties.organizationId))
		.where(
			and(
				eq(interactionParties.interactionId, interactionId),
				eq(interactionParties.isPrimary, true)
			)
		)
		.limit(1);

	if (organization === undefined) {
		return null;
	}

	// Что и для кого обучается, закреплено строкой группы при заявке: тело
	// берёт это оттуда, а не из взаимодействия, у которого программ и
	// продуктов бывает несколько.
	const [group] = await db
		.select({
			id: learningGroups.id,
			purpose: learningGroups.purpose,
			programId: programs.id,
			programCode: programs.code
		})
		.from(learningGroups)
		.leftJoin(programs, eq(programs.id, learningGroups.programId))
		.where(
			and(
				eq(learningGroups.interactionId, interactionId),
				eq(learningGroups.streamNumber, streamNumber)
			)
		)
		.limit(1);

	if (group === undefined) {
		return null;
	}

	const groupProducts = await db
		.select({ id: products.id, code: products.code })
		.from(learningGroupProducts)
		.innerJoin(products, eq(products.id, learningGroupProducts.productId))
		.where(eq(learningGroupProducts.learningGroupId, group.id))
		.orderBy(asc(products.code));

	const [contract] =
		interaction.contractId === null
			? []
			: await db
					.select({ id: contracts.id, number: contracts.number })
					.from(contracts)
					.where(eq(contracts.id, interaction.contractId))
					.limit(1);

	return learningGroupRequestedDataSchema.parse({
		externalId: groupRequestExternalId(interactionId, streamNumber),
		interactionId,
		organization: { id: organization.id, inn: organization.inn, name: organization.name },
		program:
			group.programId === null || group.programCode === null
				? null
				: { id: group.programId, code: group.programCode },
		// Поле `1.0` несёт продукт, только когда он у группы один: выбрать
		// «главный» из нескольких значило бы соврать получателю старой версии.
		product: groupProducts.length === 1 ? groupProducts[0] : null,
		products: groupProducts,
		purpose: group.purpose,
		contract: contract === undefined ? null : { id: contract.id, number: contract.number },
		stream: {
			number: streamNumber,
			plannedSeats: Number(seed.plannedSeats),
			startsOn: typeof seed.startsOn === 'string' ? seed.startsOn : null,
			endsOn: typeof seed.endsOn === 'string' ? seed.endsOn : null
		},
		responsible: { userId: interaction.ownerUserId },
		// Ссылки на файлы v1 не возит: получатель забирает их сам по ключу
		// объекта (`GET /v1/exchange/files/{ключ}`), а какие именно документы
		// нужны системе обучения, контракт заказчика ещё не называет.
		documents: []
	});
}
