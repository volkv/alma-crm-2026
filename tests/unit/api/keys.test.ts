import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
	API_KEY_PATTERN,
	API_KEY_PREFIX,
	generateApiKey,
	hashApiKey,
	parseBearerToken
} from '$lib/server/api/keys';

describe('формат ключа доступа', () => {
	it('выдаёт ключ с префиксом и 32 символами base64url', () => {
		const key = generateApiKey();

		expect(key).toMatch(API_KEY_PATTERN);
		expect(key.startsWith(API_KEY_PREFIX)).toBe(true);
		expect(key).toHaveLength(API_KEY_PREFIX.length + 32);
	});

	it('не повторяется', () => {
		const keys = new Set(Array.from({ length: 64 }, () => generateApiKey()));

		expect(keys.size).toBe(64);
	});

	it('отвергает всё, что ключом не является', () => {
		const key = generateApiKey();

		expect(API_KEY_PATTERN.test(key.slice(4))).toBe(false);
		expect(API_KEY_PATTERN.test(`${key}x`)).toBe(false);
		expect(API_KEY_PATTERN.test(key.slice(0, -1))).toBe(false);
		expect(API_KEY_PATTERN.test(`lct_${'+'.repeat(32)}`)).toBe(false);
		expect(API_KEY_PATTERN.test(`api_${key.slice(4)}`)).toBe(false);
		expect(API_KEY_PATTERN.test(`${key}\nlct_${key.slice(4)}`)).toBe(false);
	});
});

describe('хеш ключа', () => {
	it('совпадает с sha256 и не зависит от вызова к вызову', () => {
		const key = 'lct_0123456789abcdefghijklmnopqrstuv';
		const expected = createHash('sha256').update(key, 'utf8').digest('hex');

		expect(hashApiKey(key)).toBe(expected);
		expect(hashApiKey(key)).toHaveLength(64);
		expect(hashApiKey(key)).toBe(hashApiKey(key));
	});

	it('разводит даже соседние ключи', () => {
		expect(hashApiKey('lct_aaaa')).not.toBe(hashApiKey('lct_aaab'));
	});

	it('не позволяет восстановить ключ', () => {
		const key = generateApiKey();

		expect(hashApiKey(key)).not.toContain(key.slice(4));
	});
});

describe('разбор заголовка Authorization', () => {
	const key = generateApiKey();

	it('берёт ключ из схемы Bearer в любом регистре', () => {
		expect(parseBearerToken(`Bearer ${key}`)).toBe(key);
		expect(parseBearerToken(`bearer ${key}`)).toBe(key);
		expect(parseBearerToken(`BEARER   ${key}`)).toBe(key);
		expect(parseBearerToken(`  Bearer ${key}  `)).toBe(key);
	});

	it('не берёт ничего из чужой схемы и из мусора', () => {
		expect(parseBearerToken(null)).toBeNull();
		expect(parseBearerToken('')).toBeNull();
		expect(parseBearerToken(key)).toBeNull();
		expect(parseBearerToken(`Basic ${key}`)).toBeNull();
		expect(parseBearerToken('Bearer')).toBeNull();
		expect(parseBearerToken('Bearer ')).toBeNull();
		expect(parseBearerToken(`Bearer ${key} ${key}`)).toBeNull();
	});
});
