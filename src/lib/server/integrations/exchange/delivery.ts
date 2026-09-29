/**
 * Доставка исходящих сообщений обмена: направления 2 и 3.
 *
 * Очередь — таблица `exchange_messages`, а не Redis: за состоянием стоит
 * история, за которую отвечает сотрудник («ушла ли группа в систему обучения и
 * что ответили»), и перезапуск она обязана переживать.
 *
 * Подпись, расписание повторов и правило «за перенаправлением не идём» те же,
 * что у вебхуков, и берутся из общего кода (`../delivery.ts`): получателю не
 * нужно вторых инструкций, а второй реализации подписи не существует.
 *
 * Повторяются **только временные отказы** — 429, любой 5xx, таймаут и сетевая
 * ошибка. Ответ 4xx окончателен: тело не станет другим само по себе, и
 * сообщение сразу ждёт человека на экране «Внешние системы».
 */
import { and, asc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
	EXCHANGE_EVENT_TYPES,
	EXCHANGE_SCHEMA_VERSION,
	learningGroupLearnerEntrySchema,
	learningGroupReplySchema
} from '$lib/contracts/exchange';
import type { ActorContext } from '../../actor';
import { recordAuditEvent } from '../../audit';
import { getDb } from '../../db';
import { exchangeMessages, learningGroupLearners, learningGroups } from '../../db/schema';
import { withTransaction } from '../../db/transaction';
import { describeFailure, retryDelaySeconds, signPayload } from '../delivery';
import { outboundTargetIssue } from '../outbound';
import { getExchangeSettings } from '../settings';
import { buildApplicationStatus, buildLearningGroupRequest } from './payloads';

/** Имя нашего экземпляра в поле `source` исходящего сообщения. */
const CRM_INSTANCE = 'lct-crm';

/**
 * Сколько ждём получателя. У CMS — как у вебхука: карточка заявки обновляется
 * записью в базе сайта. У системы обучения дольше: она заводит группу, и
 * пятисекундного окна ей не хватает.
 */
const TIMEOUT_MS = { cms: 5_000, lms: 15_000 } as const;

/** Сколько сообщений уходит за один проход цикла. */
const BATCH = 20;

/**
 * На сколько сообщение прячется из очереди, пока идёт попытка. Больше любого
 * таймаута: иначе соседний процесс забрал бы его, не дождавшись ответа, и одно
 * сообщение ушло бы получателю дважды.
 */
const CLAIM_SECONDS = 120;

type MessageRow = typeof exchangeMessages.$inferSelect;

/** Что вышло из попытки: ответ получателя или объяснение, почему его нет. */
type Attempt = {
	ok: boolean;
	status: number | null;
	error: string | null;
	body: string;
	/** Временный ли отказ: только такие уходят в очередь повторов. */
	temporary: boolean;
};

/**
 * Одна попытка. Исключений не бросает: неудача — обычный исход доставки, и
 * решение о повторе принимает очередь, а не обработчик ошибки.
 */
async function post(
	url: string,
	secret: string,
	messageId: string,
	/** Готовое тело: собрано один раз и дальше уходит байт в байт. */
	body: string,
	timeoutMs: number
): Promise<Attempt> {
	const refusal = await outboundTargetIssue(url);

	if (refusal !== null) {
		// Адрес проверен и при сохранении, но имя к моменту отправки указывает
		// куда угодно (перепривязка DNS), а отказ правила — не сетевая неудача:
		// повторять его бессмысленно.
		return { ok: false, status: null, error: refusal, body: '', temporary: false };
	}

	const timestamp = String(Math.floor(Date.now() / 1000));

	let response: Response;

	try {
		response = await fetch(url, {
			method: 'POST',
			headers: {
				'content-type': 'application/json; charset=utf-8',
				accept: 'application/json',
				'X-Exchange-Id': messageId,
				'X-Exchange-Timestamp': timestamp,
				'X-Exchange-Signature': signPayload(secret, timestamp, body)
			},
			body,
			// За перенаправлением не идём: `Location` ведёт куда угодно и унёс бы
			// туда и тело, и подпись, то есть право выдавать себя за нас.
			redirect: 'manual',
			signal: AbortSignal.timeout(timeoutMs)
		});
	} catch (error) {
		return {
			ok: false,
			status: null,
			error: describeFailure(error, timeoutMs),
			body: '',
			temporary: true
		};
	}

	const text = await response.text();

	if (response.ok) {
		return { ok: true, status: response.status, error: null, body: text, temporary: false };
	}

	if (response.status >= 300 && response.status < 400) {
		return {
			ok: false,
			status: response.status,
			error: `Получатель перенаправляет запрос (${response.status}); укажите в настройках конечный адрес`,
			body: text,
			temporary: false
		};
	}

	return {
		ok: false,
		status: response.status,
		error: `Получатель ответил ${response.status}`,
		body: text,
		temporary: response.status === 429 || response.status >= 500
	};
}

