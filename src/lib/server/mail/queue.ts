/**
 * Письма вузу в фоне: одна очередь на описание программ, пакет документов и
 * приглашение на встречу.
 *
 * Нажатие «Отправить» проверяет всё, что проверяется без почтового сервера
 * (права, область дела, получатели и файлы из этого дела, размер, политика
 * почты), и ставит задание строкой `outbound_mail_jobs` в своей транзакции —
 * окно получает ответ сразу. Письма шлёт обработчик вида письма уже после
 * фиксации, по одному получателю, как и прежде, и сам пишет след в деле:
 * строку истории, отметку пункта, факт модуля.
 *
 * Кто шлёт — два пути к одной и той же функции {@link processOutboundMailJob}:
 * - сразу после фиксации постановки, в том же процессе (`afterCommit`), чтобы
 *   письмо ушло через секунду, а не через проход цикла;
 * - проходом цикла интеграций под его замком в Redis (`integrations/pump.ts`)
 *   — подбирает задания, чей процесс перезапустился раньше, чем их взял.
 * Взять задание можно только условной правкой строки `queued → sending`,
 * поэтому два пути одно письмо дважды не отправят.
 *
 * Повторов нет намеренно. Получатели — люди снаружи, и повтор после
 * «ушло не всем» — второе письмо тому, кому первое уже пришло. Задание,
 * застрявшее в `sending` дольше срока захвата (процесс умер посреди
 * отправки), не перезапускается, а закрывается неудачей с причиной: часть
 * писем могла уйти, и решать, слать ли снова, — человеку.
 *
 * Ушло не всем или не ушло вовсе — событие журнала с исходом `failure` и
 * строка в колокольчике отправителя: та же строка задания (`inbox/index.ts`).
 *
 * Обработчики находятся по виду задания лениво, динамическим импортом: сервисы
 * писем сами ставят задания отсюда, и статический импорт замкнул бы модули друг
 * на друга. Виды модулей (`<модуль>:<вид>`) объявляет серверная часть карточки
 * модуля (`mail` в `defineCardServer`), и находит их реестр платформы.
 */
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import type { AuditEventType } from '$lib/contracts/audit';
import {
	OUTBOUND_MAIL_IN_FLIGHT,
	type OutboundMailInFlightView,
	type OutboundMailStatus
} from '$lib/contracts/outbound-mail';
import { systemActor, type ActorContext } from '../actor';
import { recordAuditEvent } from '../audit';
import { loadSessionUser } from '../auth/session';
import { getDb } from '../db';
import { outboundMailJobs, type OutboundMailPayload } from '../db/schema';
import { afterCommit, type Tx } from '../db/transaction';
import { AppError, ForbiddenError, ValidationError } from '../errors';
import type { OutboundOutcome } from './outbound';

/** Задание, как его получает обработчик: идентификаторы, без адресов и имён. */
export type OutboundMailJob = {
	id: string;
	kind: string;
	label: string;
	interactionId: string;
	senderUserId: string;
	test: boolean;
	payload: OutboundMailPayload;
	createdAt: Date;
};

/**
 * Что вышло у обработчика. `refused` — отказ до соединения (песочница,
 * закрытая почта): он одинаков для всех, и остальных после него не пробуют.
 */
export type OutboundMailResult = {
	sentCount: number;
	failedCount: number;
	refused: string | null;
	/** Первая причина, по которой письмо не ушло; `null` — ушло всем. */
	error: string | null;
};

/**
 * Обработчик вида письма. `deliver` зовётся от имени отправителя, с его
 * действующими правами: проверки по делу он повторяет сам, пишет след и
 * события журнала об исходе. Исключение из него — отказ всей отправки; его
 * очередь записывает событием `auditType`.
 */
export type OutboundMailHandler = {
	auditType: (job: OutboundMailJob) => AuditEventType;
	deliver: (ctx: ActorContext, job: OutboundMailJob) => Promise<OutboundMailResult>;
};

/**
 * Список идентификаторов из данных задания; поля нет — пусто. Задание ставит
 * только код продукта, поэтому чужая форма поля — нарушение данных, а не ввод.
 */
