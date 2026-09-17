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
import {
	EXCHANGE_EVENT_TYPES,
	EXCHANGE_SCHEMA_VERSION,
	learningGroupReplySchema
} from '$lib/contracts/exchange';
import type { ActorContext } from '../../actor';
import { recordAuditEvent } from '../../audit';
import { getDb } from '../../db';
import { exchangeMessages, learningGroups } from '../../db/schema';
import { retryDelaySeconds, signPayload } from '../delivery';
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

function describeFailure(error: unknown, timeoutMs: number): string {
	if (error instanceof Error) {
		if (error.name === 'TimeoutError' || error.name === 'AbortError') {
			return `Получатель не ответил за ${timeoutMs / 1000} с`;
		}

		const cause = error.cause;
		const code =
			cause !== null && typeof cause === 'object' && 'code' in cause
				? String((cause as { code: unknown }).code)
				: null;

		return code === null
			? `Не удалось отправить: ${error.message}`
			: `Не удалось отправить: ${code}`;
	}

	return `Не удалось отправить: ${String(error)}`;
}

/**
 * Одна попытка. Исключений не бросает: неудача — обычный исход доставки, и
 * решение о повторе принимает очередь, а не обработчик ошибки.
 */
async function post(
	url: string,
	secret: string,
	messageId: string,
	envelope: unknown,
	timeoutMs: number
): Promise<Attempt> {
	const body = JSON.stringify(envelope);
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
 * Тело собирается **в момент отправки**, а не в момент постановки: снимок,
 * собранный два часа назад, уехал бы устаревшим и противоречил бы правилу
 * «сообщение старше применённого не применяется».
 */
async function buildEnvelope(row: MessageRow): Promise<Record<string, unknown> | null> {
	const data =
		row.eventType === EXCHANGE_EVENT_TYPES.applicationStatus
			? await buildApplicationStatus(row.interactionId, row.externalId)
			: await buildLearningGroupRequest(row.payload);

	if (data === null) {
		return null;
	}

	return {
		schemaVersion: EXCHANGE_SCHEMA_VERSION,
		eventId: row.eventId,
		eventType: row.eventType,
		occurredAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
		source: { system: 'crm', instance: CRM_INSTANCE },
		data
	};
}

/** Ответ системы обучения на заявку: группа получает имя у себя. */
async function applyGroupReply(row: MessageRow, body: string): Promise<void> {
	let parsed: unknown;

	try {
		parsed = JSON.parse(body);
	} catch {
		// Не JSON: заявку приняли, но имени группы не назвали. Это не отказ
		// доставки — сообщение ушло, — но и связи с группой у нас нет, и делать
		// вид, что есть, нельзя.
		return;
	}

	const reply = learningGroupReplySchema.safeParse(parsed);

	if (!reply.success || row.interactionId === null) {
		return;
	}

	const streamNumber = Number((row.payload as { streamNumber?: unknown }).streamNumber);

	if (!Number.isInteger(streamNumber)) {
		return;
	}

	await getDb()
		.update(learningGroups)
		.set({ groupExternalId: reply.data.data.groupExternalId })
		.where(
			and(
				eq(learningGroups.interactionId, row.interactionId),
				eq(learningGroups.streamNumber, streamNumber)
			)
		);
}

async function finish(
	ctx: ActorContext,
	row: MessageRow,
	attempt: Attempt,
	envelope: Record<string, unknown> | null
): Promise<void> {
	if (attempt.ok) {
		await getDb()
			.update(exchangeMessages)
			.set({
				state: 'sent',
				responseStatus: attempt.status,
				lastError: null,
				nextAttemptAt: null,
				closedAt: sql`now()`,
				payload: envelope ?? row.payload
			})
			.where(eq(exchangeMessages.id, row.id));

		if (row.eventType === EXCHANGE_EVENT_TYPES.learningGroupRequested) {
			await applyGroupReply(row, attempt.body);
		}

		await recordAuditEvent(ctx, {
			type: 'exchange.message_sent',
			outcome: 'success',
			...(row.interactionId === null
				? {}
				: { subject: { type: 'interaction', id: row.interactionId } }),
			details: { exchangeMessageId: row.id }
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
				closedAt: sql`now()`,
				payload: envelope ?? row.payload
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
			nextAttemptAt: sql`now() + make_interval(secs => ${delay})`,
			payload: envelope ?? row.payload
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

	await finish(ctx, row, attempt, envelope);

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
