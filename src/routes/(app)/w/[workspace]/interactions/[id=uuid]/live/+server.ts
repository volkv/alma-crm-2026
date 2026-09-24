import { error } from '@sveltejs/kit';
import { liveActivitySchema } from '$lib/contracts/live';
import { SESSION_COOKIE } from '$lib/server/auth/session';
import { openInteractionStream, recordActivity } from '$lib/server/live/stream';
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

/**
 * Сигнал занятости: «набираю комментарий», «открыл форму правки полей» или
 * «закончил» — `{ kind, active }`. Ответ без тела; дела не видно — 404, как у
 * потока.
 *
 * Тело — только JSON. Такой запрос браузер с чужой страницы без согласования
 * (`CORS preflight`) не отправит, а согласования наш сервер не даёт; формы с
 * чужого сайта отсекает хук `csrf` по `Origin`, а сюда они не проходят и по
 * типу тела.
 */
export const POST: RequestHandler = async ({ cookies, locals, params, request }) => {
	const sessionId = cookies.get(SESSION_COOKIE);

	if (sessionId === undefined || locals.user === null) {
		error(401, 'Нужен вход');
	}

	if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) {
		error(415, 'Ожидается JSON');
	}

	let body: unknown;

	try {
		body = await request.json();
	} catch {
		error(400, 'Тело запроса — не JSON');
	}

	const signal = liveActivitySchema.safeParse(body);

	if (!signal.success) {
		error(400, 'Непонятный сигнал');
	}

	const recorded = await recordActivity({
		sessionId,
		user: locals.user,
		interactionId: params.id,
		workspaceKey: params.workspace,
		signal: signal.data
	});

	if (!recorded) {
		error(404, 'Взаимодействие не найдено');
	}

	return new Response(null, { status: 204 });
};
