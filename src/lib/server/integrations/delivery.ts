/**
 * Доставка одного события в одну подписку: подпись, отправка, разбор ответа.
 *
 * Здесь нет ни очереди, ни решения «кому слать» — только то, что происходит с
 * единственным телом запроса. Поэтому эту функцию зовёт и цикл доставки, и
 * кнопка «отправить тестовое событие», и проверки: путь до получателя один.
 *
 * Подпись считается от строки `<timestamp>.<тело>`, а не от одного тела:
 * иначе перехваченный запрос можно повторить через сутки, и подпись сойдётся.
 * Получателю полагается сверить свою подпись и отбросить запрос с давним
 * `X-Webhook-Timestamp` — как это делает проверка из `docs/integrations.md`.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { WebhookPayload } from '$lib/contracts/integrations';
import { outboundTargetIssue } from './outbound';

/** Сколько ждём получателя. Дольше — и цикл доставки встанет на одном адресе. */
export const WEBHOOK_TIMEOUT_MS = 5_000;

/**
 * Задержки перед повторами. Первая попытка идёт сразу, дальше — по этому
 * списку: пятнадцать секунд закрывают перезапуск получателя, два часа —
 * рабочее утро того, кто его чинит. После последней задержки доставка
 * признаётся несостоявшейся: держать событие вечно значит копить очередь,
 * которую никто не разберёт.
 */
export const RETRY_DELAYS_SECONDS = [15, 60, 5 * 60, 30 * 60, 120 * 60] as const;

/** Всего попыток на событие: первая плюс по одной на каждую задержку. */
export const MAX_DELIVERY_ATTEMPTS = RETRY_DELAYS_SECONDS.length + 1;

/**
 * Через сколько секунд повторять после неудачной попытки номер `attempt`
 * (нумерация с единицы). `null` — повторять больше не будем.
 */
export function retryDelaySeconds(attempt: number): number | null {
	if (!Number.isInteger(attempt) || attempt < 1) {
		throw new RangeError(`Номер попытки — целое число с единицы, получено ${attempt}`);
	}

	return RETRY_DELAYS_SECONDS[attempt - 1] ?? null;
}

/** Сколько живёт тело неотправленного события: до конца последней задержки плюс запас. */
export const PENDING_TTL_SECONDS =
	RETRY_DELAYS_SECONDS.reduce((total, delay) => total + delay, 0) + 24 * 60 * 60;

/**
 * Подпись тела: `sha256=<HMAC-SHA256(секрет, "<timestamp>.<тело>")>` в
 * шестнадцатеричном виде. Формат назван в заголовке, чтобы алгоритм можно было
 * сменить, не ломая разбор у получателя.
 */
export function signPayload(secret: string, timestamp: string, body: string): string {
	return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

/**
 * Сверка подписи — та же функция, что у получателя. Сравнение постоянное по
 * времени: по обычному сравнению строк подпись подбирается побайтно.
 */
export function verifySignature(
	secret: string,
	timestamp: string,
	body: string,
	signature: string
): boolean {
	const expected = Buffer.from(signPayload(secret, timestamp, body), 'utf8');
	const actual = Buffer.from(signature, 'utf8');

	return expected.byteLength === actual.byteLength && timingSafeEqual(expected, actual);
}

/** Чем кончилась попытка: ответ получателя или объяснение, почему его нет. */
export type DeliveryOutcome = {
	ok: boolean;
	/** Код ответа; `null` — до ответа дело не дошло. */
	status: number | null;
	/** Что не так — словами, для экрана и для журнала. */
	error: string | null;
};

/** Сообщение об ошибке отправки — по-русски и без стека. */
function describeFailure(error: unknown): string {
	if (error instanceof Error) {
		if (error.name === 'TimeoutError' || error.name === 'AbortError') {
			return `Получатель не ответил за ${WEBHOOK_TIMEOUT_MS / 1000} с`;
		}

		// У ошибок сети сообщение короткое и по делу («fetch failed»), а причина
		// лежит в `cause` — там же код вроде ECONNREFUSED, ради которого сотрудник
		// и открыл этот экран.
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

export type DeliveryTarget = { id: string; url: string; secret: string };

/**
 * Одна попытка доставки. Исключений не бросает: неудача — это обычный исход
 * доставки, и решение о повторе принимает цикл, а не обработчик ошибки.
 *
 * Адрес проверяется здесь, а не только при заведении подписки: имя, которое в
 * день заведения указывало наружу, к моменту доставки указывает куда угодно
 * (перепривязка DNS), и проверка «когда-то давно» не значит ничего.
 *
 * За перенаправлением запрос не идёт. Адрес подписки проверен, а
 * перенаправление ведёт куда угодно — и унесло бы туда и тело события, и
 * подпись, то есть отдало бы чужой машине и данные, и право выдавать себя за
 * нас. Ответ `3xx` — такая же неудача, как и любая другая, и получатель узнаёт
 * о ней словами.
 */
export async function postWebhook(
	target: DeliveryTarget,
	payload: WebhookPayload
): Promise<DeliveryOutcome> {
	const refusal = await outboundTargetIssue(target.url);

	if (refusal !== null) {
		return { ok: false, status: null, error: refusal };
	}

	const body = JSON.stringify(payload);
	const timestamp = String(Math.floor(Date.now() / 1000));

	try {
		const response = await fetch(target.url, {
			method: 'POST',
			headers: {
				'content-type': 'application/json; charset=utf-8',
				'X-Webhook-Id': target.id,
				'X-Webhook-Timestamp': timestamp,
				'X-Webhook-Signature': signPayload(target.secret, timestamp, body)
			},
			body,
			redirect: 'manual',
			signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS)
		});

		if (response.ok) {
			return { ok: true, status: response.status, error: null };
		}

		if (response.status >= 300 && response.status < 400) {
			return {
				ok: false,
				status: response.status,
				error: `Получатель перенаправляет запрос (${response.status}); тело и подпись уходят только на проверенный адрес — укажите в подписке конечный`
			};
		}

		return {
			ok: false,
			status: response.status,
			error: `Получатель ответил ${response.status}`
		};
	} catch (error) {
		return { ok: false, status: null, error: describeFailure(error) };
	}
}
