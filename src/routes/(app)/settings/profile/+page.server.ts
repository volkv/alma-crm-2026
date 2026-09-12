import { error, redirect } from '@sveltejs/kit';
import { resolve } from '$app/paths';
import { fail, message, setError, superValidate } from 'sveltekit-superforms';
import { zod4 } from 'sveltekit-superforms/adapters';
import { actorFromEvent } from '$lib/server/actor';
import { recordAuditEvent } from '$lib/server/audit';
import { clearSessionCookie, revokeAllSessions } from '$lib/server/auth/session';
import { changePassword } from '$lib/server/auth/users';
import { AppError, ValidationError } from '$lib/server/errors';
import { getSetting } from '$lib/server/settings';
import { changePasswordSchema } from './schema';
import type { Actions, PageServerLoad } from './$types';

/**
 * Профиль: пароль и сессии того, кто вошёл. Отдельного права на раздел нет —
 * свой пароль меняет любой сотрудник, — но и чужую учётную запись отсюда не
 * тронуть: сервис работает только с `ctx.user`.
 *
 * Оба действия гасят все сессии владельца, включая текущую, и снимают cookie:
 * следующий запрос должен быть анонимным, а не биться о погашенную сессию.
 * Смена пароля уводит на форму входа с причиной в адресе, «завершить все
 * сессии» оставляет человека здесь с сообщением и кнопкой «Войти заново».
 */
export const load: PageServerLoad = async (event) => {
	const user = event.locals.user;

	if (user === null) {
		error(403, 'Профиль доступен только вошедшему пользователю');
	}

	return {
		account: { email: user.email, fullName: user.fullName },
		policy: await getSetting('password_policy'),
		form: await superValidate(zod4(changePasswordSchema))
	};
};

export const actions: Actions = {
	password: async (event) => {
		const form = await superValidate(event.request, zod4(changePasswordSchema));
		const { current, next } = form.data;

		// Пароли не возвращаются в браузер ни при каком исходе: форма
		// перерисовывается пустой, а не с набранным паролем в разметке ответа.
		form.data = { current: '', next: '', repeat: '' };

		if (!form.valid) {
			return fail(400, { form });
		}

		try {
			await changePassword(actorFromEvent(event), { current, next });
		} catch (failure) {
			if (failure instanceof AppError) {
				return setError(form, '', [
					failure.message,
					...(failure instanceof ValidationError ? failure.issues : [])
				]);
			}

			throw failure;
		}

		clearSessionCookie(event.cookies);

		// Сессии погашены все, включая текущую, поэтому на странице раздела
		// человеку делать нечего: следующий же запрос отсюда развернуло бы на
		// вход. Причина едет в адресе — форма входа объясняет, почему человек на
		// ней оказался, вместо того чтобы выглядеть внезапным выходом из системы.
		redirect(303, `${resolve('/login')}?reason=password-changed`);
	},

	revokeAll: async (event) => {
		const ctx = actorFromEvent(event);

		if (ctx.user === null) {
			error(403, 'Завершить сессии может только вошедший пользователь');
		}

		await revokeAllSessions(ctx.user.id);

		await recordAuditEvent(ctx, {
			type: 'auth.logout',
			outcome: 'success',
			subject: { type: 'user', id: ctx.user.id },
			details: { userId: ctx.user.id }
		});

		clearSessionCookie(event.cookies);

		return message(
			await superValidate(zod4(changePasswordSchema)),
			'Все сессии завершены — войдите заново.'
		);
	}
};
