import { isRedirect, type Cookies, type RequestEvent } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';

const { session: sessionState } = vi.hoisted(() => ({
	session: { userId: null as string | null, renewFor: null as number | null }
}));

vi.mock('$lib/server/auth/session', () => ({
	SESSION_COOKIE: 'lct_session',
	touchSession: () =>
		Promise.resolve(
			sessionState.userId === null
				? null
				: { userId: sessionState.userId, renewFor: sessionState.renewFor }
		),
	loadSessionUser: (id: string) => Promise.resolve({ id, permissions: new Set() }),
	clearSessionCookie: (cookies: Cookies) => cookies.delete('lct_session', { path: '/' }),
	renewSessionCookie: (cookies: Cookies, sessionId: string, maxAge: number) =>
		cookies.set('lct_session', sessionId, { path: '/', maxAge })
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
type Written = { value: string; maxAge: number | undefined };

function eventWithCookie(
	cookie: string | undefined,
	path = '/audit'
): { event: RequestEvent; deleted: string[]; written: Written[] } {
	const url = new URL(`https://crm.example.org${path}`);
	const deleted: string[] = [];
	const written: Written[] = [];

	const event = {
		url,
		request: new Request(url),
		route: { id: '/(app)/audit' },
		cookies: {
			get: () => cookie,
			delete: (name: string) => deleted.push(name),
			set: (_name: string, value: string, options: { maxAge?: number }) =>
				written.push({ value, maxAge: options.maxAge })
		},
		locals: { requestId: 'test', user: null, apiKey: null }
	} as unknown as RequestEvent;

	return { event, deleted, written };
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
		sessionState.renewFor = null;

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
		sessionState.renewFor = null;

		const { event, deleted, written } = eventWithCookie('живой-идентификатор');
		const response = await chain(event);

		expect(response.status).toBe(200);
		expect(deleted).toEqual([]);
		// Продления не было — значит, и переставлять cookie незачем: `Set-Cookie`
		// на каждый запрос это заголовок на каждом `__data.json`.
		expect(written).toEqual([]);
		expect(event.locals.user).toMatchObject({ id: sessionState.userId });
	});

	/**
	 * Вторая половина скользящего окна. Пока срок cookie ставился один раз при
	 * входе, он не двигался вовсе: браузер выбрасывал её через
	 * `session_idle_minutes` после входа, сколько бы человек ни работал, — и
	 * продлённая сессия оставалась в Redis без того, чем её предъявить.
	 */
	it('продлённой сессии переставляет срок cookie', async () => {
		sessionState.userId = 'b0b4b0de-0000-4000-8000-000000000001';
		sessionState.renewFor = 1800;

		const { event, deleted, written } = eventWithCookie('живой-идентификатор');
		const response = await chain(event);

		expect(response.status).toBe(200);
		expect(deleted).toEqual([]);
		expect(written).toEqual([{ value: 'живой-идентификатор', maxAge: 1800 }]);
	});

	it('запросу без cookie сбрасывать нечего', async () => {
		sessionState.userId = null;
		sessionState.renewFor = null;

		const { event, deleted } = eventWithCookie(undefined);

		const thrown = await chain(event).then(
			(response) => response,
			(failure: unknown) => failure
		);

		expect(isRedirect(thrown)).toBe(true);
		expect(deleted).toEqual([]);
	});
});
