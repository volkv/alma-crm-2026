import { describe, expect, it } from 'vitest';
import { newSessionId } from '$lib/server/auth/session';

describe('идентификатор сессии', () => {
	it('несёт 256 бит случайности в безопасной для cookie записи', () => {
		const id = newSessionId();

		// 32 байта в base64url — 43 символа без выравнивающих «=».
		expect(id).toHaveLength(43);
		expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
	});

	it('не повторяется', () => {
		const ids = new Set(Array.from({ length: 1000 }, () => newSessionId()));

		expect(ids.size).toBe(1000);
	});
});
