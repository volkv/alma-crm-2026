/**
 * Одноразовые коды по времени — TOTP (RFC 6238) поверх HOTP (RFC 4226).
 *
 * Модуль намеренно чистый: только `node:crypto`, ни настроек, ни базы, ни
 * SvelteKit. Так его считает и сервер, и сценарий прогона e2e, которому нужно
 * ввести код за человека, — а проверять реализацию можно векторами из самого
 * стандарта, не поднимая приложение.
 *
 * Параметры те, что понимают все приложения-аутентификаторы без настройки:
 * HMAC-SHA1, шесть цифр, шаг тридцать секунд. SHA-1 здесь не слабое место:
 * в HOTP он стоит как хеш-функция для HMAC с секретом, а не как защита от
 * поиска коллизий, и код всё равно живёт полминуты.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Длина шага в секундах: окно, в течение которого код один и тот же. */
export const TOTP_STEP_SECONDS = 30;

/** Сколько цифр в коде. */
export const TOTP_DIGITS = 6;

/**
 * Сколько соседних шагов принимается кроме текущего. Один в обе стороны —
 * запас на расхождение часов телефона и сервера и на то, что человек набирает
 * код не мгновенно. Больше брать нельзя: каждый лишний шаг втрое удлиняет
 * время жизни кода.
 */
export const TOTP_WINDOW = 1;

/**
 * Длина секрета в байтах. RFC 4226 требует не меньше 16, рекомендует 20 — и
 * ровно 20 байт дают 32 символа base32, то есть строку, которую человек ещё
 * может перенести руками, если камера не работает.
 */
const SECRET_BYTES = 20;

/** Алфавит base32, RFC 4648. Тот же, в котором секрет понимают аутентификаторы. */
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * Секрет в base32 без выравнивания `=`.
 *
 * Выравнивание допустимо, но otpauth-ссылку с ним понимают не все приложения,
 * а 20 байт дают ровно 32 символа — выравнивать нечего.
 */
export function base32Encode(bytes: Uint8Array): string {
	let result = '';
	let buffer = 0;
	let bits = 0;

	for (const byte of bytes) {
		buffer = (buffer << 8) | byte;
		bits += 8;

		while (bits >= 5) {
			bits -= 5;
			result += BASE32_ALPHABET[(buffer >> bits) & 0b11111];
		}
	}

	if (bits > 0) {
		result += BASE32_ALPHABET[(buffer << (5 - bits)) & 0b11111];
	}

	return result;
}

/**
 * Разбор base32. Пробелы и дефисы человек ставит сам, переписывая секрет с
 * экрана, — они отбрасываются; всё остальное, чего нет в алфавите, это ошибка,
 * а не повод молча получить другой секрет.
 */
export function base32Decode(value: string): Uint8Array {
	const normalized = value.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase();
	const bytes: number[] = [];
	let buffer = 0;
	let bits = 0;

	for (const character of normalized) {
		const index = BASE32_ALPHABET.indexOf(character);

		if (index === -1) {
			throw new Error(`Секрет не является строкой base32: символ «${character}»`);
		}

		buffer = (buffer << 5) | index;
		bits += 5;

		if (bits >= 8) {
			bits -= 8;
			bytes.push((buffer >> bits) & 0xff);
		}
	}

	return Uint8Array.from(bytes);
}

/** Новый секрет: 160 случайных бит в base32. */
export function generateTotpSecret(): string {
	return base32Encode(randomBytes(SECRET_BYTES));
}

/** Номер шага, на который приходится этот момент времени. */
export function totpCounter(atMs: number): number {
	return Math.floor(atMs / 1000 / TOTP_STEP_SECONDS);
}

/** Момент, когда закончится шаг с этим номером. */
export function totpStepEndsAt(counter: number): number {
	return (counter + 1) * TOTP_STEP_SECONDS * 1000;
}