export function payloadIds(job: OutboundMailJob, key: string): string[] {
	const value = job.payload[key];

	if (value === undefined || value === null) {
		return [];
	}

	if (!Array.isArray(value)) {
		throw new Error(`Задание ${job.id}: поле «${key}» — не список идентификаторов`);
	}

	return value;
}

/**
 * Сколько задание держит взявший его обработчик. С большим запасом: в
 * приглашении до тридцати участников, и каждый неотвечающий сервер держит
 * попытку до таймаута почты в пять секунд.
 */
const LOCK_MINUTES = 10;

/** Сколько ждущих заданий проход цикла разбирает за раз. */
const BATCH = 20;

/** Почему прерванное задание закрыто неудачей, а не отправлено заново. */
export const OUTBOUND_MAIL_INTERRUPTED =
	'Отправка прервалась: сервер перезапустился посреди неё, и часть писем могла уйти. Проверьте ленту дела и отправьте снова, если нужно';

/** Почему письмо не ушло, если отправитель больше не может его отправить. */
const SENDER_GONE = 'Учётная запись отправителя выключена: письмо не отправлено от его имени';

/** Виды писем ядра. */
export const PROGRAM_OFFER_MAIL_KIND = 'program_offer';
export const PACKAGE_SEND_MAIL_KIND = 'document_package';

/** Обработчики ядра — ленивым импортом, см. шапку. */
const CORE_HANDLERS: Record<string, () => Promise<OutboundMailHandler>> = {
	[PROGRAM_OFFER_MAIL_KIND]: async () =>
		(await import('../interactions/program-offer')).programOfferMail,
	[PACKAGE_SEND_MAIL_KIND]: async () =>
		(await import('../interactions/document-package-send')).documentPackageMail
};

/** Исход одного письма (тестового себе) как исход задания. */
export function singleMailResult(outcome: OutboundOutcome): OutboundMailResult {
	return outcome.status === 'sent'
		? { sentCount: 1, failedCount: 0, refused: null, error: null }
		: {
				sentCount: 0,
				failedCount: outcome.status === 'failed' ? 1 : 0,
				refused: outcome.status === 'refused' ? outcome.error : null,
				error: outcome.error
			};
}

async function handlerFor(kind: string): Promise<OutboundMailHandler | null> {
	const core = CORE_HANDLERS[kind];

	if (core !== undefined) {
		return core();
	}

	const { moduleMailHandler } = await import('$lib/platform/card-registry.server');

	return moduleMailHandler(kind);
}

export type OutboundMailRequest = {
	kind: string;
	label: string;
	interactionId: string;
	test: boolean;
	payload: OutboundMailPayload;
};

/**
 * Поставить письмо в очередь — транзакцией вызывающего: откатится она, не
 * останется и задания. Отправка начнётся после фиксации.
 */
export async function enqueueOutboundMail(
	ctx: ActorContext,
	tx: Tx,
	request: OutboundMailRequest
): Promise<string> {
	if (ctx.user === null) {
		throw new ForbiddenError('Письмо вузу отправляет пользователь, а не фоновая задача');
	}

	const [row] = await tx
		.insert(outboundMailJobs)
		.values({
			kind: request.kind,
			label: request.label,
			interactionId: request.interactionId,
			senderUserId: ctx.user.id,
			test: request.test,
			source: ctx.source,
			requestId: ctx.requestId,
			payload: request.payload
		})
		.returning({ id: outboundMailJobs.id });

	afterCommit(tx, async () => wakeOutboundMail(row.id));

	return row.id;
}

/**
 * Взяться за задание сразу, не дожидаясь цикла. Не ждёт отправки: ответ окну
 * уже ушёл, и у фоновой работы нет адресата, кроме лога.
 *
 * Под Vitest не запускается, как и таймеры цикла (`hooks.server.ts`):
 * проверки зовут обработчик сами и проверяют, что до него почта не тронута.
 */
function wakeOutboundMail(jobId: string): void {
	if (process.env.VITEST !== undefined) {
		return;
	}

	void processOutboundMailJob(jobId).catch((error: unknown) =>
		console.error(`[mail] задание ${jobId} не обработано`, error)
	);
}

