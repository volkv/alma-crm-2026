import type { RequestEvent } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';

const { session: sessionState } = vi.hoisted(() => ({
	session: { userId: null as string | null }
}));

vi.mock('$lib/server/auth/session', () => ({
	SESSION_COOKIE: 'lct_session',
	touchSession: () => Promise.resolve(sessionState.userId),
	loadSessionUser: (id: string) => Promise.resolve({ id, permissions: new Set() }),
	clearedSessionCookie: () => 'lct_session=; Path=/; Max-Age=0'
}));

const { session } = await import('$lib/server/hooks/session');
const { guard } = await import('$lib/server/hooks/guard');

/**
 * Cookie, которую браузер приносит, а сервер больше ни во что не разрешает,
 * обязана уехать вместе с ответом — в том числе с тем, который собрала гвардия.
 *
 * Это и есть цена за ответ, собранный в хуке: отложенные в `event.cookies`
 * SvelteKit подставляет только тому, что вышло из маршрута. Забыть про это —
 * значит оставить браузеру мёртвый идентификатор, с которым он будет ходить на
 * форму входа и обратно.
 */
function eventWithCookie(cookie: string | undefined): RequestEvent {
	const url = new URL('https://crm.example.org/audit');

	return {
		url,
		request: new Request(url),
		route: { id: '/(app)/audit' },
		cookies: { get: () => cookie },
		locals: { requestId: 'test', user: null, apiKey: null }
	} as unknown as RequestEvent;
}

/** Та же вложенность, что в `hooks.server.ts`: `session` снаружи, `guard` внутри. */
function chain(event: RequestEvent): Promise<Response> {
	return Promise.resolve(
		session({
			event,
			resolve: (inner) => guard({ event: inner, resolve: () => new Response('страница раздела') })
		})
	);
}

describe('хук сессии', () => {
	it('снимает мёртвую cookie с ответа, собранного гвардией', async () => {
		sessionState.userId = null;

		const response = await chain(eventWithCookie('протухший-идентификатор'));

		// Гвардия развернула анонима на вход — и сброс cookie уехал вместе с её
		// ответом, а не потерялся по дороге.
		expect(response.status).toBe(303);
		expect(response.headers.get('set-cookie')).toBe('lct_session=; Path=/; Max-Age=0');
	});

	it('живую сессию не трогает', async () => {
		sessionState.userId = 'b0b4b0de-0000-4000-8000-000000000001';

		const event = eventWithCookie('живой-идентификатор');
		const response = await chain(event);

		expect(response.status).toBe(200);
		expect(response.headers.get('set-cookie')).toBeNull();
		expect(event.locals.user).toMatchObject({ id: sessionState.userId });
	});

	it('запросу без cookie сбрасывать нечего', async () => {
		sessionState.userId = null;

		const response = await chain(eventWithCookie(undefined));

		expect(response.status).toBe(303);
		expect(response.headers.get('set-cookie')).toBeNull();
	});
});
