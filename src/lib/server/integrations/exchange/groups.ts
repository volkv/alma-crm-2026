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
	isFinalLearningResult,
	type CompleteLearningGroupInput,
	type ExchangeMessageState,
	type LearningGroupLearnerView,
	type LearningGroupView,
	type LearningPurpose,
	type LearningTrainingState,
	type LmsEvidence,
	type SendLearningGroupInput
} from '$lib/contracts/exchange';
import type { ActorContext } from '../../actor';
import { recordAuditEvent } from '../../audit';
import { getDb } from '../../db';
import {
	exchangeMessages,
	interactionParties,
	interactionProducts,
	interactionPrograms,
	interactions,
	learningGroupProducts,
	learningGroupResults,
	learningGroups,
	products,
	programs,
	stageEntries,
	stages,
	users
} from '../../db/schema';
import { withTransaction, type Tx } from '../../db/transaction';
import { publishAfterCommit } from '../../live/publish';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../errors';
import { interactionScopeFilter } from '../../interactions/access';
import { can, requirePermission } from '../../rbac';
import { applyLmsEvidence, type LmsEvidenceOutcome } from '../../stages/commands';
import { getExchangeSettings } from '../settings';
import { deliverMessage } from './delivery';
import { countsForStage, finalResultFilter } from './evidence';
import { groupRequestExternalId } from './payloads';
import { enqueueOutbound } from './outbox';
import { countGroupLearners, listInteractionLearners } from './roster';

/**
 * Можно ли отправить группу прямо сейчас; `null` — можно.
 *
 * Кнопка не прячется, а объясняет отказ: спрятанная кнопка не объясняет
 * ничего, а «отправить нельзя, потому что у взаимодействия нет контрагента» —
 * объясняет.
 */