const jobColumns = {
	id: outboundMailJobs.id,
	kind: outboundMailJobs.kind,
	label: outboundMailJobs.label,
	interactionId: outboundMailJobs.interactionId,
	senderUserId: outboundMailJobs.senderUserId,
	test: outboundMailJobs.test,
	source: outboundMailJobs.source,
	requestId: outboundMailJobs.requestId,
	payload: outboundMailJobs.payload,
	createdAt: outboundMailJobs.createdAt
};

type ClaimedJob = OutboundMailJob & { source: ActorContext['source']; requestId: string };

/** Взять ждущее задание; `null` — его уже взял другой или оно не ждёт. */
async function claim(jobId: string): Promise<ClaimedJob | null> {
	const [row] = await getDb()
		.update(outboundMailJobs)
		.set({
			status: 'sending',
			lockedUntil: sql`now() + make_interval(mins => ${LOCK_MINUTES})`,
			updatedAt: sql`now()`
		})
		.where(and(eq(outboundMailJobs.id, jobId), eq(outboundMailJobs.status, 'queued')))
		.returning(jobColumns);

	return row ?? null;
}

type Settled = {
	status: Exclude<OutboundMailStatus, 'queued' | 'sending'>;
	sentCount: number;
	failedCount: number;
	error: string | null;
};

function settle(result: OutboundMailResult): Settled {
	const status =
		result.sentCount > 0
			? result.failedCount === 0
				? 'sent'
				: 'partial'
			: result.refused !== null
				? 'refused'
				: 'failed';

	return {
		status,
		sentCount: result.sentCount,
		failedCount: result.failedCount,
		error:
			status === 'sent'
				? null
				: (result.refused ?? result.error ?? 'Почтовый сервер не принял ни одного письма')
	};
}

/** Адрес почты в тексте причины. */
const EMAIL_IN_TEXT = /[^\s<>()"',;:]+@[^\s<>()"',;:]+\.[^\s<>()"',;:]+/g;

/**
 * Причина — без адресов: почтовый сервер называет отвергнутый адрес в ответе,
 * а причина живёт в строке задания и показывается в колокольчике на любом
 * экране. Кому не ушло, видно по имени; адрес — в карточке человека.
 */
function withoutAddresses(text: string | null): string | null {
	return text === null ? null : text.replace(EMAIL_IN_TEXT, '[адрес скрыт]');
}

function refusalText(error: AppError): string {
	return error instanceof ValidationError && error.issues.length > 0
		? `${error.message}: ${error.issues.join('; ')}`
		: error.message;
}

/** Контекст отправителя — по его идентификатору и с его правами на сейчас. */
async function senderContext(job: ClaimedJob): Promise<ActorContext | null> {
	const user = await loadSessionUser(job.senderUserId);

	return user === null
		? null
		: {
				requestId: job.requestId,
				source: job.source,
				user,
				apiKeyId: null,
				ip: null,
				userAgent: null,
				scope: user.scope
			};
}

async function recordFailure(
	ctx: ActorContext,
	handler: OutboundMailHandler,
	job: OutboundMailJob
): Promise<void> {
	await recordAuditEvent(ctx, {
		type: handler.auditType(job),
		outcome: 'failure',
		subject: { type: 'interaction', id: job.interactionId },
		details: { mailJobId: job.id, recipientCount: 0 }
	});
}

async function deliverClaimed(job: ClaimedJob): Promise<Settled> {
	const handler = await handlerFor(job.kind);

	if (handler === null) {
		// Вид письма ставит только код продукта: незнакомый — ошибка поставки
		// (модуль выключили из сборки с заданиями в очереди), а не ввод человека.
		console.error(`[mail] задание ${job.id}: неизвестный вид письма «${job.kind}»`);

		return {
			status: 'failed',
			sentCount: 0,
			failedCount: 0,
			error: 'Письмо этого вида установка больше не отправляет'
		};
	}

	const ctx = await senderContext(job);

	if (ctx === null) {
		await recordFailure(systemActor(job.requestId), handler, job);

		return { status: 'refused', sentCount: 0, failedCount: 0, error: SENDER_GONE };
	}

	try {
		return settle(await handler.deliver(ctx, job));
	} catch (error) {
		await recordFailure(ctx, handler, job);

		if (error instanceof AppError) {
			return { status: 'refused', sentCount: 0, failedCount: 0, error: refusalText(error) };
		}

		console.error(`[mail] задание ${job.id} (${job.kind}) упало`, error);

		return {
			status: 'failed',
			sentCount: 0,
			failedCount: 0,
			error: 'Письмо не отправлено: внутренняя ошибка сервера'
		};
	}
}

