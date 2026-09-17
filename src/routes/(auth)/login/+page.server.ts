import { redirect } from '@sveltejs/kit';
import { fail } from '@sveltejs/kit';
import { DEMO_ACCOUNTS } from '$lib/contracts/auth';
import { callbackUrl, rememberFlow } from '$lib/server/auth/flow';
import { authorizationUrl, newLoginAttempt } from '$lib/server/auth/oidc';
import { safeNextPath } from '$lib/server/auth/redirect';
import { startLimitNotice } from '$lib/server/auth/start-limit';
import { getConfig } from '$lib/server/config';
import { clientAddress } from '$lib/server/http';
import { getSetting } from '$lib/server/settings';
import type { Actions, PageServerLoad } from './$types';

/**
 * Почему человек оказался на странице входа, если пришёл сюда не сам. Список
 * закрыт: текст сообщения пишем мы, а не адресная строка, — иначе ссылкой на
 * страницу входа можно показать посетителю любую фразу от имени системы.
 */
const REASON_NOTICES: Record<string, string> = {
	'signed-out': 'Вы вышли из системы',
	expired: 'Сессия закончилась, войдите заново'
};

export const load: PageServerLoad = async (event) => {
	// Вошедшему на странице входа делать нечего — и ссылка на неё из закладок не
	// должна выглядеть как выход из системы.
	if (event.locals.user !== null) {
		redirect(303, safeNextPath(event.url.searchParams.get('next')));
	}

	// Адрес выбрал свой лимит заходов — кнопки на странице не будет вовсе: её
	// POST развернёт обратно сюда, и человек будет жать «Войти» в пустоту. Сюда
	// же приводит перенаправление хука, поэтому текст один и на отказ, и на
	// обновление страницы.
	const [banner, rateLimited] = await Promise.all([
		getSetting('login_banner'),
		startLimitNotice(clientAddress(event))
	]);

	const reason = event.url.searchParams.get('reason');

	return {
		banner,
		// Список демонстрационных записей показывается только на стенде: вне
		// демо-режима подсказывать чужие имена входа не за чем.
		demoAccounts: getConfig().DEMO_MODE ? DEMO_ACCOUNTS : [],
		notice: reason === null ? null : (REASON_NOTICES[reason] ?? null),
		rateLimited
	};
};

export const actions: Actions = {
	/**
	 * Начало входа: одноразовые значения заходят в Redis, браузер уходит в
	 * каталог. Метод POST, а не ссылка: заход заводит запись на сервере, и
	 * получить его предзагрузкой браузера или картинкой на чужой странице
	 * нельзя — хук `csrf` проверяет происхождение именно у POST.
	 */
	default: async (event) => {
		const attempt = newLoginAttempt();
		const next = safeNextPath(event.url.searchParams.get('next'));

		let url: string;

		try {
			url = await authorizationUrl(attempt, callbackUrl());
		} catch (error) {
			console.error(`[auth] каталог недоступен, запрос ${event.locals.requestId}`, error);

			return fail(503, {
				message: 'Каталог учётных записей сейчас не отвечает. Повторите через минуту.'
			});
		}

		await rememberFlow(event.cookies, { ...attempt, next });

		redirect(303, url);
	}
};
