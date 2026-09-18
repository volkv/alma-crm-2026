/**
 * Шифрование контактов и ключ сравнения.
 *
 * Ключ берётся из подменённого окружения, а не из `.env`: в прогоне CI никакого
 * `.env` нет вовсе, а на машине разработчика он свой — и проверка, которая
 * зависит от чужого ключа, ничего не проверяет.
 */
import { describe, expect, it, vi } from 'vitest';

const KEY = 'KfAA/EWod3wd+ai6b1LHC62LWho5pPp1ajJnQNdbqUs=';

vi.mock('$env/dynamic/private', () => ({ env: { PII_ENCRYPTION_KEY: KEY } }));

const {
	contactColumns,
	decryptContact,
	decryptContacts,
	encryptContact,
	hashEmail,
	hashPhone,
	isEncryptedContact,
	normalizeEmail,
	normalizePhone,
	PiiCryptoError
} = await import('$lib/server/people/pii');
const { readPiiEncryptionKey } = await import('$lib/server/config');

const EMAIL = 'M.Ivanova@vuz.ru';
const PHONE = '+7 (999) 123-45-67';

describe('шифрование контакта', () => {
	it('возвращает то же значение и не оставляет его в шифртексте', () => {
		const stored = encryptContact(EMAIL);

		expect(stored.startsWith('enc:v1:')).toBe(true);
		expect(stored).not.toContain('Ivanova');
		expect(stored).not.toContain('vuz.ru');
		expect(decryptContact(stored)).toBe(EMAIL);
	});

	it('на каждое значение берёт свой вектор', () => {
		// Одинаковый шифртекст у одинаковых адресов выдавал бы, что два человека —
		// один и тот же, любому, кто смотрит в базу без ключа.
		const first = encryptContact(EMAIL);
		const second = encryptContact(EMAIL);

		expect(first).not.toBe(second);
		expect(decryptContact(first)).toBe(decryptContact(second));
	});

	it('переживает кириллицу и длинное значение', () => {
		const value = `Иванова Мария Петровна ${'долгий адрес '.repeat(40)}`;

		expect(decryptContact(encryptContact(value))).toBe(value);
	});
});

describe('отказ вместо догадки', () => {
	it('не читает открытую строку', () => {
		expect(() => decryptContact(EMAIL)).toThrowError(PiiCryptoError);
		expect(isEncryptedContact(EMAIL)).toBe(false);
	});

	it('не читает чужую версию формата', () => {
		const stored = encryptContact(EMAIL).replace('enc:v1:', 'enc:v2:');

		expect(() => decryptContact(stored)).toThrowError(/неизвестной версией/i);
	});

	it('не читает шифртекст с испорченным тегом', () => {
		const parts = encryptContact(EMAIL).split(':');
		const tag = Buffer.from(parts[4], 'base64');
		tag[0] ^= 0xff;

		const damaged = [...parts.slice(0, 4), tag.toString('base64')].join(':');

		expect(() => decryptContact(damaged)).toThrowError(PiiCryptoError);
	});

	it('не читает шифртекст с подменённым телом', () => {
		const parts = encryptContact(EMAIL).split(':');
		const body = Buffer.from(parts[3], 'base64');
		body[0] ^= 0xff;

		expect(() =>
			decryptContact([...parts.slice(0, 3), body.toString('base64'), parts[4]].join(':'))
		).toThrowError(PiiCryptoError);
	});

	it('не читает обрезанное значение', () => {
		expect(() => decryptContact('enc:v1:короткое')).toThrowError(PiiCryptoError);
		expect(() => decryptContact('enc:v1:AAAA:BBBB:CCCC')).toThrowError(/испорчен/i);
	});
});

describe('нормализация', () => {
	it('приводит почту к одному виду', () => {
		expect(normalizeEmail(' M.Ivanova@VUZ.ru ')).toBe('m.ivanova@vuz.ru');
		expect(normalizeEmail('   ')).toBeNull();
	});

	it('считает восьмёрку и семёрку одним номером', () => {
		expect(normalizePhone('+7 (999) 123-45-67')).toBe('79991234567');
		expect(normalizePhone('8 999 123 45 67')).toBe('79991234567');
		// Десять цифр — это городской номер без кода страны, и первая в нём
		// значащая: подменять её значило бы склеивать разные номера.
		expect(normalizePhone('8352123456')).toBe('8352123456');
		expect(normalizePhone('добавочный')).toBeNull();
	});
});

describe('ключ сравнения', () => {
	it('один у разных написаний одного контакта', () => {
		expect(hashEmail(EMAIL)).toBe(hashEmail(' m.ivanova@vuz.ru '));
		expect(hashPhone(PHONE)).toBe(hashPhone('8 999 123 45 67'));
	});

	it('разный у разных контактов и не содержит самого значения', () => {
		const hash = hashEmail(EMAIL);

		expect(hash).not.toBe(hashEmail('p.petrov@vuz.ru'));
		expect(hash).not.toContain('ivanova');
		expect(hash).toMatch(/^[0-9a-f]{64}$/);
	});

	it('различает почту и телефон с одинаковым текстом', () => {
		expect(hashEmail('79991234567')).not.toBe(hashPhone('79991234567'));
	});

	it('пуст там, где сравнивать нечего', () => {
		expect(hashEmail('  ')).toBeNull();
		expect(hashPhone('добавочный')).toBeNull();
	});
});

describe('колонки строки справочника', () => {
	it('кладут шифртекст и ключ сравнения вместе', () => {
		const columns = contactColumns({ email: EMAIL, phone: PHONE });

		expect(isEncryptedContact(columns.email ?? '')).toBe(true);
		expect(isEncryptedContact(columns.phone ?? '')).toBe(true);
		expect(columns.emailHash).toBe(hashEmail(EMAIL));
		expect(columns.phoneHash).toBe(hashPhone(PHONE));
	});

	it('пустой контакт оставляют пустым целиком', () => {
		expect(contactColumns({ email: null, phone: null })).toEqual({
			email: null,
			emailHash: null,
			phone: null,
			phoneHash: null
		});
	});

	it('читаются обратно вместе с остальными полями строки', () => {
		const row = {
			id: 'person',
			lastName: 'Иванова',
			...contactColumns({ email: EMAIL, phone: PHONE })
		};

		expect(decryptContacts(row)).toMatchObject({
			id: 'person',
			lastName: 'Иванова',
			email: EMAIL,
			phone: PHONE
		});
	});
});

describe('ключ из окружения', () => {
	it('принимается и в base64, и в hex', () => {
		const hex = '385af88c46e65436a2ac74b67ea414d7232dca4b137cb2a1a11ddff6a2c9355e';

		expect(readPiiEncryptionKey({ PII_ENCRYPTION_KEY: KEY })).toHaveLength(32);
		expect(readPiiEncryptionKey({ PII_ENCRYPTION_KEY: hex })).toHaveLength(32);
	});

	it('без ключа и с ключом не той длины — отказ с названием переменной', () => {
		expect(() => readPiiEncryptionKey({})).toThrowError(/PII_ENCRYPTION_KEY/);
		expect(() => readPiiEncryptionKey({ PII_ENCRYPTION_KEY: '' })).toThrowError(
			/PII_ENCRYPTION_KEY/
		);
		// Короткий ключ разобрался бы `Buffer.from` молча и доехал бы до записи.
		expect(() => readPiiEncryptionKey({ PII_ENCRYPTION_KEY: 'c2hvcnQta2V5' })).toThrowError(
			/32-byte/
		);
	});
});
