/**
 * Приём результата учебной группы: направление 4 контракта обмена.
 *
 * Что делает CRM, получив результат:
 *
 * 1. **Сохраняет факт** строкой `learning_group_results` — историей, а не
 *    перезаписью: промежуточный и итоговый результат по одной группе — обычное
 *    дело, а подтверждённый снимок статистики неизменяем, и «последний
 *    результат» обязан быть выводом из истории.
 * 2. **Подтверждает стадию, требующую данных обучения** (`applyLmsEvidence`),
 *    если результат итоговый и группа — нужная. Промежуточный результат — это
 *    «данные получены»: он сохранён историей и виден на карточке, но стадию не
 *    подтверждает. Дальше взаимодействие не двигается ни на шаг: переход —
 *    решение сотрудника, и права `stages.transition` у машинного субъекта нет.
 *
 * Результат старше сохранённого не применяется: ответ `unchanged`, состояние
 * `ignored_stale`. Сравнение идёт под блокировкой строки взаимодействия — иначе
 * два параллельных результата оба сочли бы себя новее.
 */
import { and, count, desc, eq, isNull, sql } from 'drizzle-orm';
import {
	EXCHANGE_SCHEMA_VERSION,
	isSupportedSchemaVersion,
	lmsEvidenceSchema,
	type LearningGroupResultMessage,
	type LearningGroupResultResponse
} from '$lib/contracts/exchange';
import type { ActorContext } from '../../actor';
import { recordAuditEvent } from '../../audit';
import { getDb } from '../../db';
import {
	exchangeMessages,
	interactions,
	learningGroupResults,
	learningGroups,
	stageEntries
} from '../../db/schema';
import { withTransaction, type Tx } from '../../db/transaction';
import { publishAfterCommit } from '../../live/publish';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../errors';
import { requirePermission } from '../../rbac';
import { applyLmsEvidence, markChecklistItemIn } from '../../stages/commands';
import { getExchangeSettings } from '../settings';
import { ownerActor } from './applicant';
import { hashMessage } from './intake';
import { groupRequestExternalId } from './payloads';

/** Код PostgreSQL «нарушена уникальность». */
const UNIQUE_VIOLATION = '23505';

