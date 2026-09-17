/**
 * Учебные группы: заявка в систему обучения (направление 3) и то, что о группе
 * знает карточка взаимодействия.
 *
 * Заявку отправляет **сотрудник**, а не переход по стадии. Причин три: переход
 * делают и по ошибке, и в рамках административной миграции маршрута, а
 * автоматическая отправка превращала бы такую ошибку в группу в чужой системе;
 * в заявке есть поля, которых нет ни у стадии, ни у взаимодействия, — число
 * мест, даты, номер потока, — и подтверждает их человек; и симметрия с обратным
 * направлением, где результат тоже не двигает стадии сам
 * (`docs/exchange-contract.md`, раздел 5).
 */
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import {
	EXCHANGE_EVENT_TYPES,
	type ExchangeMessageState,
	type LearningGroupView,
	type SendLearningGroupInput
} from '$lib/contracts/exchange';
import type { ActorContext } from '../../actor';
import { recordAuditEvent } from '../../audit';
import { getDb } from '../../db';
import {
	exchangeMessages,
	interactionParties,
	interactions,
	learningGroupResults,
	learningGroups
} from '../../db/schema';
import { withTransaction } from '../../db/transaction';
import { ConflictError, NotFoundError, ValidationError } from '../../errors';
import { interactionScopeFilter } from '../../interactions/access';
import { can, requirePermission } from '../../rbac';
import { getExchangeSettings } from '../settings';
import { deliverMessage } from './delivery';
import { groupRequestExternalId } from './payloads';
import { enqueueOutbound } from './outbox';

/**
 * Можно ли отправить группу прямо сейчас; `null` — можно.
 *
 * Кнопка не прячется, а объясняет отказ: спрятанная кнопка не объясняет
 * ничего, а «отправить нельзя, потому что у взаимодействия нет контрагента» —
 * объясняет.
 */
export function groupSendIssue(state: {
	hasOrganization: boolean;
	groupsUrlConfigured: boolean;
	status: string;
}): string | null {
	if (!state.groupsUrlConfigured) {
		return 'Обмен с системой обучения не настроен: укажите адрес и секрет в разделе «Интеграции»';
	}

	if (state.status !== 'active') {
		return 'Взаимодействие закрыто: заводить поток в системе обучения не для чего';
	}

	if (!state.hasOrganization) {
		return 'У взаимодействия нет основной стороны: некому заводить группу';
	}

	return null;
}

/**
 * Заявка на учебную группу.
 *
 * Строка группы и строка исходящего сообщения появляются одной транзакцией;
 * отправка идёт **после коммита** — иначе неудача сети откатила бы и саму
 * заявку. Повторное нажатие на тот же поток второй группы не заводит: это
 * держит уникальность `(interaction_id, stream_number)`.
 */
export async function requestLearningGroup(
	ctx: ActorContext,
	input: SendLearningGroupInput
): Promise<{
	learningGroupId: string;
	messageId: string;
	delivered: boolean;
	error: string | null;
}> {
	requirePermission(ctx, 'exchange.send');

	const settings = await getExchangeSettings();

	const prepared = await withTransaction(ctx, async (tx) => {
		const [interaction] = await tx
			.select({ id: interactions.id, status: interactions.status })
			.from(interactions)
			.where(and(eq(interactions.id, input.interactionId), interactionScopeFilter(ctx)))
			.for('update');

		if (interaction === undefined) {
			throw new NotFoundError('Взаимодействие не найдено');
		}

		const [primary] = await tx
			.select({ id: interactionParties.id })
			.from(interactionParties)
			.where(
				and(
					eq(interactionParties.interactionId, interaction.id),
					eq(interactionParties.isPrimary, true)
				)
			)
			.limit(1);

		const issue = groupSendIssue({
			hasOrganization: primary !== undefined,
			groupsUrlConfigured: settings.lms.groupsUrl !== null && settings.lms.secret !== null,
			status: interaction.status
		});

		if (issue !== null) {
			throw new ValidationError('Заявка в систему обучения не отправлена', [issue]);
		}

		const [existing] = await tx
			.select({ id: learningGroups.id })
			.from(learningGroups)
			.where(
				and(
					eq(learningGroups.interactionId, interaction.id),
					eq(learningGroups.streamNumber, input.streamNumber)
				)
			)
			.limit(1);

		if (existing !== undefined) {
			throw new ConflictError(
				`Поток ${input.streamNumber} уже заведён: второй поток — это другой номер`
			);
		}

		const [group] = await tx
			.insert(learningGroups)
			.values({
				interactionId: interaction.id,
				streamNumber: input.streamNumber,
				system: 'lms',
				instance: settings.lms.instance,
				plannedSeats: input.plannedSeats,
				startsOn: input.startsOn,
				endsOn: input.endsOn
			})
			.returning({ id: learningGroups.id });

		const messageId = await enqueueOutbound(tx, {
			system: 'lms',
			instance: settings.lms.instance,
			eventType: EXCHANGE_EVENT_TYPES.learningGroupRequested,
			externalId: groupRequestExternalId(interaction.id, input.streamNumber),
			interactionId: interaction.id,
			// Семя тела: что именно уедет, собирается в момент отправки, но номер
			// потока и подтверждённые человеком числа знает только эта транзакция.
			payload: {
				interactionId: interaction.id,
				streamNumber: input.streamNumber,
				plannedSeats: input.plannedSeats,
				startsOn: input.startsOn,
				endsOn: input.endsOn
			}
		});

		await recordAuditEvent(
			ctx,
			{
				type: 'exchange.group_requested',
				outcome: 'success',
				subject: { type: 'interaction', id: interaction.id },
				details: { exchangeMessageId: messageId, learningGroupId: group.id }
			},
			tx
		);

		return { learningGroupId: group.id, messageId };
	});

	// Отправка после коммита: сотрудник нажал кнопку и вправе увидеть ответ
	// системы обучения сразу, а не через проход цикла. Неудача доставки заявку не
	// отменяет — сообщение остаётся в очереди повторов.
	const attempt = await deliverMessage(ctx, prepared.messageId);

	return {
		...prepared,
		delivered: attempt?.ok ?? false,
		error: attempt?.error ?? null
	};
}