/**
 * Забрать сообщение из очереди себе.
 *
 * Условная правка, а не выборка с последующей записью: сообщение отправляют и
 * цикл, и кнопка «Повторить», и действие сотрудника сразу после коммита —
 * забрать его должен ровно один из них. Проигравший получает `null` и не делает
 * ничего.
 */
async function claim(messageId: string): Promise<MessageRow | null> {
	const [row] = await getDb()
		.update(exchangeMessages)
		.set({
			attempt: sql`${exchangeMessages.attempt} + 1`,
			nextAttemptAt: sql`now() + make_interval(secs => ${CLAIM_SECONDS})`
		})
		.where(
			and(
				eq(exchangeMessages.id, messageId),
				eq(exchangeMessages.direction, 'outbound'),
				inArray(exchangeMessages.state, ['pending', 'retrying']),
				or(isNull(exchangeMessages.nextAttemptAt), lte(exchangeMessages.nextAttemptAt, sql`now()`))
			)
		)
		.returning();

	return row ?? null;
}

/** Куда и чем подписываем это сообщение; `null` — направление не настроено. */
async function targetFor(
	row: MessageRow
): Promise<{ url: string; secret: string; timeoutMs: number } | null> {
	const settings = await getExchangeSettings();

	if (row.eventType === EXCHANGE_EVENT_TYPES.applicationStatus) {
		if (settings.cms.statusUrl === null || settings.cms.secret === null) {
			return null;
		}

		return {
			url: settings.cms.statusUrl.replace('{externalId}', encodeURIComponent(row.externalId ?? '')),
			secret: settings.cms.secret,
			timeoutMs: TIMEOUT_MS.cms
		};
	}

	if (settings.lms.groupsUrl === null || settings.lms.secret === null) {
		return null;
	}

	return { url: settings.lms.groupsUrl, secret: settings.lms.secret, timeoutMs: TIMEOUT_MS.lms };
}

/**
 * Конверт сообщения: собирается **один раз**, при первой отправке, и дальше
 * берётся из строки журнала как есть.
 *
 * Тело собирается в момент первой отправки, а не постановки: снимок, собранный
 * два часа назад, уехал бы устаревшим и противоречил бы правилу «сообщение
 * старше применённого не применяется». Но и пересобирать его на каждой попытке
 * нельзя: `eventId` при повторе тот же, а данные и `occurredAt` были бы другими
 * — получатель, который сверяет повтор с принятым (и `intake.ts` делает ровно
 * это), вправе отвергнуть такой повтор как подмену. Изменение состояния — это
 * новое событие, и его ставит в очередь `outbox`, а не переписывает старое.
 *
 * Отсюда и второй столбец: `payload` остаётся семенем — тем, из чего тело
 * собирают, — а `envelope` хранит то, что действительно ушло.
 */
async function buildEnvelope(row: MessageRow): Promise<string | null> {
	if (row.envelope !== null) {
		return row.envelope;
	}

	const data =
		row.eventType === EXCHANGE_EVENT_TYPES.applicationStatus
			? await buildApplicationStatus(row.interactionId, row.externalId)
			: await buildLearningGroupRequest(row.payload);

	if (data === null) {
		return null;
	}

	const envelope = JSON.stringify({
		schemaVersion: EXCHANGE_SCHEMA_VERSION,
		eventId: row.eventId,
		eventType: row.eventType,
		occurredAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
		source: { system: 'crm', instance: CRM_INSTANCE },
		data
	});

	// Замораживается до отправки, а не вместе с её исходом: упади процесс между
	// запросом и записью — получатель уже видел это тело, и следующая попытка
	// обязана нести его же.
	await getDb().update(exchangeMessages).set({ envelope }).where(eq(exchangeMessages.id, row.id));

	return envelope;
}

/**
 * Что система обучения ответила на заявку, разобранное схемой, и кого из
 * слушателей заявка несла: `null` — списка в ней не было.
 */
type GroupReply = { groupExternalId: string; streamNumber: number; learnerIds: string[] | null };