/** Счётчик HOTP — восемь байт с порядком от старшего, как требует RFC 4226. */
function counterBytes(counter: number): Buffer {
	const bytes = Buffer.alloc(8);
	bytes.writeBigUInt64BE(BigInt(counter));

	return bytes;
}

/**
 * Код для конкретного шага.
 *
 * Динамическое усечение из RFC 4226: младшие четыре бита хеша выбирают, с
 * какого байта брать число, старший бит выбранного слова гасится (знак), и
 * остаток от деления на 10^цифр — это и есть код. Ведущие нули значимы,
 * поэтому результат дополняется до нужной длины.
 */
export function totpCode(secret: string, counter: number): string {
	const digest = createHmac('sha1', Buffer.from(base32Decode(secret)))
		.update(counterBytes(counter))
		.digest();
	const offset = digest[digest.length - 1] & 0x0f;
	const binary =
		((digest[offset] & 0x7f) << 24) |
		(digest[offset + 1] << 16) |
		(digest[offset + 2] << 8) |
		digest[offset + 3];

	return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

/** Код, который показывает приложение в этот момент времени. */
export function totpCodeAt(secret: string, atMs: number): string {
	return totpCode(secret, totpCounter(atMs));
}

/**
 * Приводит набранное человеком к виду кода: аутентификаторы показывают код
 * группами («123 456»), и пробел между группами — это не опечатка.
 */
export function normalizeTotpCode(value: string): string {
	return value.replace(/[\s-]/g, '');
}

/** Похоже ли набранное на код: только цифры и ровно столько, сколько нужно. */
export function isTotpCodeShape(value: string): boolean {
	const normalized = normalizeTotpCode(value);

	return normalized.length === TOTP_DIGITS && /^\d+$/.test(normalized);
}

/**
 * Проверяет код и возвращает номер шага, на котором он сошёлся, или `null`.
 *
 * Номер шага возвращается не для красоты: код действует целое окно, и без
 * отметки «этот шаг уже использован» подсмотренный код можно предъявить
 * второй раз, пока окно не закрылось. Отметку ставит вызывающий — здесь нет
 * состояния.
 *
 * Сравнение постоянного времени. Шесть цифр перебором по времени ответа не
 * узнать, но правило одно на все сравнения секретов, и исключение из него
 * пришлось бы каждый раз обосновывать заново.
 */
export function verifyTotp(
	secret: string,
	code: string,
	options: { at: number; window?: number }
): number | null {
	const normalized = normalizeTotpCode(code);

	if (!isTotpCodeShape(normalized)) {
		return null;
	}

	const window = options.window ?? TOTP_WINDOW;
	const current = totpCounter(options.at);
	const expected = Buffer.from(normalized, 'utf8');

	for (let shift = -window; shift <= window; shift += 1) {
		const counter = current + shift;

		if (counter < 0) {
			continue;
		}

		const candidate = Buffer.from(totpCode(secret, counter), 'utf8');

		if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) {
			return counter;
		}
	}

	return null;
}

/**
 * Ссылка `otpauth://`, которую читает камера аутентификатора.
 *
 * Издатель повторяется дважды — в метке и в параметре: первый вид понимают
 * старые приложения, второй описан в спецификации Key Uri Format. Алгоритм,
 * число цифр и шаг названы явно, хотя это и значения по умолчанию: приложение,
 * которое понимает их иначе, будет показывать чужие коды молча.
 */
export function otpauthUri(input: { issuer: string; account: string; secret: string }): string {
	const label = `${encodeURIComponent(input.issuer)}:${encodeURIComponent(input.account)}`;
	const query = new URLSearchParams({
		secret: input.secret,
		issuer: input.issuer,
		algorithm: 'SHA1',
		digits: String(TOTP_DIGITS),
		period: String(TOTP_STEP_SECONDS)
	});

	return `otpauth://totp/${label}?${query.toString()}`;
}

/** Секрет в том виде, в каком его переносят руками: группами по четыре символа. */
export function formatSecretForHuman(secret: string): string {
	return (secret.match(/.{1,4}/g) ?? []).join(' ');
}
