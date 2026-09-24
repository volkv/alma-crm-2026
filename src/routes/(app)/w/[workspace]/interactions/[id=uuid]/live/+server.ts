import { error } from '@sveltejs/kit';
import { SESSION_COOKIE } from '$lib/server/auth/session';
import { openInteractionStream } from '$lib/server/live/stream';
import type { RequestHandler } from './$types';

/**
 * Поток живой карточки (SSE): кто сейчас в карточке, у кого доступ к делу и
 * что в нём изменилось. Всё устройство — в `$lib/server/live/stream.ts`.
 *
 * Только для браузера с сессией: поток держится на сессии и перепроверяет её
 * сам, без продления. Ключу API тут делать нечего — у внешней системы нет
 * открытой карточки.
 */
export const GET: RequestHandler = async ({ cookies, locals, params, request }) => {
	const sessionId = cookies.get(SESSION_COOKIE);

	if (sessionId === undefined || locals.user === null) {
		error(401, 'Нужен вход');
	}

	const opened = await openInteractionStream({
		sessionId,
		interactionId: params.id,
		workspaceKey: params.workspace,
		signal: request.signal
	});

	if (!(opened instanceof Response)) {
		error(opened.status, opened.message);
	}

	return opened;
};