/** Список слушателей в нашем же конверте: разбирается только он, остальное тело не нужно. */
const sentLearnersSchema = z.object({
	data: z.object({ learners: z.array(learningGroupLearnerEntrySchema).optional() })
});

function sentLearnerIds(envelope: string): string[] | null {
	const learners = sentLearnersSchema.parse(JSON.parse(envelope)).data.learners;

	return learners === undefined ? null : learners.map((learner) => learner.personId);
}

/**
 * Разбор ответа системы обучения.
 *
 * Разбирается **до** того, как сообщение объявлено отправленным: без имени
 * группы обратное направление мертво — результат потока ищет группу строго по
 * `group_external_id` (`results.ts`) и отвечает «группы в системе нет».
 * Сообщение, закрытое как отправленное, при этом ждало бы человека, который
 * никогда не узнает, что ждать его надо.
 *
 * Поэтому 2xx с телом не по контракту — это отказ доставки, и отказ
 * окончательный: другим то же тело не станет.
 */
function parseGroupReply(
	row: MessageRow,
	body: string,
	envelope: string
): GroupReply | { issue: string } {
	const refuse = (what: string): { issue: string } => ({
		issue: `Система обучения приняла заявку, но ${what}: связи с группой нет, и результат по ней прийти не сможет`
	});

	let parsed: unknown;

	try {
		parsed = JSON.parse(body);
	} catch {
		return refuse('ответила не в формате JSON');
	}

	const reply = learningGroupReplySchema.safeParse(parsed);

	if (!reply.success) {
		return refuse('не назвала идентификатор группы');
	}

	if (row.interactionId === null) {
		return refuse('заявка больше не связана со взаимодействием');
	}

	const streamNumber = Number((row.payload as { streamNumber?: unknown }).streamNumber);

	if (!Number.isInteger(streamNumber)) {
		return refuse('в семени заявки нет номера потока');
	}

	return {
		groupExternalId: reply.data.data.groupExternalId,
		streamNumber,
		learnerIds: sentLearnerIds(envelope)
	};
}

async function finish(
	ctx: ActorContext,
	row: MessageRow,
	attempt: Attempt,
	reply: GroupReply | null
): Promise<void> {
	if (attempt.ok) {
		// Состояние сообщения и имя группы — одной транзакцией: «сообщение ушло»
		// и «группа у них называется так» — это один факт, и половина его хуже,
		// чем ничего.
		await withTransaction(ctx, async (tx) => {
			await tx
				.update(exchangeMessages)
				.set({
					state: 'sent',
					responseStatus: attempt.status,
					lastError: null,
					nextAttemptAt: null,
					closedAt: sql`now()`
				})
				.where(eq(exchangeMessages.id, row.id));

			if (reply !== null && row.interactionId !== null) {
				await tx
					.update(learningGroups)
					.set({ groupExternalId: reply.groupExternalId })
					.where(
						and(
							eq(learningGroups.interactionId, row.interactionId),
							eq(learningGroups.streamNumber, reply.streamNumber)
						)
					);

				// Слушатели, которых нёс принятый список, переданы — и только они:
				// добавленный после сборки тела в систему обучения не уезжал.
				if (reply.learnerIds !== null && reply.learnerIds.length > 0) {
					await tx
						.update(learningGroupLearners)
						.set({ status: 'transferred', transferredAt: sql`now()` })
						.where(
							and(
								eq(learningGroupLearners.status, 'listed'),
								inArray(learningGroupLearners.personId, reply.learnerIds),
								inArray(
									learningGroupLearners.learningGroupId,
									tx
										.select({ id: learningGroups.id })
										.from(learningGroups)
										.where(
											and(
												eq(learningGroups.interactionId, row.interactionId),
												eq(learningGroups.streamNumber, reply.streamNumber)
											)
										)
								)
							)
						);
				}
			}

			await recordAuditEvent(
				ctx,
				{
					type: 'exchange.message_sent',
					outcome: 'success',
					...(row.interactionId === null
						? {}
						: { subject: { type: 'interaction', id: row.interactionId } }),
					details: { exchangeMessageId: row.id }
				},
				tx
			);
		});

		return;
	}

	const delay = attempt.temporary ? retryDelaySeconds(row.attempt) : null;

	if (delay === null) {
		await getDb()
			.update(exchangeMessages)
			.set({
				state: 'failed',
				responseStatus: attempt.status,
				lastError: attempt.error,
				nextAttemptAt: null,
				closedAt: sql`now()`
			})
			.where(eq(exchangeMessages.id, row.id));

		await recordAuditEvent(ctx, {
			type: 'exchange.message_failed',
			outcome: 'failure',
			...(row.interactionId === null
				? {}
				: { subject: { type: 'interaction', id: row.interactionId } }),
			details: { exchangeMessageId: row.id }
		});

		return;
	}

	await getDb()
		.update(exchangeMessages)
		.set({
			state: 'retrying',
			responseStatus: attempt.status,
			lastError: attempt.error,
			nextAttemptAt: sql`now() + make_interval(secs => ${delay})`
		})
		.where(eq(exchangeMessages.id, row.id));
}

