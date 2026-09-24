import { error, type ActionFailure } from '@sveltejs/kit';
import { fail, message, setError, superValidate, type SuperValidated } from 'sveltekit-superforms';
import { zod4 } from 'sveltekit-superforms/adapters';
import { settingSchemas } from '$lib/contracts/settings';
import { actorFromEvent } from '$lib/server/actor';
import { getConfig } from '$lib/server/config';
import { resetDemoData } from '$lib/server/demo/reset';
import { AppError, ForbiddenError } from '$lib/server/errors';
import { errorIssues, toActionFailure, type ActionErrorPayload } from '$lib/server/http';
import { can } from '$lib/server/rbac';
import { getSetting, setSetting } from '$lib/server/settings';
import {
	demoScheduleSchema,
	enrichmentSchema,
	sessionLimitsSchema,
	stuckWatchSchema
} from './schema';
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
 *
 * Здесь же стоит кнопка сброса демонстрационных данных: она не настройка, но
 * распоряжается стендом целиком — как и всё остальное на этой странице, — а
 * своего раздела ради одной кнопки заводить незачем.
 */

/** Формы страницы; идентификатор связывает форму на сервере с формой в браузере. */
const FORM_IDS = {
	banner: 'login-banner',
	session: 'session-limits',
	stuckWatch: 'stuck-watch',
	demoSchedule: 'demo-reset-schedule',
	enrichment: 'enrichment'
} as const;

export const load: PageServerLoad = async (event) => {
	const ctx = actorFromEvent(event);

	if (!can(ctx, 'settings.write')) {
		error(403, 'Раздел доступен только с правом «Изменение настроек приложения»');
	}

	const [
		banner,
		idleMinutes,
		absoluteHours,
		thresholdDays,
		licenseWarningDays,
		channels,
		digest,
		demoSchedule,
		enrichment
	] = await Promise.all([
		getSetting('login_banner'),
		getSetting('session_idle_minutes'),
		getSetting('session_absolute_hours'),
		getSetting('stuck_threshold_days'),
		getSetting('license_warning_days'),
		getSetting('notification_channels'),
		getSetting('daily_digest'),
		getSetting('demo_reset_schedule'),
		getSetting('enrichment')
	]);

	return {
		bannerForm: await superValidate(banner, zod4(settingSchemas.login_banner), {
			id: FORM_IDS.banner
		}),
		sessionForm: await superValidate({ idleMinutes, absoluteHours }, zod4(sessionLimitsSchema), {
			id: FORM_IDS.session
		}),
		stuckWatchForm: await superValidate(
			{
				thresholdDays,
				licenseWarningDays,
				digestEnabled: digest.enabled,
				digestHour: digest.hour,
				...channels
			},
			zod4(stuckWatchSchema),
			{
				id: FORM_IDS.stuckWatch
			}
		),
		demoScheduleForm: await superValidate(demoSchedule, zod4(demoScheduleSchema), {
			id: FORM_IDS.demoSchedule
		}),
		enrichmentForm: await superValidate(enrichment, zod4(enrichmentSchema), {
			id: FORM_IDS.enrichment
		}),
		dadataConfigured: getConfig().DADATA_API_KEY !== null,
		// Вне демонстрационного стенда действия сброса не существует вовсе, и
		// карточка объясняет это вместо того, чтобы исчезнуть: пропавшая кнопка
		// не отвечает на вопрос, куда она делась.
		demoMode: getConfig().DEMO_MODE
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
	},

	/**
	 * Пороги наблюдателей, час сводки и каналы — одной кнопкой: правило и способ, которым о нём
	 * сообщают, это одна настройка. Записываются они двумя ключами, потому что
	 * читают их разные места: порог — выборка наблюдателя, каналы — его цикл.
	 */
	stuckWatch: async (event) => {
		const form = await superValidate(event.request, zod4(stuckWatchSchema), {
			id: FORM_IDS.stuckWatch
		});

		if (!form.valid) {
			return fail(400, { form });
		}

		const ctx = actorFromEvent(event);
		const { thresholdDays, licenseWarningDays, digestEnabled, digestHour, ...channels } = form.data;

		try {
			await setSetting(ctx, 'stuck_threshold_days', thresholdDays);
			await setSetting(ctx, 'license_warning_days', licenseWarningDays);
			await setSetting(ctx, 'daily_digest', { enabled: digestEnabled, hour: digestHour });
			await setSetting(ctx, 'notification_channels', channels);
		} catch (failure) {
			return asFormError(form, failure);
		}

		return message(form, 'Правило напоминаний сохранено');
	},

	/**
	 * Расписание сброса стенда. Настройка одна, поэтому форма пишет её одним
	 * ключом: выключатель и час — это одно правило, и раздельное сохранение
	 * означало бы стенд, который сбрасывается «в 3 часа, но выключено».
	 */
	demoSchedule: async (event) => {
		const form = await superValidate(event.request, zod4(demoScheduleSchema), {
			id: FORM_IDS.demoSchedule
		});

		if (!form.valid) {
			return fail(400, { form });
		}

		try {
			await setSetting(actorFromEvent(event), 'demo_reset_schedule', form.data);
		} catch (failure) {
			return asFormError(form, failure);
		}

		return message(form, 'Расписание сброса сохранено');
	},

	/**
	 * Внешние источники паспорта организации. Выключатель и квота — одно
	 * правило, поэтому и ключ один.
	 */
	enrichment: async (event) => {
		const form = await superValidate(event.request, zod4(enrichmentSchema), {
			id: FORM_IDS.enrichment
		});

		if (!form.valid) {
			return fail(400, { form });
		}

		try {
			await setSetting(actorFromEvent(event), 'enrichment', form.data);
		} catch (failure) {
			return asFormError(form, failure);
		}

		return message(form, 'Настройка внешних источников сохранена');
	},

	/**
	 * Сброс демонстрационных данных. Формы у действия нет — подтверждение
	 * спрашивает диалог, а на сервер приходит пустой POST, — поэтому и ответ
	 * идёт не через superforms: успех несёт свой ключ, отказ — обычный `fail`
	 * с текстом, который страница показывает над карточками.
	 */
	demoReset: async (event) => {
		try {
			const result = await resetDemoData(actorFromEvent(event));

			return {
				demoReset: `Демонстрационные данные сброшены: взаимодействий — ${result.interactionCount}, организаций — ${result.organizationCount}, документов — ${result.documentCount}`
			};
		} catch (failure) {
			return toActionFailure(failure);
		}
	}
};
