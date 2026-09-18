import { describe, expect, it } from 'vitest';
import { demoPasswordHint } from '$lib/server/auth/demo-password';
import { parseConfig } from '$lib/server/config';

/**
 * Пароль демонстрационных записей на странице входа. Показывать его разрешено
 * ровно на публичном стенде и ровно тогда, когда развёртывание назвало его
 * переменной окружения: приложение своих паролей не знает и выдумать эту строку
 * не может.
 */
describe('подсказка пароля демонстрационного стенда', () => {
	it('показывается на стенде, когда пароль задан', () => {
		expect(demoPasswordHint('lct-demo-2026', true)).toBe('lct-demo-2026');
	});

	it('вне демонстрационного режима не показывается, чем бы ни была задана', () => {
		expect(demoPasswordHint('lct-demo-2026', false)).toBeNull();
	});

	it('без пароля подсказки нет', () => {
		expect(demoPasswordHint(null, true)).toBeNull();
	});
});

/**
 * Разбор значения — забота конфигурации: испорченная переменная обязана ронять
 * старт, а не всплывать пустой карточкой на первом заходе.
 */
describe('DEMO_PASSWORD_HINT в конфигурации', () => {
	const completeEnv = {
		NODE_ENV: 'test',
		DATABASE_URL: 'postgres://lct:lct@localhost:55432/lct',
		REDIS_URL: 'redis://localhost:56379',
		GOTENBERG_URL: 'http://localhost:3001',
		ORIGIN: 'http://localhost:5173',
		DEMO_MODE: 'true',
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

	it('пустая строка и пробелы равны «не задано»', () => {
		// Compose подставляет пустое значение там, где переменной нет в `.env`.
		expect(parseConfig(completeEnv).DEMO_PASSWORD_HINT).toBeNull();
		expect(
			parseConfig({ ...completeEnv, DEMO_PASSWORD_HINT: '   ' }).DEMO_PASSWORD_HINT
		).toBeNull();
	});

	it('значение приходит без краевых пробелов', () => {
		expect(
			parseConfig({ ...completeEnv, DEMO_PASSWORD_HINT: ' lct-demo-2026 ' }).DEMO_PASSWORD_HINT
		).toBe('lct-demo-2026');
	});

	it('строка длиннее потолка роняет старт, а не уезжает на экран', () => {
		// Потолок — от опечатки вида `DEMO_PASSWORD_HINT=$(cat .env)`.
		expect(() => parseConfig({ ...completeEnv, DEMO_PASSWORD_HINT: 'x'.repeat(129) })).toThrowError(
			/DEMO_PASSWORD_HINT/
		);
	});
});
