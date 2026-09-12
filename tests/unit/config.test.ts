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
	DEMO_MODE: 'false',
	TRUST_PROXY: 'false',
	DATA_DIR: './data'
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

	it('rejects a DATABASE_URL that is not a postgres connection string', () => {
		expect(() =>
			parseConfig({ ...completeEnv, DATABASE_URL: 'mysql://lct:lct@localhost:3306/lct' })
		).toThrowError(/DATABASE_URL/);
	});

	it('turns the boolean flags into real booleans', () => {
		const config = parseConfig({ ...completeEnv, DEMO_MODE: 'true', TRUST_PROXY: 'true' });

		expect(config.DEMO_MODE).toBe(true);
		expect(config.TRUST_PROXY).toBe(true);
		expect(parseConfig(completeEnv).DEMO_MODE).toBe(false);
	});

	it('rejects anything but "true" or "false" in a boolean flag', () => {
		// `Boolean('0')` is `true`, so a permissive cast would silently turn the
		// demo stand into a production one.
		expect(() => parseConfig({ ...completeEnv, DEMO_MODE: '1' })).toThrowError(/DEMO_MODE/);
		expect(() => parseConfig({ ...completeEnv, TRUST_PROXY: 'True' })).toThrowError(/TRUST_PROXY/);
	});

	it('leaves the LMS stand-in off when nothing says otherwise', () => {
		// The flag is absent from `completeEnv` on purpose: a deployment that never
		// heard of the stand-in must not get a second source of learning data.
		expect(parseConfig(completeEnv).MOCK_LMS).toBe(false);
		expect(parseConfig({ ...completeEnv, MOCK_LMS: 'true' }).MOCK_LMS).toBe(true);
	});

	it('rejects anything but "true" or "false" in MOCK_LMS', () => {
		expect(() => parseConfig({ ...completeEnv, MOCK_LMS: 'yes' })).toThrowError(/MOCK_LMS/);
		expect(() => parseConfig({ ...completeEnv, MOCK_LMS: '' })).toThrowError(/MOCK_LMS/);
	});

	it('rejects an empty DATA_DIR', () => {
		expect(() => parseConfig({ ...completeEnv, DATA_DIR: '' })).toThrowError(/DATA_DIR/);
	});

	it('reports every broken variable at once, not just the first', () => {
		expect(() => parseConfig({ ...completeEnv, SMTP_HOST: '', DATA_DIR: '' })).toThrowError(
			/SMTP_HOST[\s\S]*DATA_DIR/
		);
	});
});