function isUniqueViolation(error: unknown): boolean {
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
 * Пункты чек-листа, которые следуют из результата потока сами: «Слушатель
 * зачислен в поток» — зачисленные есть, «Занятия начаты» — зачисленные есть и
 * период обучения к моменту отправки начался (или обучение уже закончилось).
 * Ключи — пункты стадии «Обучение» процесса B2C (`stages/definitions.ts`);
 * у стадии без таких пунктов отмечать нечего.
 */
const LEARNING_CHECKLIST = [
	{ key: 'enrolled', label: 'Слушатель зачислен в поток' },
	{ key: 'classes_started', label: 'Занятия начаты' }
] as const;

/** День отправки по часам отправителя: дата из `occurredAt`, как он её написал. */
function senderDay(occurredAt: string): string {
	return occurredAt.slice(0, 10);
}

/**
 * Какие пункты чек-листа подтверждает результат. Чужой системе здесь верят ровно
 * настолько, насколько она сказала: зачисленных ноль — не отмечается ничего.
 */
function learningFacts(message: LearningGroupResultMessage): Set<string> {
	const facts = new Set<string>();
	const { counters, period, finishedOn } = message.data;

	if (counters.enrolled === 0) {
		return facts;
	}

	facts.add('enrolled');

	const day = senderDay(message.occurredAt);
	const started =
		finishedOn !== null ||
		counters.completed > 0 ||
		(period?.start !== null && period?.start !== undefined && period.start <= day);

	if (started) {
		facts.add('classes_started');
	}

	return facts;
}

/**
 * Отметить пункты «зачислен» и «занятия начаты» открытой стадии, если они
 * следуют из результата, — в транзакции приёма, вместе с фактом.
 *
 * Только когда у дела один поток: тогда результат этой группы и есть состояние
 * всего обучения по делу. Потоков несколько — «зачислены» по одному ещё не
 * значит «зачислены» по делу, и пункт остаётся решению сотрудника. Отмечается
 * от имени ответственного за дело — как оплата с сайта (`payments.ts`): у
 * машинного субъекта обмена права на чек-лист нет, а пункт ставит тот же
 * журнал `interactions.checklist_changed`, что и отметка из карточки.
 *
 * Возвращает подписи отмеченных пунктов — для ответа отправителю.
 */
async function markLearningChecklist(
	ctx: ActorContext,
	tx: Tx,
	interactionId: string,
	message: LearningGroupResultMessage
): Promise<string[]> {
	const facts = learningFacts(message);

	if (facts.size === 0) {
		return [];
	}

	const [{ groups }] = await tx
		.select({ groups: count() })
		.from(learningGroups)
		.where(eq(learningGroups.interactionId, interactionId));

	if (groups !== 1) {
		return [];
	}

	const [entry] = await tx
		.select({ snapshot: stageEntries.stageSnapshot, checklistState: stageEntries.checklistState })
		.from(stageEntries)
		.where(and(eq(stageEntries.interactionId, interactionId), isNull(stageEntries.leftAt)))
		.limit(1);

	if (entry === undefined) {
		return [];
	}

	const due = LEARNING_CHECKLIST.filter(
		(item) =>
			facts.has(item.key) &&
			entry.checklistState[item.key] !== true &&
			entry.snapshot.checklist.some((declared) => declared.key === item.key)
	);

	if (due.length === 0) {
		return [];
	}

	const [interaction] = await tx
		.select({ ownerUserId: interactions.ownerUserId })
		.from(interactions)
		.where(eq(interactions.id, interactionId))
		.limit(1);
	const owner = await ownerActor(ctx, interaction.ownerUserId);

	for (const item of due) {
		await markChecklistItemIn(owner, tx, interactionId, item.key);
	}

	return due.map((item) => item.label);
}

/** Сохранённый ответ на повтор того же события; `null` — сообщения в журнале нет. */
async function savedResponse(
	instance: string,
	eventId: string,
	requestHash: string
): Promise<LearningGroupResultResponse | null> {
	const [row] = await getDb()
		.select({
			requestHash: exchangeMessages.requestHash,
			responseBody: exchangeMessages.responseBody
		})
		.from(exchangeMessages)
		.where(
			and(
				eq(exchangeMessages.direction, 'inbound'),
				eq(exchangeMessages.system, 'lms'),
				eq(exchangeMessages.instance, instance),
				eq(exchangeMessages.eventId, eventId)
			)
		)
		.limit(1);

	if (row === undefined) {
		return null;
	}

	if (row.requestHash !== requestHash) {
		throw new ConflictError(
			'Событие с этим eventId уже принято с другим телом: повтор обязан нести то же сообщение'
		);
	}

	if (row.responseBody === null) {
		throw new ConflictError('Сообщение с этим eventId ещё обрабатывается: повторите запрос позже');
	}

	return { ...(row.responseBody as LearningGroupResultResponse), result: 'unchanged' };
}

export async function receiveLearningGroupResult(
	ctx: ActorContext,
	message: LearningGroupResultMessage
): Promise<LearningGroupResultResponse> {
	requirePermission(ctx, 'exchange.results');

	if (!isSupportedSchemaVersion(message.schemaVersion)) {
		throw new ValidationError('Версия схемы сообщения не поддерживается', [
			`schemaVersion: ${message.schemaVersion} несовместима с ${EXCHANGE_SCHEMA_VERSION}`
		]);
	}

	const settings = await getExchangeSettings();

	if (message.source.instance !== settings.lms.instance) {
		throw new ForbiddenError(
			`Экземпляр «${message.source.instance}» не совпадает с подключением обмена`
		);
	}

	// Обучение не может закончиться позже, чем о нём сообщили: дата окончания
	// в будущем — это плановая дата конца потока, а не факт, и принять её
	// значило бы засчитать стадии «обучение завершено» до того, как оно
	// завершилось. Сравнение по дню отправителя: оба значения — его.
	if (message.data.finishedOn !== null && message.data.finishedOn > senderDay(message.occurredAt)) {
		throw new ValidationError('Дата окончания обучения ещё не наступила', [
			`data.finishedOn: ${message.data.finishedOn} позже дня отправки (${senderDay(message.occurredAt)}) — пока обучение идёт, пришлите результат без даты окончания`
		]);
	}

	const requestHash = hashMessage(message);
	const occurredAt = new Date(message.occurredAt);

	try {
		return await withTransaction(ctx, async (tx) => {
			const [row] = await tx
				.insert(exchangeMessages)
				.values({
					direction: 'inbound',
					system: 'lms',
					instance: message.source.instance,
					eventType: message.eventType,
					eventId: message.eventId,
					externalId: message.data.groupExternalId,
					state: 'processed',
					payload: message,
					requestHash
				})
				.returning({ id: exchangeMessages.id });

			const [group] = await tx
				.select()
				.from(learningGroups)
				.where(
					and(
						eq(learningGroups.system, 'lms'),
						eq(learningGroups.instance, message.source.instance),
						eq(learningGroups.groupExternalId, message.data.groupExternalId)
					)
				)
				.limit(1);

			if (group === undefined) {
				throw new NotFoundError(
					`Учебной группы ${message.data.groupExternalId} в системе нет: сначала создайте её заявкой из карточки`
				);
			}

			// Ключ заявки выводится из взаимодействия и номера потока, а не хранится
			// вторым полем: два имени одного и того же однажды разошлись бы.
			const requestKey = groupRequestExternalId(group.interactionId, group.streamNumber);

			if (
				message.data.requestExternalId !== null &&
				message.data.requestExternalId !== requestKey
			) {
				throw new ConflictError(
					`Результат относится к другой заявке: у группы ${message.data.groupExternalId} ключ ${requestKey}`
				);
			}

			// Блокировка строки группы: два параллельных результата обязаны
			// выстроиться в историю, а не оба счесть себя новее. Перед ней —
			// строка взаимодействия: порядок «взаимодействие, затем группа» общий
			// для всех команд группы (`groups.ts`, `roster.ts`). Подтверждение
			// стадии ниже всё равно возьмёт взаимодействие, и взятое после группы
			// оно встало бы навстречу ручной отметке «обучение завершено», которая
			// держит взаимодействие и ждёт группу, — взаимная блокировка.
			await tx
				.select({ id: interactions.id })
				.from(interactions)
				.where(eq(interactions.id, group.interactionId))
				.for('update');

			await tx
				.select({ id: learningGroups.id })
				.from(learningGroups)
				.where(eq(learningGroups.id, group.id))
				.for('update');

			const [latest] = await tx
				.select({ occurredAt: learningGroupResults.occurredAt })
				.from(learningGroupResults)
				.where(eq(learningGroupResults.learningGroupId, group.id))
				.orderBy(desc(learningGroupResults.occurredAt))
				.limit(1);

			if (latest !== undefined && latest.occurredAt.getTime() >= occurredAt.getTime()) {
				const stale: LearningGroupResultResponse = {
					schemaVersion: EXCHANGE_SCHEMA_VERSION,
					result: 'unchanged',
					data: {
						groupExternalId: message.data.groupExternalId,
						learningGroupId: group.id,
						interactionId: group.interactionId,
						stageConfirmed: false,
						note: 'Результат старше уже сохранённого: ничего не изменилось'
					}
				};

				await tx
					.update(exchangeMessages)
					.set({
						state: 'ignored_stale',
						interactionId: group.interactionId,
						responseBody: stale,
						closedAt: sql`now()`
					})
					.where(eq(exchangeMessages.id, row.id));

				return stale;
			}

			await tx.insert(learningGroupResults).values({
				learningGroupId: group.id,
				occurredAt,
				periodStart: message.data.period?.start ?? null,
				periodEnd: message.data.period?.end ?? null,
				finishedOn: message.data.finishedOn,
				enrolled: message.data.counters.enrolled,
				completed: message.data.counters.completed,
				expelled: message.data.counters.expelled,
				// Файл-подтверждение приезжает ссылкой; забирать его по ключу мы пока
				// не умеем, и придумывать документ, которого нет, нельзя — описание
				// остаётся в теле сообщения, оно целиком лежит в журнале обмена.
				documentId: null,
				exchangeMessageId: row.id
			});

			await tx
				.update(learningGroups)
				.set({ lastResultAt: occurredAt })
				.where(eq(learningGroups.id, group.id));

			const evidence = lmsEvidenceSchema.parse({
				kind: 'result',
				system: group.system,
				instance: group.instance,
				groupExternalId: message.data.groupExternalId,
				learningGroupId: group.id,
				occurredAt: occurredAt.toISOString(),
				enrolled: message.data.counters.enrolled,
				completed: message.data.counters.completed,
				expelled: message.data.counters.expelled,
				finishedOn: message.data.finishedOn,
				periodStart: message.data.period?.start ?? null,
				periodEnd: message.data.period?.end ?? null
			});

			const outcome = await applyLmsEvidence(ctx, tx, {
				interactionId: group.interactionId,
				evidence
			});
			const marked = await markLearningChecklist(ctx, tx, group.interactionId, message);
			publishAfterCommit(tx, group.interactionId, { type: 'interaction.changed' });

			const response: LearningGroupResultResponse = {
				schemaVersion: EXCHANGE_SCHEMA_VERSION,
				result: 'created',
				data: {
					groupExternalId: message.data.groupExternalId,
					learningGroupId: group.id,
					interactionId: group.interactionId,
					stageConfirmed: outcome.confirmed,
					note:
						marked.length === 0
							? outcome.note
							: `${outcome.note}. Отмечено в чек-листе: ${marked.map((label) => `«${label}»`).join(', ')}`
				}
			};

			await tx
				.update(exchangeMessages)
				.set({
					state: 'processed',
					interactionId: group.interactionId,
					responseBody: response,
					closedAt: sql`now()`
				})
				.where(eq(exchangeMessages.id, row.id));

			await recordAuditEvent(
				ctx,
				{
					type: 'exchange.message_received',
					outcome: 'success',
					subject: { type: 'interaction', id: group.interactionId },
					details: { exchangeMessageId: row.id, learningGroupId: group.id }
				},
				tx
			);

			return response;
		});
	} catch (error) {
		if (!isUniqueViolation(error)) {
			throw error;
		}

		const replay = await savedResponse(message.source.instance, message.eventId, requestHash);

		if (replay !== null) {
			return replay;
		}

		// Разошлась уникальность результата `(группа, момент отправителя)`: то же
		// событие под другим `eventId`. Применять его второй раз нечего.
		throw new ConflictError(
			'Результат этой группы с тем же моментом уже сохранён: повторное сообщение ничего не меняет'
		);
	}
}
