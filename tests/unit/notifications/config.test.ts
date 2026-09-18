/**
 * Переменные почты в конфигурации.
 *
 * У них нет умолчаний, и это осознанно: подставленный `localhost:25` означал бы
 * письма, которые никуда не уходят и об этом молчат. Пустая строка при этом
 * равна «не задано» — Compose подставляет пустое значение там, где переменной
 * нет в `.env`, и различать эти два случая было бы различением без разницы.
 */
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

describe('почта в конфигурации', () => {
	it('не подставляет своего адреса: без переменных почта просто не настроена', () => {
		const config = parseConfig(completeEnv);

		expect(config.SMTP_URL).toBeNull();
		expect(config.SMTP_FROM).toBeNull();
	});

	it('пустую строку читает как «не задано»', () => {
		const config = parseConfig({ ...completeEnv, SMTP_URL: '', SMTP_FROM: '' });

		expect(config.SMTP_URL).toBeNull();
		expect(config.SMTP_FROM).toBeNull();
	});

	it('принимает smtp и smtps', () => {
		expect(parseConfig({ ...completeEnv, SMTP_URL: 'smtp://mailpit:1025' }).SMTP_URL).toBe(
			'smtp://mailpit:1025'
		);
		expect(parseConfig({ ...completeEnv, SMTP_URL: 'smtps://relay.example.org' }).SMTP_URL).toBe(
			'smtps://relay.example.org'
		);
	});

	it('роняет старт на адресе, по которому письмо не отправить', () => {
		// Опечатка в схеме — это почта, которая не работает, и узнать об этом
		// надо при старте, а не из первой строки «не отправлено» через неделю.
		expect(() => parseConfig({ ...completeEnv, SMTP_URL: 'http://mailpit:1025' })).toThrowError(
			/SMTP_URL/
		);
		expect(() => parseConfig({ ...completeEnv, SMTP_URL: 'mailpit:1025' })).toThrowError(
			/SMTP_URL/
		);
	});

	it('роняет старт на обратном адресе, который не адрес', () => {
		expect(() => parseConfig({ ...completeEnv, SMTP_FROM: 'lct-crm' })).toThrowError(/SMTP_FROM/);
	});
});
