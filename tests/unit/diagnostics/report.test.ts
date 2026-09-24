/**
 * Два обещания экрана «Связи и зависимости»: итог «работает без интернета»
 * зависит только от обязательных связей, и адрес на экране не несёт секретов.
 */
import { describe, expect, it } from 'vitest';
import {
	displayAddress,
	hideCredentials,
	isOfflineReady,
	type DiagnosticLink,
	type LinkKind,
	type LinkStatus
} from '$lib/server/diagnostics/report';

function link(id: string, kind: LinkKind, status: LinkStatus): DiagnosticLink {
	return {
		id,
		name: id,
		purpose: id,
		kind,
		address: null,
		state: { status, detail: null, latencyMs: null }
	};
}

describe('итог «работает без интернета»', () => {
	const required = [link('postgres', 'required', 'ok'), link('redis', 'required', 'ok')];

	it('не зависит от разрешённых и внешних связей', () => {
		expect(
			isOfflineReady([
				...required,
				link('cms', 'allowed', 'failed'),
				link('smtp', 'allowed', 'not_configured'),
				link('dadata', 'external', 'disabled')
			])
		).toBe(true);
	});

	it('отрицателен, если не ответила хоть одна обязательная', () => {
		expect(isOfflineReady([...required, link('gotenberg', 'required', 'failed')])).toBe(false);
		// Без обязательных связей отчёт ничего не доказал.
		expect(isOfflineReady([link('cms', 'allowed', 'ok')])).toBe(false);
	});
});

describe('адрес на экране', () => {
	it('не несёт пароля, токена и параметров', () => {
		expect(displayAddress('postgres://lct:s3cret@postgres:5432/lct')).toBe(
			'postgres://postgres:5432/lct'
		);
		expect(displayAddress('redis://:s3cret@redis:6379')).toBe('redis://redis:6379');
		expect(displayAddress('smtps://user:p%40ss@relay.example.org:465')).toBe(
			'smtps://relay.example.org:465'
		);
		expect(displayAddress('https://lms.example.org/webservice/rest/server.php?wstoken=abc#x')).toBe(
			'https://lms.example.org/webservice/rest/server.php'
		);
		expect(displayAddress('http://mock-cms:8081/api/applications/{externalId}/status')).toBe(
			'http://mock-cms:8081/api/applications/{externalId}/status'
		);
	});

	it('вырезает учётные данные из текста отказа', () => {
		expect(hideCredentials('connect ECONNREFUSED postgres://lct:s3cret@postgres:5432/lct')).toBe(
			'connect ECONNREFUSED postgres://postgres:5432/lct'
		);
	});
});
