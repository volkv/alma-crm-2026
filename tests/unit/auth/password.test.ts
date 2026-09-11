import { parseOptions } from '@node-rs/argon2';
import { describe, expect, it } from 'vitest';
import { hashPassword, validatePassword, verifyPassword } from '$lib/server/auth/password';

const policy = { minLength: 12, minClasses: 3 };

describe('политика пароля', () => {
	it('считает длину по границе, а не около неё', () => {
		expect(validatePassword(policy, 'Abcdefghij1')).toEqual(['Пароль не короче 12 символов']);
		expect(validatePassword(policy, 'Abcdefghij12')).toEqual([]);
	});

	it('считает классы символов, включая кириллицу и знаки', () => {
		// Одни строчные — один класс из четырёх.
		expect(validatePassword(policy, 'abcdefghijkl')).toEqual([
			'Используйте символы хотя бы 3 видов из четырёх: строчные буквы, прописные буквы, цифры, знаки'
		]);
		expect(validatePassword(policy, 'абвгдеёжзийк')).toEqual([
			'Используйте символы хотя бы 3 видов из четырёх: строчные буквы, прописные буквы, цифры, знаки'
		]);

		// Строчные, прописные, цифры — ровно три.
		expect(validatePassword(policy, 'Abcdefghijk1')).toEqual([]);
		// Строчные, прописные, знак — тоже три, цифры не обязательны.
		expect(validatePassword(policy, 'Надёжный-Код')).toEqual([]);
	});

	it('требует ровно столько классов, сколько сказано в политике', () => {
		expect(validatePassword({ minLength: 8, minClasses: 1 }, 'abcdefgh')).toEqual([]);
		expect(validatePassword({ minLength: 8, minClasses: 4 }, 'Abcdefg1')).toEqual([
			'Используйте символы хотя бы 4 видов из четырёх: строчные буквы, прописные буквы, цифры, знаки'
		]);
		expect(validatePassword({ minLength: 8, minClasses: 4 }, 'Abcdefg1!')).toEqual([]);
	});

	it('перечисляет обе претензии сразу', () => {
		expect(validatePassword(policy, 'abc')).toHaveLength(2);
	});

	it('не пускает пароль длиннее предела', () => {
		expect(validatePassword(policy, 'Aa1'.repeat(67))).toEqual(['Пароль не длиннее 200 символов']);
	});
});

describe('хеширование пароля', () => {
	it('считает argon2id с памятью не меньше 19 МиБ', async () => {
		const hashed = await hashPassword('Проверочный-Пароль1');
		const options = parseOptions(hashed);

		// 2 — Argon2id в перечислении @node-rs/argon2.
		expect(options.algorithm).toBe(2);
		expect(options.memoryCost).toBeGreaterThanOrEqual(19 * 1024);
	});

	it('даёт разные хеши одному паролю и узнаёт его обратно', async () => {
		const first = await hashPassword('Проверочный-Пароль1');
		const second = await hashPassword('Проверочный-Пароль1');

		expect(first).not.toBe(second);
		expect(await verifyPassword(first, 'Проверочный-Пароль1')).toBe(true);
		expect(await verifyPassword(first, 'проверочный-пароль1')).toBe(false);
	});

	it('тратит время и на несуществующего пользователя', async () => {
		// Хеша нет, но проверка всё равно происходит: иначе по времени ответа
		// отличают заведённый адрес от незаведённого.
		expect(await verifyPassword(null, 'что угодно')).toBe(false);
	});
});
