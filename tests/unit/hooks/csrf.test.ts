import type { RequestEvent } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';

const { config } = vi.hoisted(() => ({ config: { ORIGIN: 'https://crm.example.org' } }));

vi.mock('$lib/server/config', () => ({ getConfig: () => config }));

const { csrf } = await import('$lib/server/hooks/csrf');

/** Запрос в том объёме, в каком его читает хук: метод, заголовки и ничего больше. */
function request(
	method: string,
	headers: Record<string, string> = {}
): Promise<Response> | Response {
	const event = {
		request: new Request('https://crm.example.org/interactions', {
			method,
			headers,
			body: method === 'GET' || method === 'HEAD' ? undefined : 'title=x'
		})
	} as RequestEvent;

	return csrf({ event, resolve: () => new Response('page') });
}

const FORM = { 'content-type': 'application/x-www-form-urlencoded' };

describe('csrf', () => {
	it('отвергает форму, отправленную с чужого адреса, и объясняет отказ по-русски', async () => {
		await expect(
			request('POST', { ...FORM, origin: 'https://attacker.example' })
		).rejects.toMatchObject({
			status: 403,
			body: { message: expect.stringContaining('с другого сайта') }
		});
	});

	it('пропускает форму со своего адреса', async () => {
		const response = await request('POST', { ...FORM, origin: 'https://crm.example.org' });

		expect(response.status).toBe(200);
	});

	it('отвергает форму вовсе без Origin: отличить её от подделанной нечем', async () => {
		await expect(request('POST', FORM)).rejects.toMatchObject({ status: 403 });
	});

	it('проверяет все методы, меняющие состояние', async () => {
		for (const method of ['PUT', 'PATCH', 'DELETE']) {
			await expect(
				request(method, { ...FORM, origin: 'https://attacker.example' })
			).rejects.toMatchObject({ status: 403 });
		}
	});

	it('проверяет и multipart: загрузка файла отправляется так же', async () => {
		await expect(
			request('POST', {
				'content-type': 'multipart/form-data; boundary=----x',
				origin: 'https://attacker.example'
			})
		).rejects.toMatchObject({ status: 403 });
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