export function groupSendIssue(state: {
	hasOrganization: boolean;
	hasProgram: boolean;
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

	if (!state.hasProgram) {
		return 'У взаимодействия нет программы обучения: добавьте её в карточке — группа заводится по программе';
	}

	return null;
}

/** Программы и продукты взаимодействия: из них выбирает группа. */
async function readOfferings(
	executor: Tx | ReturnType<typeof getDb>,
	interactionId: string
): Promise<{
	programs: { id: string; code: string; name: string }[];
	products: { id: string; code: string; name: string }[];
}> {
	const [programRows, productRows] = await Promise.all([
		executor
			.select({ id: programs.id, code: programs.code, name: programs.name })
			.from(interactionPrograms)
			.innerJoin(programs, eq(programs.id, interactionPrograms.programId))
			.where(eq(interactionPrograms.interactionId, interactionId))
			.orderBy(asc(programs.code)),
		executor
			.select({ id: products.id, code: products.code, name: products.name })
			.from(interactionProducts)
			.innerJoin(products, eq(products.id, interactionProducts.productId))
			.where(eq(interactionProducts.interactionId, interactionId))
			.orderBy(asc(products.code))
	]);

	return { programs: programRows, products: productRows };
}

/**
 * Что закрепляет группа: программа и продукты из тех, что есть у
 * взаимодействия.
 *
 * Единственный вариант подставляется сам: выбирать не из чего, и спрашивать
 * человека значило бы заставить его нажать очевидное. Из нескольких выбирает
 * человек — первый попавшийся вместо выбора означал бы группу, которая молча
 * учит не тому, о чём договаривались. Продуктов у взаимодействия может не быть
 * вовсе, программы — нет: без неё непонятно, что обучается.
 */
export function resolveGroupScope(
	available: { programIds: readonly string[]; productIds: readonly string[] },
	chosen: { programId: string | null; productIds: readonly string[] }
): { programId: string; productIds: string[] } | { issues: string[] } {
	const issues: string[] = [];
	let programId: string | null = null;

	if (available.programIds.length === 0) {
		issues.push(
			'У взаимодействия нет программы обучения: добавьте её в карточке — группа заводится по программе'
		);
	} else if (chosen.programId === null) {
		if (available.programIds.length === 1) {
			programId = available.programIds[0];
		} else {
			issues.push('Выберите программу группы: у взаимодействия их несколько');
		}
	} else if (available.programIds.includes(chosen.programId)) {
		programId = chosen.programId;
	} else {
		issues.push('Выбранная программа не входит во взаимодействие');
	}

	let productIds: string[] = [];

	if (chosen.productIds.length === 0) {
		if (available.productIds.length === 1) {
			productIds = [available.productIds[0]];
		} else if (available.productIds.length > 1) {
			issues.push('Выберите продукты группы: у взаимодействия их несколько');
		}
	} else if (chosen.productIds.every((id) => available.productIds.includes(id))) {
		productIds = [...chosen.productIds];
	} else {
		issues.push('Выбранный продукт не входит во взаимодействие');
	}

	return programId === null || issues.length > 0 ? { issues } : { programId, productIds };
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

		publishAfterCommit(tx, interaction.id, { type: 'interaction.changed' });

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

		const offerings = await readOfferings(tx, interaction.id);

		const issue = groupSendIssue({
			hasOrganization: primary !== undefined,
			hasProgram: offerings.programs.length > 0,
			groupsUrlConfigured: settings.lms.groupsUrl !== null && settings.lms.secret !== null,
			status: interaction.status
		});

		if (issue !== null) {
			throw new ValidationError('Заявка в систему обучения не отправлена', [issue]);
		}

		const scope = resolveGroupScope(
			{
				programIds: offerings.programs.map((program) => program.id),
				productIds: offerings.products.map((product) => product.id)
			},
			{ programId: input.programId, productIds: input.productIds }
		);

		if ('issues' in scope) {
			throw new ValidationError('Заявка в систему обучения не отправлена', scope.issues);
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
				endsOn: input.endsOn,
				programId: scope.programId,
				purpose: input.purpose
			})
			.returning({ id: learningGroups.id });

		if (scope.productIds.length > 0) {
			await tx
				.insert(learningGroupProducts)
				.values(scope.productIds.map((productId) => ({ learningGroupId: group.id, productId })));
		}

		const messageId = await enqueueOutbound(tx, {
			system: 'lms',
			instance: settings.lms.instance,
			eventType: EXCHANGE_EVENT_TYPES.learningGroupRequested,
			externalId: groupRequestExternalId(interaction.id, input.streamNumber),
			interactionId: interaction.id,
			// Семя тела: что именно уедет, собирается в момент отправки, но номер
			// потока и подтверждённые человеком числа знает только эта транзакция.
			// Программа, продукты и назначение в семя не входят: они закреплены
			// строкой группы, и тело берёт их оттуда.
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

/**
 * Назначения групп, которые засчитывает процесс взаимодействия: объединение по
 * стадиям с данными обучения той редакции, на стадии которой дело стоит (или
 * стояло последним). `null` — сужения нет: хотя бы одна такая стадия берёт
 * группу любого назначения, или таких стадий нет вовсе и остаётся правило
 * программы.
 */
async function processGroupPurposes(
	executor: ReturnType<typeof getDb>,
	interactionId: string
): Promise<LearningPurpose[] | null> {
	const [latest] = await executor
		.select({ revisionId: stages.revisionId })
		.from(stageEntries)
		.innerJoin(stages, eq(stages.id, stageEntries.stageId))
		.where(eq(stageEntries.interactionId, interactionId))
		.orderBy(desc(stageEntries.enteredAt), desc(stageEntries.id))
		.limit(1);

	if (latest === undefined) {
		return null;
	}

	const rows = await executor
		.select({ purposes: stages.lmsGroupPurposes })
		.from(stages)
		.where(and(eq(stages.revisionId, latest.revisionId), eq(stages.requiresLmsData, true)));

	if (rows.length === 0 || rows.some((row) => row.purposes === null)) {
		return null;
	}

	return [...new Set(rows.flatMap((row) => row.purposes ?? []))];
}

/** Учебные группы взаимодействия — то, что показывает карточка. */
export async function listLearningGroups(
	ctx: ActorContext,
	interactionId: string
): Promise<LearningGroupView[]> {
	requirePermission(ctx, 'interactions.read');

	const db = getDb();
	// Карточка отвечает тем же правилом, что и движок: группа, которую стадия
	// не засчитает, не показывается засчитанной.
	const purposes = await processGroupPurposes(db, interactionId);

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
			lastResultAt: learningGroups.lastResultAt,
			purpose: learningGroups.purpose,
			programId: programs.id,
			programCode: programs.code,
			programName: programs.name,
			completionMarkedAt: learningGroups.completionMarkedAt,
			completionComment: learningGroups.completionComment,
			completionMarkedByName: users.fullName,
			countsForStage: sql<boolean>`${countsForStage(db, purposes)}`
		})
		.from(learningGroups)
		.innerJoin(interactions, eq(interactions.id, learningGroups.interactionId))
		.leftJoin(programs, eq(programs.id, learningGroups.programId))
		.leftJoin(users, eq(users.id, learningGroups.completionMarkedBy))
		.where(and(eq(learningGroups.interactionId, interactionId), interactionScopeFilter(ctx)))
		.orderBy(asc(learningGroups.streamNumber));

	if (rows.length === 0) {
		return [];
	}

	const groupIds = rows.map((row) => row.id);

	const [results, groupProducts, learnerCounts] = await Promise.all([
		db
			.select({
				learningGroupId: learningGroupResults.learningGroupId,
				occurredAt: learningGroupResults.occurredAt,
				enrolled: learningGroupResults.enrolled,
				completed: learningGroupResults.completed,
				expelled: learningGroupResults.expelled,
				finishedOn: learningGroupResults.finishedOn
			})
			.from(learningGroupResults)
			.where(inArray(learningGroupResults.learningGroupId, groupIds))
			.orderBy(desc(learningGroupResults.occurredAt)),
		db
			.select({
				learningGroupId: learningGroupProducts.learningGroupId,
				id: products.id,
				code: products.code,
				name: products.name
			})
			.from(learningGroupProducts)
			.innerJoin(products, eq(products.id, learningGroupProducts.productId))
			.where(inArray(learningGroupProducts.learningGroupId, groupIds))
			.orderBy(asc(products.code)),
		countGroupLearners(groupIds)
	]);

	const latest = new Map<string, (typeof results)[number]>();
	/** Группы, по которым пришёл итоговый результат, а не только промежуточный. */
	const finished = new Set<string>();

	for (const result of results) {
		if (!latest.has(result.learningGroupId)) {
			latest.set(result.learningGroupId, result);
		}

		if (isFinalLearningResult(result)) {
			finished.add(result.learningGroupId);
		}
	}

	const productsByGroup = new Map<string, { id: string; code: string; name: string }[]>();

	for (const { learningGroupId, ...product } of groupProducts) {
		productsByGroup.set(learningGroupId, [
			...(productsByGroup.get(learningGroupId) ?? []),
			product
		]);
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
		const completionMark =
			row.completionMarkedAt === null || row.completionComment === null
				? null
				: {
						at: row.completionMarkedAt,
						byName: row.completionMarkedByName,
						comment: row.completionComment
					};
		const trainingState: LearningTrainingState =
			completionMark !== null || finished.has(row.id)
				? 'completed'
				: result !== undefined
					? 'in_progress'
					: 'awaiting';

		return {
			id: row.id,
			streamNumber: row.streamNumber,
			system: row.system,
			instance: row.instance,
			groupExternalId: row.groupExternalId,
			requestedAt: row.requestedAt,
			plannedSeats: row.plannedSeats,
			startsOn: row.startsOn,
			endsOn: row.endsOn,
			lastResultAt: row.lastResultAt,
			messageState: message?.state ?? null,
			lastError: message?.lastError ?? null,
			enrolled: result?.enrolled ?? null,
			completed: result?.completed ?? null,
			expelled: result?.expelled ?? null,
			finishedOn: result?.finishedOn ?? null,
			program:
				row.programId === null || row.programCode === null || row.programName === null
					? null
					: { id: row.programId, code: row.programCode, name: row.programName },
			products: productsByGroup.get(row.id) ?? [],
			purpose: row.purpose,
			trainingState,
			completionMark,
			countsForStage: row.countsForStage,
			learnerCount: learnerCounts.get(row.id)?.total ?? 0,
			transferredCount: learnerCounts.get(row.id)?.transferred ?? 0
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
	/** Из чего группа выбирает программу и продукты. */
	programs: { id: string; code: string; name: string }[];
	products: { id: string; code: string; name: string }[];
	canSend: boolean;
	/** Может ли сотрудник отметить обучение завершённым. */
	canComplete: boolean;
	/** Может ли сотрудник загружать и править поимённые списки групп. */
	canManageRoster: boolean;
	/** Почему отправить нельзя; `null` — можно. */
	issue: string | null;
	/** Слушатели всех групп; `null` — люди вызывающему не видны, в карточке только числа. */
	learners: LearningGroupLearnerView[] | null;
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

	const [groups, settings, interaction, offerings, learners] = await Promise.all([
		listLearningGroups(ctx, interactionId),
		getExchangeSettings(),
		getDb()
			.select({ status: interactions.status })
			.from(interactions)
			.where(and(eq(interactions.id, interactionId), interactionScopeFilter(ctx)))
			.limit(1),
		readOfferings(getDb(), interactionId),
		listInteractionLearners(ctx, interactionId)
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
		programs: offerings.programs,
		products: offerings.products,
		canSend: can(ctx, 'exchange.send'),
		canComplete: can(ctx, 'stages.confirm'),
		canManageRoster: can(ctx, 'people.write'),
		learners,
		issue: groupSendIssue({
			hasOrganization: primary !== undefined,
			hasProgram: offerings.programs.length > 0,
			groupsUrlConfigured: settings.lms.groupsUrl !== null && settings.lms.secret !== null,
			status: interaction[0]?.status ?? 'cancelled'
		})
	};
}

/**
 * Отметка сотрудника «обучение завершено».
 *
 * Нужна там, где система обучения итога не прислала, а обучение закончилось:
 * расписание LMS не совпало с нашим, итоговая ведомость пришла бумагой. Без
 * объяснения такая отметка — слово против отсутствия данных, поэтому
 * комментарий обязателен и остаётся на группе, а в журнале — событие со ссылкой
 * на неё. Группа, завершённая итогом из системы обучения, отметки не ждёт: там
 * данные сильнее слова.
 *
 * Стадию, требующую данных обучения, отметка подтверждает тем же движком, что и
 * итоговый результат, и тем же правилом нужной группы.
 */
export async function markLearningGroupCompleted(
	ctx: ActorContext,
	input: CompleteLearningGroupInput
): Promise<LmsEvidenceOutcome> {
	requirePermission(ctx, 'stages.confirm');

	if (ctx.user === null) {
		throw new ForbiddenError('Обучение завершённым отмечает сотрудник, а не фоновая задача');
	}

	const userId = ctx.user.id;

	return withTransaction(ctx, async (tx) => {
		const [interaction] = await tx
			.select({ id: interactions.id, status: interactions.status })
			.from(interactions)
			.where(and(eq(interactions.id, input.interactionId), interactionScopeFilter(ctx)))
			.for('update');

		if (interaction === undefined) {
			throw new NotFoundError('Взаимодействие не найдено');
		}

		if (interaction.status !== 'active') {
			throw new ValidationError('Отметка не поставлена', [
				'Взаимодействие закрыто: отмечать обучение по нему незачем'
			]);
		}

		// Группа — после взаимодействия: этот порядок общий для всех команд
		// группы, и приём результата из системы обучения держит его же
		// (`results.ts`). Обратный порядок у любой из них — взаимная блокировка.
		const [group] = await tx
			.select({
				id: learningGroups.id,
				streamNumber: learningGroups.streamNumber,
				groupExternalId: learningGroups.groupExternalId,
				completionMarkedAt: learningGroups.completionMarkedAt
			})
			.from(learningGroups)
			.where(
				and(
					eq(learningGroups.id, input.learningGroupId),
					eq(learningGroups.interactionId, interaction.id)
				)
			)
			.for('update');

		if (group === undefined) {
			throw new NotFoundError('Учебная группа не найдена у этого взаимодействия');
		}

		if (group.completionMarkedAt !== null) {
			throw new ConflictError(`Обучение по потоку ${group.streamNumber} уже отмечено завершённым`);
		}

		const [final] = await tx
			.select({ id: learningGroupResults.id })
			.from(learningGroupResults)
			.where(and(eq(learningGroupResults.learningGroupId, group.id), finalResultFilter()))
			.limit(1);

		if (final !== undefined) {
			throw new ConflictError(
				`Обучение по потоку ${group.streamNumber} уже завершено итогом из системы обучения: отметка не нужна`
			);
		}

		const [marked] = await tx
			.update(learningGroups)
			.set({
				completionMarkedAt: sql`clock_timestamp()`,
				completionMarkedBy: userId,
				completionComment: input.comment
			})
			.where(eq(learningGroups.id, group.id))
			.returning({ markedAt: learningGroups.completionMarkedAt });

		if (marked === undefined || marked.markedAt === null) {
			throw new Error(`Отметка группы ${group.id} не записалась`);
		}

		await recordAuditEvent(
			ctx,
			{
				type: 'exchange.group_completed',
				outcome: 'success',
				subject: { type: 'interaction', id: interaction.id },
				details: { learningGroupId: group.id }
			},
			tx
		);

		const evidence: LmsEvidence = {
			kind: 'manual',
			learningGroupId: group.id,
			groupExternalId: group.groupExternalId,
			streamNumber: group.streamNumber,
			markedAt: marked.markedAt.toISOString(),
			markedByUserId: userId,
			comment: input.comment
		};

		publishAfterCommit(tx, interaction.id, { type: 'interaction.changed' });

		return applyLmsEvidence(ctx, tx, { interactionId: interaction.id, evidence });
	});
}
