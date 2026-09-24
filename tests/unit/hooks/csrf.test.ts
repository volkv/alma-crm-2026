import type { RequestEvent } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';

const { config } = vi.hoisted(() => ({ config: { ORIGIN: 'https://crm.example.org' } }));

vi.mock('$lib/server/config', () => ({ getConfig: () => config }));

const { csrf } = await import('$lib/server/hooks/csrf');
const { securityHeaders } = await import('$lib/server/hooks/security-headers');

/** Запрос в том объёме, в каком его читают хуки: метод, заголовки, `locals`. */
function event(method: string, headers: Record<string, string>): RequestEvent {
	return {
		request: new Request('https://crm.example.org/interactions', {
			method,
			headers,
			body: method === 'GET' || method === 'HEAD' ? undefined : 'title=x'
		}),
		isDataRequest: false,
		locals: { requestId: 'test', user: null, apiKey: null }
	} as RequestEvent;
}

function request(method: string, headers: Record<string, string> = {}): Promise<Response> {
	return Promise.resolve(
		csrf({ event: event(method, headers), resolve: () => new Response('page') })
	);
}

const FORM = { 'content-type': 'application/x-www-form-urlencoded' };

describe('csrf', () => {
	it('отвергает форму, отправленную с чужого адреса, и объясняет отказ по-русски', async () => {
		const page = await request('POST', {
			...FORM,
			origin: 'https://attacker.example',
			accept: 'text/html,application/xhtml+xml'
		});

		expect(page.status).toBe(403);
		expect(page.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
		expect(await page.text()).toContain('с другого сайта');

		const data = await request('POST', {
			...FORM,
			origin: 'https://attacker.example',
			accept: 'application/json'
		});

		expect(data.status).toBe(403);
		expect(await data.json()).toEqual({ message: expect.stringContaining('с другого сайта') });
	});

	it('пропускает форму со своего адреса', async () => {
		const response = await request('POST', { ...FORM, origin: 'https://crm.example.org' });

		expect(response.status).toBe(200);
	});

	it('отвергает форму вовсе без Origin: отличить её от подделанной нечем', async () => {
		expect((await request('POST', FORM)).status).toBe(403);
	});

	it('проверяет все методы, меняющие состояние', async () => {
		for (const method of ['PUT', 'PATCH', 'DELETE']) {
			const response = await request(method, { ...FORM, origin: 'https://attacker.example' });

			expect(response.status).toBe(403);
		}
	});

	it('проверяет и multipart: загрузка файла отправляется так же', async () => {
		const response = await request('POST', {
			'content-type': 'multipart/form-data; boundary=----x',
			origin: 'https://attacker.example'
		});

		expect(response.status).toBe(403);
	});

	it('не трогает чтение: GET с любого адреса — не изменение состояния', async () => {
		const response = await request('GET', { origin: 'https://attacker.example' });

		expect(response.status).toBe(200);
	});

	it('не трогает запрос с телом JSON: такой браузер сперва согласует с сервером', async () => {
		const response = await request('POST', {
			'content-type': 'application/json',
			origin: 'https://attacker.example'
		});

		expect(response.status).toBe(200);
	});
});

/**
 * Тот же порядок, что в `hooks.server.ts`: `securityHeaders` снаружи, `csrf`
 * внутри. `sequence` из фреймворка вне сервера не работает — ему нужно
 * хранилище запроса, — поэтому цепочка собрана руками.
 */
describe('csrf внутри цепочки заголовков безопасности', () => {
	function through(headers: Record<string, string>): Promise<Response> {
		return Promise.resolve(
			securityHeaders({
				event: event('POST', headers),
				resolve: (inner) => csrf({ event: inner, resolve: () => new Response('page') })
			})
		);
	}

	it('отказ несёт CSP и те же заголовки, что любой ответ приложения', async () => {
		const response = await through({ ...FORM, origin: 'https://attacker.example' });

		expect(response.status).toBe(403);
		expect(response.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
		expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
		expect(response.headers.get('Cross-Origin-Opener-Policy')).toBe('same-origin');
	});

	it('обычная страница изолирована от чужих источников', async () => {
		const response = await through({ ...FORM, origin: 'https://crm.example.org' });

		expect(response.status).toBe(200);
		expect(response.headers.get('Cross-Origin-Opener-Policy')).toBe('same-origin');
		expect(response.headers.get('Cross-Origin-Resource-Policy')).toBe('same-origin');
	});
});
