import { error, type ActionFailure } from '@sveltejs/kit';
import { fail, message, setError, superValidate, type SuperValidated } from 'sveltekit-superforms';
import { zod4 } from 'sveltekit-superforms/adapters';
import { settingSchemas } from '$lib/contracts/settings';
import { actorFromEvent } from '$lib/server/actor';
import { AppError, ForbiddenError } from '$lib/server/errors';
import { errorIssues, toActionFailure, type ActionErrorPayload } from '$lib/server/http';
import { can } from '$lib/server/rbac';
import { getSetting, setSetting } from '$lib/server/settings';
import { sessionLimitsSchema } from './schema';
import type { Actions, PageServerLoad } from './$types';

/**
 * Общие настройки: то, что администратор меняет из интерфейса, а не
 * переменными окружения. Каждая карточка — своя форма и своё действие: у них
 * разные схемы и разные последствия, и общая кнопка «Сохранить всё» означала
 * бы, что правка баннера трогает сроки жизни сессии.
 *
 * Политик пароля, блокировки и второго фактора здесь нет: пароль спрашивает
 * каталог учётных записей, и правила к нему задаются в нём же
 * (`keycloak/README.md`).
 */

/** Формы страницы; идентификатор связывает форму на сервере с формой в браузере. */
const FORM_IDS = {
	banner: 'login-banner',
	session: 'session-limits'
} as const;

export const load: PageServerLoad = async (event) => {
	const ctx = actorFromEvent(event);

	if (!can(ctx, 'settings.write')) {
		error(403, 'Раздел доступен только с правом «Изменение настроек приложения»');
	}

	const [banner, idleMinutes, absoluteHours] = await Promise.all([
		getSetting('login_banner'),
		getSetting('session_idle_minutes'),
		getSetting('session_absolute_hours')
	]);

	return {
		bannerForm: await superValidate(banner, zod4(settingSchemas.login_banner), {
			id: FORM_IDS.banner
		}),
		sessionForm: await superValidate({ idleMinutes, absoluteHours }, zod4(sessionLimitsSchema), {
			id: FORM_IDS.session
		})
	};
};

/**
 * Предметная ошибка записи настройки показывается над формой целиком: у неё
 * нет поля, к которому её можно отнести, а угадывать поле по тексту сообщения
 * значит сломаться на первой же правке текста. Разбирает ошибку общий
 * переводчик — форма только решает, куда положить его текст.
 *
 * Отказ по правам из этого правила выведен: он не претензия к заполнению и
 * правкой полей не поправляется, поэтому уходит своим кодом — 403, а не 400 от
 * ошибки формы. Текст при этом не теряется: страница показывает его над
 * карточками, как это делает раздел пользователей.
 */
function asFormError<Out extends Record<string, unknown>, M, In extends Record<string, unknown>>(
	form: SuperValidated<Out, M, In>,
	failure: unknown
): ActionFailure<{ form: SuperValidated<Out, M, In> } | ActionErrorPayload> {
	if (failure instanceof ForbiddenError) {
		return toActionFailure(failure);
	}

	if (failure instanceof AppError) {
		return setError(form, '', [failure.message, ...errorIssues(failure)]);
	}

	throw failure;
}

export const actions: Actions = {
	banner: async (event) => {
		const form = await superValidate(event.request, zod4(settingSchemas.login_banner), {
			id: FORM_IDS.banner
		});

		if (!form.valid) {
			return fail(400, { form });
		}

		try {
			await setSetting(actorFromEvent(event), 'login_banner', form.data);
		} catch (failure) {
			return asFormError(form, failure);
		}

		return message(form, 'Баннер страницы входа сохранён');
	},

	session: async (event) => {
		const form = await superValidate(event.request, zod4(sessionLimitsSchema), {
			id: FORM_IDS.session
		});

		if (!form.valid) {
			return fail(400, { form });
		}

		const ctx = actorFromEvent(event);

		try {
			await setSetting(ctx, 'session_idle_minutes', form.data.idleMinutes);
			await setSetting(ctx, 'session_absolute_hours', form.data.absoluteHours);
		} catch (failure) {
			return asFormError(form, failure);
		}

		return message(form, 'Сроки жизни сессии сохранены');
	}
};
