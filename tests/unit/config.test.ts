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
	S3_ENDPOINT: 'http://localhost:59000',
	S3_REGION: 'us-east-1',
	S3_BUCKET: 'lct-documents',
	S3_ACCESS_KEY: 'lct',
	S3_SECRET_KEY: 'lct-secret-key',
	S3_FORCE_PATH_STYLE: 'true'
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

	it('rejects storage keys that are there but empty', () => {
		// An empty key is not «no storage configured»: it signs every request with
		// nothing and the storage answers 403 on the first upload.
		expect(() => parseConfig({ ...completeEnv, S3_ACCESS_KEY: '' })).toThrowError(/S3_ACCESS_KEY/);
		expect(() => parseConfig({ ...completeEnv, S3_SECRET_KEY: '' })).toThrowError(/S3_SECRET_KEY/);
	});

	it('rejects a bucket name S3 itself would refuse', () => {
		expect(() => parseConfig({ ...completeEnv, S3_BUCKET: 'Lct_Documents' })).toThrowError(
			/S3_BUCKET/
		);
		expect(() => parseConfig({ ...completeEnv, S3_BUCKET: 'ab' })).toThrowError(/S3_BUCKET/);
	});

	it('rejects an S3 endpoint without a scheme', () => {
		expect(() => parseConfig({ ...completeEnv, S3_ENDPOINT: 'minio:9000' })).toThrowError(
			/S3_ENDPOINT/
		);
	});

	it('reports every broken variable at once, not just the first', () => {
		expect(() => parseConfig({ ...completeEnv, SMTP_HOST: '', S3_BUCKET: '' })).toThrowError(
			/SMTP_HOST[\s\S]*S3_BUCKET/
		);
	});
});