/**
 * Одна попытка доставки одного сообщения. `null` — сообщение занято другим
 * проходом или его уже не за чем отправлять.
 */
export async function deliverMessage(
	ctx: ActorContext,
	messageId: string
): Promise<Attempt | null> {
	const row = await claim(messageId);

	if (row === null) {
		return null;
	}

	// Сообщение адресовано экземпляру, для которого его поставили в очередь.
	// После смены подключения очередь не уходит новому получателю: у него
	// своя нумерация заявок и групп, и чужой снимок он принял бы как свой.
	if (row.system !== 'cms' && row.system !== 'lms') {
		throw new Error(`Исходящее сообщение ${row.id} без направления обмена: «${row.system}»`);
	}

	const connected = (await getExchangeSettings())[row.system].instance;

	if (row.instance !== connected) {
		await finish(
			ctx,
			row,
			{
				ok: false,
				status: null,
				error: `Сообщение поставлено для экземпляра «${row.instance}», а подключён «${connected}»: подключение сменилось, прежнему получателю отправить нечем, новому оно не адресовано`,
				body: '',
				temporary: false
			},
			null
		);

		return null;
	}

	const target = await targetFor(row);

	if (target === null) {
		// Направление не настроено: сообщение ждёт человека, а не бесконечного
		// таймера. Это не временный отказ — адрес сам не появится.
		await finish(
			ctx,
			row,
			{
				ok: false,
				status: null,
				error: 'Направление обмена не настроено: укажите адрес и секрет в разделе «Интеграции»',
				body: '',
				temporary: false
			},
			null
		);

		return null;
	}

	const envelope = await buildEnvelope(row);

	if (envelope === null) {
		await finish(
			ctx,
			row,
			{
				ok: false,
				status: null,
				error: 'Нечего отправлять: запись, о которой сообщение, уже не существует',
				body: '',
				temporary: false
			},
			null
		);

		return null;
	}

	const attempt = await post(target.url, target.secret, row.id, envelope, target.timeoutMs);

	if (attempt.ok && row.eventType === EXCHANGE_EVENT_TYPES.learningGroupRequested) {
		const reply = parseGroupReply(row, attempt.body, envelope);

		if ('issue' in reply) {
			const refused: Attempt = {
				ok: false,
				status: attempt.status,
				error: reply.issue,
				body: attempt.body,
				temporary: false
			};

			await finish(ctx, row, refused, null);

			return refused;
		}

		await finish(ctx, row, attempt, reply);

		return attempt;
	}

	await finish(ctx, row, attempt, null);

	return attempt;
}

export type ExchangeCycleReport = { sent: number; failed: number; retried: number };

/**
 * Проход по очереди исходящих. Зовётся тем же циклом интеграций, что доставляет
 * вебхуки, и под тем же замком: своего замка не берёт.
 */
export async function runExchangeCycle(ctx: ActorContext): Promise<ExchangeCycleReport> {
	const due = await getDb()
		.select({ id: exchangeMessages.id, attempt: exchangeMessages.attempt })
		.from(exchangeMessages)
		.where(
			and(
				eq(exchangeMessages.direction, 'outbound'),
				inArray(exchangeMessages.state, ['pending', 'retrying']),
				or(isNull(exchangeMessages.nextAttemptAt), lte(exchangeMessages.nextAttemptAt, sql`now()`))
			)
		)
		.orderBy(asc(exchangeMessages.createdAt))
		.limit(BATCH);

	const report: ExchangeCycleReport = { sent: 0, failed: 0, retried: 0 };

	for (const message of due) {
		const attempt = await deliverMessage(ctx, message.id);

		if (attempt === null) {
			continue;
		}

		if (attempt.ok) {
			report.sent += 1;
		} else if (attempt.temporary) {
			report.retried += 1;
		} else {
			report.failed += 1;
		}
	}

	return report;
}