/**
 * Отправить одно задание, если оно ещё ждёт. Возвращает исход; `null` — его
 * взял кто-то другой или оно уже закончено.
 */
export async function processOutboundMailJob(jobId: string): Promise<OutboundMailStatus | null> {
	const job = await claim(jobId);

	if (job === null) {
		return null;
	}

	const settled = await deliverClaimed(job);

	await getDb()
		.update(outboundMailJobs)
		.set({
			status: settled.status,
			sentCount: settled.sentCount,
			failedCount: settled.failedCount,
			lastError: withoutAddresses(settled.error),
			lockedUntil: null,
			finishedAt: sql`now()`,
			updatedAt: sql`now()`
		})
		.where(and(eq(outboundMailJobs.id, job.id), eq(outboundMailJobs.status, 'sending')));

	return settled.status;
}

/**
 * Закрыть неудачей задания, застрявшие посреди отправки: процесс, который их
 * взял, умер, а срок захвата прошёл.
 */
async function abandonInterrupted(): Promise<number> {
	const abandoned = await getDb()
		.update(outboundMailJobs)
		.set({
			status: 'failed',
			lastError: OUTBOUND_MAIL_INTERRUPTED,
			lockedUntil: null,
			finishedAt: sql`now()`,
			updatedAt: sql`now()`
		})
		.where(
			and(eq(outboundMailJobs.status, 'sending'), lt(outboundMailJobs.lockedUntil, sql`now()`))
		)
		.returning(jobColumns);

	for (const job of abandoned) {
		const handler = await handlerFor(job.kind);

		if (handler !== null) {
			await recordFailure(systemActor(randomUUID()), handler, job);
		}
	}

	return abandoned.length;
}

/** Что проход сделал: числа для лога и проверок. */
export type OutboundMailReport = { processed: number; interrupted: number };

/**
 * Проход по очереди: сперва закрыть прерванные, потом разобрать ждущие, по
 * одному и по порядку постановки. Зовётся циклом интеграций под его замком и
 * проверками напрямую.
 */
export async function runOutboundMailCycle(): Promise<OutboundMailReport> {
	const interrupted = await abandonInterrupted();
	const due = await getDb()
		.select({ id: outboundMailJobs.id })
		.from(outboundMailJobs)
		.where(eq(outboundMailJobs.status, 'queued'))
		.orderBy(asc(outboundMailJobs.createdAt))
		.limit(BATCH);

	let processed = 0;

	for (const { id } of due) {
		if ((await processOutboundMailJob(id)) !== null) {
			processed += 1;
		}
	}

	return { processed, interrupted };
}

/**
 * Не идёт ли уже отправка такого письма по делу: окно показывает это, чтобы
 * второе нажатие не делалось вслепую. Тестовые письма себе не в счёт.
 */
export async function readOutboundMailInFlight(
	interactionId: string,
	kind: string
): Promise<OutboundMailInFlightView> {
	const [row] = await getDb()
		.select({ createdAt: outboundMailJobs.createdAt })
		.from(outboundMailJobs)
		.where(
			and(
				eq(outboundMailJobs.interactionId, interactionId),
				eq(outboundMailJobs.kind, kind),
				eq(outboundMailJobs.test, false),
				inArray(outboundMailJobs.status, [...OUTBOUND_MAIL_IN_FLIGHT])
			)
		)
		.orderBy(desc(outboundMailJobs.createdAt))
		.limit(1);

	return row === undefined ? null : { queuedAt: row.createdAt.toISOString() };
}
