import { isRedirect, type Cookies, type RequestEvent } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';

const { session: sessionState } = vi.hoisted(() => ({
	session: { userId: null as string | null, mfaPending: false }
}));

vi.mock('$lib/server/auth/session', () => ({
	SESSION_COOKIE: 'lct_session',
	touchSession: () =>
		Promise.resolve(
			sessionState.userId === null
				? null
				: { userId: sessionState.userId, mfaPending: sessionState.mfaPending }
		),
	loadSessionUser: (id: string) =>
		Promise.resolve({ id, permissions: new Set(), mfaPending: false }),
	clearSessionCookie: (cookies: Cookies) => cookies.delete('lct_session', { path: '/' })
}));

const { session } = await import('$lib/server/hooks/session');
const { guard } = await import('$lib/server/hooks/guard');

/**
 * Cookie, которую браузер приносит, а сервер больше ни во что не разрешает,
 * обязана уехать вместе с ответом — в том числе с перенаправлением гвардии.
 *
 * Сброс для этого кладётся в `event.cookies` до того, как запрос пойдёт дальше:
 * отложенные cookie SvelteKit дописывает и к ответу маршрута, и к брошенному
 * перенаправлению, а вот ответу, который хук собрал бы сам, — нет. Забыть про
 * сброс значит оставить браузеру мёртвый идентификатор, с которым он будет
 * ходить на форму входа и обратно.
 */
function eventWithCookie(
	cookie: string | undefined,
	path = '/audit'
): { event: RequestEvent; deleted: string[] } {
	const url = new URL(`https://crm.example.org${path}`);
	const deleted: string[] = [];

	const event = {
		url,
		request: new Request(url),
		route: { id: '/(app)/audit' },
		cookies: { get: () => cookie, delete: (name: string) => deleted.push(name) },
		locals: { requestId: 'test', user: null, apiKey: null }
	} as unknown as RequestEvent;

	return { event, deleted };
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
	it('снимает мёртвую cookie до того, как гвардия развернёт запрос', async () => {
		sessionState.userId = null;
		sessionState.mfaPending = false;

		const { event, deleted } = eventWithCookie('протухший-идентификатор');

		const thrown = await chain(event).then(
			(response) => response,
			(failure: unknown) => failure
		);

		// Гвардия развернула анонима на вход, а сброс cookie уже отложен — и
		// поедет вместе с её перенаправлением.
		expect(isRedirect(thrown)).toBe(true);
		expect(deleted).toEqual(['lct_session']);
	});

	it('живую сессию не трогает', async () => {
		sessionState.userId = 'b0b4b0de-0000-4000-8000-000000000001';
		sessionState.mfaPending = false;

		const { event, deleted } = eventWithCookie('живой-идентификатор');
		const response = await chain(event);

		expect(response.status).toBe(200);
		expect(deleted).toEqual([]);
		expect(event.locals.user).toMatchObject({ id: sessionState.userId });
	});

	it('запросу без cookie сбрасывать нечего', async () => {
		sessionState.userId = null;
		sessionState.mfaPending = false;

		const { event, deleted } = eventWithCookie(undefined);

		const thrown = await chain(event).then(
			(response) => response,
			(failure: unknown) => failure
		);

		expect(isRedirect(thrown)).toBe(true);
		expect(deleted).toEqual([]);
	});

	/**
	 * Сессия, которой не хватает второго фактора, — это ещё не вход. Гвардия
	 * обязана увести её на второй шаг и никуда больше: пустить такую сессию в
	 * приложение значит принимать один пароль там, где политика требует два
	 * доказательства.
	 */
	it('неполную сессию разворачивает на второй шаг, а не в приложение', async () => {
		sessionState.userId = 'b0b4b0de-0000-4000-8000-000000000001';
		sessionState.mfaPending = true;

		const { event, deleted } = eventWithCookie('живой-идентификатор');

		const thrown = await chain(event).then(
			(response) => response,
			(failure: unknown) => failure
		);

		expect(isRedirect(thrown)).toBe(true);
		expect((thrown as { location: string }).location).toBe('/login/mfa?next=%2Faudit');
		// Cookie при этом живая: по ней и продолжится второй шаг.
		expect(deleted).toEqual([]);
		expect(event.locals.user).toMatchObject({ mfaPending: true });
	});

	it('второй шаг входа неполной сессии открыт: он лежит вне (app)', async () => {
		sessionState.userId = 'b0b4b0de-0000-4000-8000-000000000001';
		sessionState.mfaPending = true;

		const { event } = eventWithCookie('живой-идентификатор', '/login/mfa');
		(event as unknown as { route: { id: string } }).route.id = '/(auth)/login/mfa';

		const response = await chain(event);

		expect(response.status).toBe(200);
	});
});
