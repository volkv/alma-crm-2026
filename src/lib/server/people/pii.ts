/**
 * Контакты человека в базе: шифртекст и ключ сравнения.
 *
 * Почта и телефон — персональные данные, и маскирования по правам им мало:
 * маскирование защищает экран, а `select * from people` в консоли базы его не
 * спрашивает. Поэтому оба поля лежат зашифрованными (AES-256-GCM, случайный
 * вектор на каждое значение), а ключ приходит из окружения и в репозитории его
 * нет. Без ключа строка `people` не говорит ни адреса, ни номера.
 *
 * Шифртекст сравнивать нельзя: одно и то же значение даёт разный шифртекст
 * каждый раз — иначе одинаковые адреса были бы видны по одинаковым строкам.
 * Поэтому рядом лежит детерминированный ключ сравнения: HMAC-SHA256 по
 * нормализованному значению, ключом, выведенным из того же секрета. По нему
 * работают дедупликация заявок и импорта и поиск по точному контакту; по
 * подстроке контакта искать нельзя вовсе — этого не умеет ни один шифр,
 * который стоит своего названия.
 *
 * Модуль — единственное место, которое знает, как контакт лежит в базе:
 * запись собирает {@link contactColumns}, чтение возвращает
 * {@link decryptContacts} и сериализатор `serialize.ts`. Сторож
 * `tests/unit/people/pii-guard.test.ts` следит, чтобы колонки не читали мимо.
 */
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { env } from '$env/dynamic/private';
import { readPiiEncryptionKey } from '../config';

/** Шифр: аутентифицированный, иначе испорченный шифртекст расшифровался бы в мусор. */
const ALGORITHM = 'aes-256-gcm';

/** Длина вектора инициализации GCM в байтах — рекомендованные 96 бит. */
const NONCE_BYTES = 12;

/** Длина тега аутентификации в байтах. */
const TAG_BYTES = 16;

/** Длина выводимых ключей в байтах. */
const DERIVED_KEY_BYTES = 32;

/** Начало хранимого значения: по нему видно, что строка уже зашифрована. */
export const ENCRYPTED_CONTACT_PREFIX = 'enc:';

/**
 * Версия формата. Меняется вместе со схемой хранения или ключом: строка старой
 * версии не расшифровывается молча и не переписывается сама — ротация ключа
 * это отдельная работа, а не побочный эффект чтения.
 */
const VERSION = 'v1';

/** Сколько частей в хранимом значении: `enc`, версия, вектор, шифртекст, тег. */
const PARTS = 5;

/** Контакты в том виде, в каком они лежат в строке `people` или приходят в неё. */
export type Contacts = {
	email: string | null;
	phone: string | null;
};

/** Все четыре колонки контактов: шифртекст и ключи сравнения рядом. */
export type ContactColumns = Contacts & {
	emailHash: string | null;
	phoneHash: string | null;
};

/**
 * Контакт лежит не в том виде, в каком его ждут: строку писали мимо этого
 * модуля, шифртекст испорчен или ключ в окружении не тот.
 */
export class PiiCryptoError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = 'PiiCryptoError';
	}
}

type DerivedKeys = {
	/** Ключ шифрования контактов. */
	cipher: Buffer;
	/** Ключ, которым считается детерминированный ключ сравнения. */
	mac: Buffer;
};

let derived: DerivedKeys | undefined;

/**
 * Два ключа из одного секрета, через HKDF: шифровать и считать HMAC одним и тем
 * же ключом нельзя, а держать в окружении две переменные вместо одной — значит
 * однажды получить установку, где поменяли только одну.
 *
 * Секрет читается при первом обращении, а не при загрузке модуля: миграция и
 * сид подтягивают этот файл ради типов задолго до того, как им понадобится
 * ключ, и падение на импорте сказало бы не о том.
 */
function keys(): DerivedKeys {
	if (derived === undefined) {
		const master = readPiiEncryptionKey(env);

		derived = {
			cipher: Buffer.from(
				hkdfSync('sha256', master, '', 'lct.pii.aes-256-gcm.v1', DERIVED_KEY_BYTES)
			),
			mac: Buffer.from(hkdfSync('sha256', master, '', 'lct.pii.hmac-sha256.v1', DERIVED_KEY_BYTES))
		};
	}

	return derived;
}

/** Строка уже зашифрована этим модулем. */
export function isEncryptedContact(value: string): boolean {
	return value.startsWith(ENCRYPTED_CONTACT_PREFIX);
}

/**
 * Контакт в том виде, в каком он ложится в колонку:
 * `enc:v1:<вектор>:<шифртекст>:<тег>`, всё в base64.
 *
 * Разделитель — двоеточие, которого в base64 нет, поэтому разбор обратно
 * однозначен, а версия и вид упаковки читаются глазами в любой выборке.
 */
export function encryptContact(value: string): string {
	const nonce = randomBytes(NONCE_BYTES);
	// Длина тега названа явно: у GCM она допускает восемь значений, и умолчание
	// библиотеки — не то же самое, что закреплённое решение. Здесь она
	// закреплена на обоих концах, чтобы расшифровка не согласилась на
	// укороченный тег, который подобрать в 2^32 раз дешевле.
	const cipher = createCipheriv(ALGORITHM, keys().cipher, nonce, { authTagLength: TAG_BYTES });
	const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);

	return [
		'enc',
		VERSION,
		nonce.toString('base64'),
		ciphertext.toString('base64'),
		cipher.getAuthTag().toString('base64')
	].join(':');
}

