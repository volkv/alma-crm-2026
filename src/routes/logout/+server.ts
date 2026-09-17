import { redirect, type RequestHandler } from '@sveltejs/kit';
import { actorFromEvent } from '$lib/server/actor';
import { recordAuditEvent } from '$lib/server/audit';
import { endSessionUrl } from '$lib/server/auth/oidc';
import {
	clearSessionCookie,
	destroySession,
	sessionIdToken,
	SESSION_COOKIE
} from '$lib/server/auth/session';
import { getConfig } from '$lib/server/config';

/**
 * Выход. Только POST: выход меняет состояние, поэтому его нельзя получить по
 * ссылке — ни предзагрузкой браузера, ни картинкой на чужом сайте.
 *
 * Гасятся обе сессии: наша — в Redis, чтобы украденный идентификатор не
 * пережил нажатие «Выйти», и сессия каталога — перенаправлением на его адрес
 * выхода. Без второго шага следующий вход каталог пропустил бы молча, по своей
 * ещё живой куке, и человек на общем компьютере оказался бы в чужой учётной
 * записи, не увидев формы.
 */
export const POST: RequestHandler = async (event) => {
	const ctx = actorFromEvent(event);
	const sessionId = event.cookies.get(SESSION_COOKIE);
	const idToken = sessionId === undefined ? null : await sessionIdToken(sessionId);

	if (sessionId !== undefined) {
		await destroySession(sessionId);
	}

	clearSessionCookie(event.cookies);

	if (ctx.user !== null) {
		await recordAuditEvent(ctx, {
			type: 'auth.logout',
			outcome: 'success',
			subject: { type: 'user', id: ctx.user.id },
			details: { userId: ctx.user.id }
		});
	}

	const returnTo = new URL('/login?reason=signed-out', getConfig().ORIGIN).toString();

	if (idToken === null) {
		// Сессии уже не было или она открыта не через каталог: гасить на его
		// стороне нечего, а отправлять туда браузер без подсказки значило бы
		// показать человеку лишний вопрос «точно выйти?».
		redirect(303, returnTo);
	}

	const endSession = await endSessionUrl({ idToken, returnTo }).catch((error: unknown) => {
		// Каталог не отвечает — наша сессия всё равно погашена, и человек должен
		// увидеть страницу входа, а не ошибку. Неудача уходит в лог сервера.
		console.error(`[auth] адрес выхода каталога недоступен, запрос ${ctx.requestId}`, error);

		return null;
	});

	redirect(303, endSession ?? returnTo);
};
