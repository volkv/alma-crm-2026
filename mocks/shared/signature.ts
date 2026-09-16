/**
 * Подпись сообщений, которые CRM отправляет наружу.
 *
 * Формат задан контрактом обмена (`docs/exchange-contract.md`, раздел 2) и
 * совпадает с подписью вебхуков: заголовки `X-Exchange-Id`,
 * `X-Exchange-Timestamp` и `X-Exchange-Signature` со значением
 * `sha256=<HMAC-SHA256(секрет, "<timestamp>.<тело>")>`.
 *
 * Проверка написана здесь заново, а не взята из кода продукта, намеренно:
 * имитатор изображает чужую систему и живёт отдельным процессом без
 * зависимостей — ровно так же подпись проверяет у себя настоящий получатель
 * (пример для него — в `docs/integrations.md`). Общая функция означала бы, что
 * подпись сверяется сама с собой и расхождение формата останется незамеченным.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Насколько давним может быть момент подписи. Запрос старше — повтор
 * перехваченного: подпись у него верная, а смысла в нём нет.
 */
export const SIGNATURE_WINDOW_SECONDS = 300;

/** Подпись тела: `sha256=<HMAC-SHA256(секрет, "<timestamp>.<тело>")>` в hex. */
export function signPayload(secret: string, timestamp: string, body: string): string {
	return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

/** Сверка постоянная по времени: по обычному сравнению подпись подбирается побайтно. */
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

/** Почему запрос не принят: код ответа и объяснение отправителю. */
export type SignatureRefusal = { status: number; code: string; message: string };

/**
 * Проверяет подпись входящего запроса. `null` — подпись сошлась.
 *
 * Секрета нет — запрос отвергается, а не принимается «как есть»: имитатор без
 * секрета не может отличить CRM от кого угодно ещё, и притворяться, что может,
 * значило бы показать на стенде проверку, которой не было.
 */
export function checkSignature(options: {
	secret: string | null;
	headers: Record<string, string>;
	body: string;
	now?: Date;
}): SignatureRefusal | null {
	const { secret, headers, body } = options;

	if (secret === null || secret === '') {
		return {
			status: 503,
			code: 'not_configured',
			message: 'Секрет обмена не задан (EXCHANGE_SECRET) — проверить подпись нечем'
		};
	}

	const timestamp = headers['x-exchange-timestamp'] ?? '';
	const signature = headers['x-exchange-signature'] ?? '';

	if (timestamp === '' || signature === '') {
		return {
			status: 401,
			code: 'unsigned',
			message: 'Нет заголовков X-Exchange-Timestamp и X-Exchange-Signature'
		};
	}

	const seconds = Number(timestamp);
	const now = (options.now ?? new Date()).getTime() / 1000;

	if (!Number.isFinite(seconds) || Math.abs(now - seconds) > SIGNATURE_WINDOW_SECONDS) {
		return {
			status: 401,
			code: 'stale_signature',
			message: `Момент подписи отличается от текущего больше чем на ${SIGNATURE_WINDOW_SECONDS} с`
		};
	}

	if (!verifySignature(secret, timestamp, body, signature)) {
		return { status: 401, code: 'bad_signature', message: 'Подпись не сошлась' };
	}

	return null;
}
