import { redirect } from '@sveltejs/kit';
import { fail, message, superValidate } from 'sveltekit-superforms';
import { zod4 } from 'sveltekit-superforms/adapters';
import { loginSchema } from '$lib/contracts/auth';
import { pluralize } from '$lib/format';
import { actorFromEvent } from '$lib/server/actor';
import { addressLimitState, UNKNOWN_ADDRESS } from '$lib/server/auth/lockout';
import { demoLogin, listDemoAccounts, login } from '$lib/server/auth/login';
import { safeNextPath } from '$lib/server/auth/redirect';
import { setSessionCookie } from '$lib/server/auth/session';
import { toActionFailure } from '$lib/server/http';
import { getSetting } from '$lib/server/settings';
import type { Actions, PageServerLoad } from './$types';

/**
 * Почему человек оказался на форме входа, если пришёл сюда не сам. Список
 * закрыт: текст сообщения пишем мы, а не адресная строка, — иначе ссылкой на
 * форму входа можно показать посетителю любую фразу от имени системы.
 */
const REASON_NOTICES: Record<string, string> = {
	'password-changed': 'Пароль изменён, войдите заново'
};

/**
 * Адрес выбрал свой лимит попыток входа.
 *
 * Форму в этом случае не рисуем вовсе: `rate-limit` завернёт её POST обратно
 * сюда, и человек будет жать «Войти» в пустоту. Вместо этого страница говорит,
 * что произошло и сколько ждать, — счётчик окна как раз и знает срок. Сюда же
 * приводит перенаправление хука, поэтому текст один и на отказ, и на
 * обновление страницы.
 */
function rateLimitNotice(remainingSeconds: number): string {
	const minutes = Math.max(1, Math.ceil(remainingSeconds / 60));

	return `Слишком много входов с этого адреса. Попробуйте через ${pluralize(minutes, ['минуту', 'минуты', 'минут'])}`;
}

export const load: PageServerLoad = async (event) => {
	// Вошедшему на странице входа делать нечего — и ссылка на неё из закладок не
	// должна выглядеть как выход из системы.
	if (event.locals.user !== null) {
		redirect(303, safeNextPath(event.url.searchParams.get('next')));
	}

	const [banner, demoAccounts, limit] = await Promise.all([
		getSetting('login_banner'),
		listDemoAccounts(),
		addressLimitState(event.getClientAddress() || UNKNOWN_ADDRESS)
	]);

	const reason = event.url.searchParams.get('reason');

	return {
		banner,
		demoAccounts,
		notice: reason === null ? null : (REASON_NOTICES[reason] ?? null),
		rateLimited: limit.exhausted ? rateLimitNotice(limit.remainingSeconds) : null,
		form: await superValidate(zod4(loginSchema))
	};
};

export const actions: Actions = {
	// Обе формы страницы названы: SvelteKit не разрешает держать действие по
	// умолчанию рядом с именованным.
	login: async (event) => {
		const form = await superValidate(event.request, zod4(loginSchema));
		const password = form.data.password;

		// Пароль не возвращается в браузер ни при каком исходе: форма перерисуется
		// пустой, а не с введённым паролем в разметке ответа.
		form.data.password = '';

		if (!form.valid) {
			return fail(400, { form });
		}

		const outcome = await login(actorFromEvent(event), { email: form.data.email, password });

		if (!outcome.ok) {
			return message(form, outcome.message, { status: outcome.reason === 'locked' ? 429 : 400 });
		}

		await setSessionCookie(event.cookies, outcome.sessionId);

		redirect(303, safeNextPath(event.url.searchParams.get('next')));
	},

	demo: async (event) => {
		const roleId = (await event.request.formData()).get('role');

		if (typeof roleId !== 'string' || roleId === '') {
			return fail(400, { message: 'Не указано, под какой ролью входить', issues: [] });
		}

		let sessionId: string;

		try {
			sessionId = await demoLogin(actorFromEvent(event), roleId);
		} catch (error) {
			return toActionFailure(error);
		}

		await setSessionCookie(event.cookies, sessionId);

		redirect(303, safeNextPath(event.url.searchParams.get('next')));
	}
};
