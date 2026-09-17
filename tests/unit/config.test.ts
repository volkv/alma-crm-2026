import { describe, expect, it } from 'vitest';
import { parseConfig } from '$lib/server/config';

const completeEnv = {
	NODE_ENV: 'test',
	DATABASE_URL: 'postgres://lct:lct@localhost:55432/lct',
	REDIS_URL: 'redis://localhost:56379',
	GOTENBERG_URL: 'http://localhost:3001',
	ORIGIN: 'http://localhost:5173',
	DEMO_MODE: 'false',
	TRUST_PROXY: 'false',
	S3_ENDPOINT: 'http://localhost:59000',
	S3_REGION: 'us-east-1',
	S3_BUCKET: 'lct-documents',
	S3_ACCESS_KEY: 'lct',
	S3_SECRET_KEY: 'lct-secret-key',
	S3_FORCE_PATH_STYLE: 'true',
	OIDC_ISSUER_URL: 'http://localhost:58080/realms/lct',
	OIDC_PUBLIC_URL: 'http://localhost:58080',
	OIDC_CLIENT_ID: 'lct-crm',
	OIDC_CLIENT_SECRET: 'lct-crm-dev-secret'
} satisfies Record<string, string>;

describe('parseConfig', () => {
	it('accepts a complete environment', () => {
		const config = parseConfig(completeEnv);

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

	it('treats an empty exchange address as «direction not configured»', () => {
		// Compose substitutes an empty value where the variable is missing from
		// `.env`, and telling those two cases apart would be a distinction without
		// a difference: both mean the direction is off.
		const config = parseConfig({ ...completeEnv, EXCHANGE_CMS_STATUS_URL: '' });

		expect(config.EXCHANGE_CMS_STATUS_URL).toBeNull();
		expect(config.EXCHANGE_SECRET).toBeNull();
		expect(config.EXCHANGE_CMS_INSTANCE).toBe('itschool-site');
	});

	it('demands {externalId} in the address of an application card', () => {
		// Without the placeholder every status would go to the same address, and
		// the site would have no way of telling which application it is about.
		expect(() =>
			parseConfig({ ...completeEnv, EXCHANGE_CMS_STATUS_URL: 'http://mock-cms:8081/api/status' })
		).toThrowError(/EXCHANGE_CMS_STATUS_URL/);

		expect(
			parseConfig({
				...completeEnv,
				EXCHANGE_CMS_STATUS_URL: 'http://mock-cms:8081/api/applications/{externalId}/status'
			}).EXCHANGE_CMS_STATUS_URL
		).toBe('http://mock-cms:8081/api/applications/{externalId}/status');
	});

	it('holds the exchange address to the same rule as every outgoing address', () => {
		// The server walks this address itself, carrying the body and the
		// signature: plain http is allowed only on this machine and for the two
		// imitators of the stand.
		expect(() =>
			parseConfig({ ...completeEnv, EXCHANGE_LMS_GROUPS_URL: 'http://lms.example.org/api/groups' })
		).toThrowError(/EXCHANGE_LMS_GROUPS_URL/);

		expect(
			parseConfig({ ...completeEnv, EXCHANGE_LMS_GROUPS_URL: 'http://mock-lms:8082/api/groups' })
				.EXCHANGE_LMS_GROUPS_URL
		).toBe('http://mock-lms:8082/api/groups');
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
		expect(() => parseConfig({ ...completeEnv, S3_ACCESS_KEY: '', S3_BUCKET: '' })).toThrowError(
			/S3_BUCKET[\s\S]*S3_ACCESS_KEY/
		);
	});

	it('rejects an exchange secret too short to be one', () => {
		// Подпись стоит ровно столько, сколько стоит подбор ключа: «exchange» из
		// восьми букв подбирается словарём, и подписанное им сообщение ничем не
		// отличается от чужого.
		expect(() => parseConfig({ ...completeEnv, EXCHANGE_SECRET: 'exchange' })).toThrowError(
			/EXCHANGE_SECRET/
		);

		expect(parseConfig({ ...completeEnv, EXCHANGE_SECRET: 'x'.repeat(32) }).EXCHANGE_SECRET).toBe(
			'x'.repeat(32)
		);
	});

	it('leaves local outgoing targets to the deployment and defaults by mode', () => {
		// Умолчания нет: значение читают через `allowsLocalTargets()`, где режим и
		// решает. Здесь проверяется, что переменная разбирается и не выдумывает
		// себе значения.
		expect(parseConfig(completeEnv).ALLOW_LOCAL_TARGETS).toBeUndefined();
		expect(parseConfig({ ...completeEnv, ALLOW_LOCAL_TARGETS: 'true' }).ALLOW_LOCAL_TARGETS).toBe(
			true
		);
		expect(() => parseConfig({ ...completeEnv, ALLOW_LOCAL_TARGETS: 'yes' })).toThrowError(
			/ALLOW_LOCAL_TARGETS/
		);
	});

	it('rejects an issuer URL with a trailing slash', () => {
		// `iss` токена realm пишет без слэша, и сверка идёт строка в строку:
		// лишний символ отвергал бы каждый вход уже после обмена кода.
		expect(() =>
			parseConfig({ ...completeEnv, OIDC_ISSUER_URL: 'http://localhost:58080/realms/lct/' })
		).toThrowError(/OIDC_ISSUER_URL/);
	});

	it('accepts an optional internal address of the directory', () => {
		const config = parseConfig({ ...completeEnv, OIDC_INTERNAL_URL: 'http://keycloak:8080' });

		expect(config.OIDC_INTERNAL_URL).toBe('http://keycloak:8080');
		expect(parseConfig(completeEnv).OIDC_INTERNAL_URL).toBeUndefined();
	});

	it('rejects an internal address with a trailing slash', () => {
		// Перенос идёт склейкой оснований, и лишний слэш даёт двойной в пути.
		expect(() =>
			parseConfig({ ...completeEnv, OIDC_INTERNAL_URL: 'http://keycloak:8080/' })
		).toThrowError(/OIDC_INTERNAL_URL/);
	});

	it('rejects an issuer that does not start with the public base', () => {
		// Метаданные каталога переносятся на внутренний адрес заменой публичного
		// основания: расхождение обязано остановить сервер при старте, а не
		// всплыть отказом в ответ на нажатие «Войти».
		expect(() =>
			parseConfig({ ...completeEnv, OIDC_PUBLIC_URL: 'http://localhost:59999' })
		).toThrowError(/OIDC_ISSUER_URL/);
	});
});
