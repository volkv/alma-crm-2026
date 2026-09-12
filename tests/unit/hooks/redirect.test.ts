import type { RequestEvent } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';

const { config } = vi.hoisted(() => ({ config: { ORIGIN: 'https://crm.example.org' } }));

vi.mock('$lib/server/config', () => ({ getConfig: () => config }));

const { guard } = await import('$lib/server/hooks/guard');
const { requestId } = await import('$lib/server/hooks/request-id');
const { securityHeaders } = await import('$lib/server/hooks/security-headers');

/**
 * Ответ, который собрала сама гвардия, обязан выйти наружу через ту же цепочку,
 * что и любой другой.
 *
 * Брошенное `redirect()` из хука не проходит через внешние хуки вовсе: ответ на
 * него собирает SvelteKit за пределами цепочки, и на нём не оказывается ни
 * `x-request-id`, ни заголовков безопасности. Человек, которого выкинуло на
 * форму входа, — как раз тот, чьё обращение чаще всего надо потом найти в логе,
 * поэтому проверяется именно этот ответ, а не только успешный.
 */
function appEvent(path: string, user: RequestEvent['locals']['user']): RequestEvent {
	const url = new URL(`https://crm.example.org${path}`);

	return {
		url,
		request: new Request(url),
		route: { id: '/(app)/audit' },
		locals: { requestId: '', user, apiKey: null }
	} as unknown as RequestEvent;
}

/**
 * Та же вложенность, что даёт `sequence` в `hooks.server.ts`. Собирается руками:
 * `sequence` ходит во внутреннее хранилище запроса SvelteKit, которого вне
 * настоящего сервера нет, а проверяется здесь порядок хуков, а не оно.
 */
function chain(event: RequestEvent, route: () => Response): Promise<Response> {
	return Promise.resolve(
		requestId({
			event,
			resolve: (withId) =>
				securityHeaders({
					event: withId,
					resolve: (withHeaders) => guard({ event: withHeaders, resolve: route })
				})
		})
	);
}

/** Маршрут, до которого анонима не пускают: сюда доходить не должно. */
const unreachable = (): Response => {
	throw new Error('гвардия обязана остановить запрос до маршрута');
};

describe('перенаправление гвардии', () => {
	it('несёт заголовки и код обращения, как любой другой ответ', async () => {
		const event = appEvent('/audit?from=2026-09-01', null);

		const response = await chain(event, unreachable);

		expect(response.status).toBe(303);
		expect(response.headers.get('location')).toBe('/login?next=%2Faudit%3Ffrom%3D2026-09-01');
		expect(response.headers.get('x-request-id')).toBe(event.locals.requestId);
		expect(event.locals.requestId).not.toBe('');
		expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
		expect(response.headers.get('Strict-Transport-Security')).toContain('max-age=');
	});

	it('вошедшего пропускает дальше', async () => {
		const event = appEvent('/audit', { id: 'u1' } as RequestEvent['locals']['user']);

		const response = await chain(event, () => new Response('страница'));

		expect(response.status).toBe(200);
		expect(response.headers.get('x-request-id')).toBe(event.locals.requestId);
	});
});
