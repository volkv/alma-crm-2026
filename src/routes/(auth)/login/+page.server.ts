import { redirect } from '@sveltejs/kit';
import { fail, message, superValidate } from 'sveltekit-superforms';
import { zod4 } from 'sveltekit-superforms/adapters';
import { loginSchema } from '$lib/contracts/auth';
import { actorFromEvent } from '$lib/server/actor';
import { demoLogin, listDemoAccounts, login } from '$lib/server/auth/login';
import { safeNextPath } from '$lib/server/auth/redirect';
import { setSessionCookie } from '$lib/server/auth/session';
import { toActionFailure } from '$lib/server/http';
import { getSetting } from '$lib/server/settings';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	// Вошедшему на странице входа делать нечего — и ссылка на неё из закладок не
	// должна выглядеть как выход из системы.
	if (event.locals.user !== null) {
		redirect(303, safeNextPath(event.url.searchParams.get('next')));
	}

	const [banner, demoAccounts] = await Promise.all([
		getSetting('login_banner'),
		listDemoAccounts()
	]);

	return { banner, demoAccounts, form: await superValidate(zod4(loginSchema)) };
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
