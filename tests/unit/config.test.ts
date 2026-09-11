import { describe, expect, it } from 'vitest';
import { parseConfig } from '$lib/server/config';

const completeEnv = {
	NODE_ENV: 'test',
	DATABASE_URL: 'postgres://lct:lct@localhost:55432/lct',
	REDIS_URL: 'redis://localhost:56379',
	GOTENBERG_URL: 'http://localhost:3001',
	SMTP_HOST: 'localhost',
	SMTP_PORT: '1025',
	ORIGIN: 'http://localhost:5173',
	SESSION_SECRET: 'a'.repeat(32)
} satisfies Record<string, string>;

describe('parseConfig', () => {
	it('accepts a complete environment and coerces the SMTP port to a number', () => {
		const config = parseConfig(completeEnv);

		expect(config.SMTP_PORT).toBe(1025);
		expect(config.DATABASE_URL).toBe(completeEnv.DATABASE_URL);
		expect(config.NODE_ENV).toBe('test');
	});

	it('rejects a missing DATABASE_URL and names it in the error', () => {
		const { DATABASE_URL: _omitted, ...withoutDatabaseUrl } = completeEnv;

		expect(() => parseConfig(withoutDatabaseUrl)).toThrowError(/DATABASE_URL/);
	});

	it('rejects a SESSION_SECRET shorter than 32 characters', () => {
		expect(() => parseConfig({ ...completeEnv, SESSION_SECRET: 'too-short' })).toThrowError(
			/SESSION_SECRET: must be at least 32 characters long/
		);
	});

	it('rejects a DATABASE_URL that is not a postgres connection string', () => {
		expect(() =>
			parseConfig({ ...completeEnv, DATABASE_URL: 'mysql://lct:lct@localhost:3306/lct' })
		).toThrowError(/DATABASE_URL/);
	});

	it('reports every broken variable at once, not just the first', () => {
		expect(() =>
			parseConfig({ ...completeEnv, SMTP_HOST: '', SESSION_SECRET: 'short' })
		).toThrowError(/SMTP_HOST[\s\S]*SESSION_SECRET/);
	});
});