/**
 * Обратно. Открытая строка, чужая версия и испорченный тег — это отказ, а не
 * значение по умолчанию: контакт, прочитанный «как-нибудь», хуже отсутствующего.
 */
export function decryptContact(stored: string): string {
	const parts = stored.split(':');

	if (parts.length !== PARTS || parts[0] !== 'enc') {
		throw new PiiCryptoError('Контакт лежит в базе незашифрованным: строку писали мимо pii.ts');
	}

	if (parts[1] !== VERSION) {
		throw new PiiCryptoError(`Контакт зашифрован неизвестной версией формата: «${parts[1]}»`);
	}

	const nonce = Buffer.from(parts[2], 'base64');
	const ciphertext = Buffer.from(parts[3], 'base64');
	const tag = Buffer.from(parts[4], 'base64');

	// Длины проверяются до вызова шифра, а не им: GCM принимает восемь длин
	// тега, и укороченный тег он проверил бы молча — а подобрать его тем
	// дешевле, чем он короче. Значение не той формы — повреждённое значение, и
	// сказать об этом надо тем же языком, что и про остальные поломки формата.
	if (nonce.length !== NONCE_BYTES) {
		throw new PiiCryptoError(
			`Повреждённое значение контакта: вектор длиной ${nonce.length} байт вместо ${NONCE_BYTES}`
		);
	}

	if (tag.length !== TAG_BYTES) {
		throw new PiiCryptoError(
			`Повреждённое значение контакта: тег длиной ${tag.length} байт вместо ${TAG_BYTES}`
		);
	}

	const decipher = createDecipheriv(ALGORITHM, keys().cipher, nonce, {
		authTagLength: TAG_BYTES
	});
	decipher.setAuthTag(tag);

	try {
		return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
	} catch (cause) {
		throw new PiiCryptoError(
			'Шифртекст контакта не расшифровывается: он испорчен или зашифрован другим ключом',
			{ cause }
		);
	}
}

/**
 * Почта в сравнимом виде: без пробелов и в нижнем регистре. Пустая строка —
 * это `null`: сравнивать нечего, и ключа у такого значения нет.
 */
export function normalizeEmail(email: string): string | null {
	const normalized = email.replaceAll(/\s+/gu, '').toLocaleLowerCase('ru');

	return normalized === '' ? null : normalized;
}

/**
 * Телефон в сравнимом виде: одни цифры, российская восьмёрка — семёркой.
 * `8 (999) 123-45-67` и `+7 999 1234567` — один и тот же номер, и ключ сравнения
 * у них обязан быть один.
 *
 * Замена только у одиннадцатизначного номера: `8352…` из десяти цифр — это
 * городской номер без кода страны, и первая цифра в нём значащая.
 */
export function normalizePhone(phone: string): string | null {
	const digits = phone.replaceAll(/\D/gu, '');

	if (digits === '') {
		return null;
	}

	return digits.length === 11 && digits.startsWith('8') ? `7${digits.slice(1)}` : digits;
}

/** HMAC-SHA256 по нормализованному значению; вид значения входит в подпись. */
function mac(kind: string, normalized: string): string {
	return createHmac('sha256', keys().mac).update(`${kind}:${normalized}`, 'utf8').digest('hex');
}

/** Ключ сравнения адреса почты; `null` — сравнивать нечего. */
export function hashEmail(email: string): string | null {
	const normalized = normalizeEmail(email);

	return normalized === null ? null : mac('email', normalized);
}

/** Ключ сравнения телефона; `null` — сравнивать нечего. */
export function hashPhone(phone: string): string | null {
	const normalized = normalizePhone(phone);

	return normalized === null ? null : mac('phone', normalized);
}

/**
 * Контакты в колонки `people`. Единственный способ их туда положить: шифртекст
 * и ключ сравнения обязаны меняться вместе, а разойтись им достаточно одной
 * записи мимо этой функции — и дедупликация начнёт заводить второго того же
 * человека.
 */
export function contactColumns(contacts: Contacts): ContactColumns {
	return { ...emailColumns(contacts.email), ...phoneColumns(contacts.phone) };
}

/** Колонки одного адреса почты — когда меняется только он. */
export function emailColumns(email: string | null): Pick<ContactColumns, 'email' | 'emailHash'> {
	return {
		email: email === null ? null : encryptContact(email),
		emailHash: email === null ? null : hashEmail(email)
	};
}

/** Колонки одного телефона — когда меняется только он. */
export function phoneColumns(phone: string | null): Pick<ContactColumns, 'phone' | 'phoneHash'> {
	return {
		phone: phone === null ? null : encryptContact(phone),
		phoneHash: phone === null ? null : hashPhone(phone)
	};
}

/** Строка `people` с расшифрованными контактами; остальные поля как были. */
export function decryptContacts<TRow extends Contacts>(row: TRow): TRow {
	return {
		...row,
		email: row.email === null ? null : decryptContact(row.email),
		phone: row.phone === null ? null : decryptContact(row.phone)
	};
}