/** Учебные группы взаимодействия — то, что показывает карточка. */
export async function listLearningGroups(
	ctx: ActorContext,
	interactionId: string
): Promise<LearningGroupView[]> {
	requirePermission(ctx, 'interactions.read');

	const db = getDb();

	const rows = await db
		.select({
			id: learningGroups.id,
			streamNumber: learningGroups.streamNumber,
			system: learningGroups.system,
			instance: learningGroups.instance,
			groupExternalId: learningGroups.groupExternalId,
			requestedAt: learningGroups.requestedAt,
			plannedSeats: learningGroups.plannedSeats,
			startsOn: learningGroups.startsOn,
			endsOn: learningGroups.endsOn,
			lastResultAt: learningGroups.lastResultAt
		})
		.from(learningGroups)
		.innerJoin(interactions, eq(interactions.id, learningGroups.interactionId))
		.where(and(eq(learningGroups.interactionId, interactionId), interactionScopeFilter(ctx)))
		.orderBy(asc(learningGroups.streamNumber));

	if (rows.length === 0) {
		return [];
	}

	const results = await db
		.select({
			learningGroupId: learningGroupResults.learningGroupId,
			occurredAt: learningGroupResults.occurredAt,
			enrolled: learningGroupResults.enrolled,
			completed: learningGroupResults.completed,
			expelled: learningGroupResults.expelled
		})
		.from(learningGroupResults)
		.where(
			inArray(
				learningGroupResults.learningGroupId,
				rows.map((row) => row.id)
			)
		)
		.orderBy(desc(learningGroupResults.occurredAt));

	const latest = new Map<string, (typeof results)[number]>();

	for (const result of results) {
		if (!latest.has(result.learningGroupId)) {
			latest.set(result.learningGroupId, result);
		}
	}

	const messages = await db
		.select({
			externalId: exchangeMessages.externalId,
			state: exchangeMessages.state,
			lastError: exchangeMessages.lastError
		})
		.from(exchangeMessages)
		.where(
			and(
				eq(exchangeMessages.direction, 'outbound'),
				eq(exchangeMessages.eventType, EXCHANGE_EVENT_TYPES.learningGroupRequested),
				eq(exchangeMessages.interactionId, interactionId)
			)
		)
		.orderBy(desc(exchangeMessages.createdAt));

	const messageByKey = new Map<string, { state: ExchangeMessageState; lastError: string | null }>();

	for (const message of messages) {
		if (message.externalId !== null && !messageByKey.has(message.externalId)) {
			messageByKey.set(message.externalId, {
				state: message.state,
				lastError: message.lastError
			});
		}
	}

	return rows.map((row) => {
		const result = latest.get(row.id);
		const message = messageByKey.get(groupRequestExternalId(interactionId, row.streamNumber));

		return {
			...row,
			messageState: message?.state ?? null,
			lastError: message?.lastError ?? null,
			enrolled: result?.enrolled ?? null,
			completed: result?.completed ?? null,
			expelled: result?.expelled ?? null
		};
	});
}

/** Следующий свободный номер потока: карточка подставляет его в форму. */
export async function nextStreamNumber(interactionId: string): Promise<number> {
	const [row] = await getDb()
		.select({ value: sql<number>`coalesce(max(${learningGroups.streamNumber}), 0)::int` })
		.from(learningGroups)
		.where(eq(learningGroups.interactionId, interactionId));

	return (row?.value ?? 0) + 1;
}

/** Что карточка взаимодействия знает про обмен с системой обучения. */
export type InteractionExchangeView = {
	groups: LearningGroupView[];
	/** Номер, который форма подставит следующему потоку. */
	nextStreamNumber: number;
	canSend: boolean;
	/** Почему отправить нельзя; `null` — можно. */
	issue: string | null;
};

/**
 * Сводка обмена для карточки. Собрана здесь, а не в загрузчике страницы: тот же
 * приговор («можно ли отправить и почему нет») выносит и сама команда, и
 * второго правила в продукте быть не должно.
 */
export async function readInteractionExchange(
	ctx: ActorContext,
	interactionId: string
): Promise<InteractionExchangeView> {
	requirePermission(ctx, 'interactions.read');

	const [groups, settings, interaction] = await Promise.all([
		listLearningGroups(ctx, interactionId),
		getExchangeSettings(),
		getDb()
			.select({ status: interactions.status })
			.from(interactions)
			.where(and(eq(interactions.id, interactionId), interactionScopeFilter(ctx)))
			.limit(1)
	]);

	const [primary] = await getDb()
		.select({ id: interactionParties.id })
		.from(interactionParties)
		.where(
			and(
				eq(interactionParties.interactionId, interactionId),
				eq(interactionParties.isPrimary, true)
			)
		)
		.limit(1);

	return {
		groups,
		nextStreamNumber: await nextStreamNumber(interactionId),
		canSend: can(ctx, 'exchange.send'),
		issue: groupSendIssue({
			hasOrganization: primary !== undefined,
			groupsUrlConfigured: settings.lms.groupsUrl !== null && settings.lms.secret !== null,
			status: interaction[0]?.status ?? 'cancelled'
		})
	};
}
