import { redirect, type RequestHandler } from '@sveltejs/kit';
import { actorFromEvent } from '$lib/server/actor';
import { recordAuditEvent } from '$lib/server/audit';
import { clearSessionCookie, destroySession, SESSION_COOKIE } from '$lib/server/auth/session';

/**
 * Выход. Только POST: выход меняет состояние, поэтому его нельзя получить по
 * ссылке — ни предзагрузкой браузера, ни картинкой на чужом сайте.
 *
 * Сессия гасится в Redis, а не только в cookie: иначе украденный идентификатор
 * продолжал бы работать после того, как человек нажал «Выйти».
 */
export const POST: RequestHandler = async (event) => {
	const ctx = actorFromEvent(event);
	const sessionId = event.cookies.get(SESSION_COOKIE);

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

	redirect(303, '/login');
};
