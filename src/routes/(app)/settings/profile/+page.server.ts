import { error } from '@sveltejs/kit';
import { actorFromEvent } from '$lib/server/actor';
import { recordAuditEvent } from '$lib/server/audit';
import { clearSessionCookie, revokeAllSessions } from '$lib/server/auth/session';
import { ForbiddenError } from '$lib/server/errors';
import { toActionFailure } from '$lib/server/http';
import type { Actions, PageServerLoad } from './$types';

/**
 * Профиль: учётная запись, под которой вошли, и её сессии. Отдельного права на
 * раздел нет — свой профиль открывает любой сотрудник, — но и чужую учётную
 * запись отсюда не тронуть: раздел работает только с `ctx.user`.
 *
 * Пароля и второго фактора здесь нет: их спрашивает каталог учётных записей, и
 * менять их человек идёт туда же, где вводит (`docs/auth.md`). Осталось
 * действие, которое принадлежит именно нам: погасить все свои сессии — наши, а
 * не каталога, — если открытая вкладка осталась на чужой машине.
 *
 * Демонстрационной сессии действие недоступно. Учётная запись у неё общая: её
 * открыли все, кто зашёл на стенд, и «завершить все сессии» выкинуло бы из
 * системы всех посетителей разом. Права на собственные сессии нет и быть не
 * может (их гасит любой сотрудник), поэтому граница проходит здесь — по общей
 * учётной записи, ровно как у `deactivateUser`, который по той же причине не
 * даёт её выключить.
 */
export const load: PageServerLoad = async (event) => {
	const user = event.locals.user;

	if (user === null) {
		error(403, 'Профиль доступен только вошедшему пользователю');
	}

	return {
		account: { email: user.email, fullName: user.fullName, roleId: user.roleId },
		isDemo: user.isDemo
	};
};

export const actions: Actions = {
	revokeAll: async (event) => {
		const ctx = actorFromEvent(event);

		if (ctx.user === null) {
			error(403, 'Завершить сессии может только вошедший пользователь');
		}

		if (ctx.user.isDemo) {
			return toActionFailure(
				new ForbiddenError(
					'Демонстрационная учётная запись общая для всех, кто открыл стенд: завершить её сессии из демонстрации нельзя'
				)
			);
		}

		await revokeAllSessions(ctx.user.id);

		await recordAuditEvent(ctx, {
			type: 'auth.logout',
			outcome: 'success',
			subject: { type: 'user', id: ctx.user.id },
			details: { userId: ctx.user.id }
		});

		clearSessionCookie(event.cookies);

		return { message: 'Все сессии завершены — войдите заново.' };
	}
};
