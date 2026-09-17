/**
 * Событие запроса в том виде, в каком его собирает SvelteKit.
 *
 * Загрузчики, действия форм и `+server.ts` внутри оболочки — это отдельный
 * слой: право на раздел, разбор адреса, перевод предметной ошибки в статус
 * живут там, а не в сервисах. Проверять их можно только через событие, поэтому
 * подделка одна на все такие тесты: адрес, тело, параметры пути и `locals` —
 * остальное в ней не участвует.
 */
import type { RequestEvent } from '@sveltejs/kit';
import type { SessionUser } from '$lib/server/auth/types';
import type { PermissionKey } from '$lib/server/rbac/permissions';
import { testActor } from './db';

/**
 * Пользователь запроса: тот же, что кладёт в `locals` хук сессии.
 *
 * Набор прав можно задать явно — так выражается «учётная запись без права X»:
 * отдельной роли «только смотреть» в системе нет, и отнимать право приходится
 * у той роли, у которой оно есть.
 */
export function sessionUser(roleId: string, permissions?: readonly PermissionKey[]): SessionUser {
	const user = testActor({ roleId, permissions }).user;

	if (user === null) {
		throw new Error('testActor обязан вернуть пользователя');
	}

	return user;
}

export type EventOptions = {
	path?: string;
	query?: string;
	method?: string;
	/** Идентификатор маршрута; нужен только тому, кто читает `event.route`. */
	routeId?: string;
	/** Параметры пути: `[id=uuid]` и прочее, что SvelteKit разбирает за нас. */
	params?: Record<string, string>;
	user?: SessionUser;
	form?: Record<string, string>;
	/** Заголовки запроса; нужны тому, кто решает по `Accept`, чем отвечать. */
	headers?: Record<string, string>;
};

export function pageEvent(options: EventOptions = {}): RequestEvent {
	const url = new URL(`http://localhost${options.path ?? '/'}${options.query ?? ''}`);

	let body: FormData | undefined;
	if (options.form !== undefined) {
		body = new FormData();
		for (const [name, value] of Object.entries(options.form)) {
			body.set(name, value);
		}
	}

	return {
		request: new Request(url, {
			method: options.method ?? (body ? 'POST' : 'GET'),
			headers: options.headers,
			body
		}),
		url,
		params: options.params ?? {},
		// Действия профиля снимают cookie сессии; больше от неё ничего не нужно.
		cookies: { get: () => undefined, set: () => {}, delete: () => {} },
		route: { id: options.routeId ?? '/(app)' },
		locals: {
			requestId: crypto.randomUUID(),
			user: options.user ?? sessionUser('admin'),
			apiKey: null
		},
		getClientAddress: () => '198.51.100.10',
		setHeaders: () => {},
		isDataRequest: false,
		isSubRequest: false
	} as unknown as RequestEvent;
}
