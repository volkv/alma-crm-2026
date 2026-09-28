import { error, type ActionFailure } from '@sveltejs/kit';
import { and, asc, eq, ne } from 'drizzle-orm';
import { fail, message, setError, superValidate, type SuperValidated } from 'sveltekit-superforms';
import { zod4 } from 'sveltekit-superforms/adapters';
import { id } from '$lib/contracts/common';
import {
	dadataSettingsFormSchema,
	deliverySettingsSchema,
	exchangeCmsFormSchema,
	exchangeLmsFormSchema,
	lmsSettingsFormSchema,
	webhookFormSchema,
	type DadataSettingsView
} from '$lib/contracts/integrations';
import { actorFromEvent } from '$lib/server/actor';
import { getConfig } from '$lib/server/config';
import { getDb } from '$lib/server/db';
import { users } from '$lib/server/db/schema';
import { AppError, ForbiddenError } from '$lib/server/errors';
import { errorIssues, toActionFailure, type ActionErrorPayload } from '$lib/server/http';
import { syncLms, readLmsState } from '$lib/server/integrations/lms/sync';
import { sendTestEvent } from '$lib/server/integrations/pump';
import {
	clearDadataKey,
	clearLmsToken,
	getDadataSettingsView,
	getDeliverySettings,
	getExchangeSettingsView,
	getLmsSettingsView,
	setDadataSettings,
	setDeliverySettings,
	setExchangeCmsSettings,
	setExchangeLmsSettings,
	setLmsSettings
} from '$lib/server/integrations/settings';
import {
	createWebhook,
	listWebhooks,
	readSubscription,
	updateWebhook
} from '$lib/server/integrations/subscriptions';
import { can } from '$lib/server/rbac';
import type { Actions, PageServerLoad } from './$types';
import { PERMISSIONS } from '$lib/server/rbac/permissions';

/**
 * Интеграции: подписки на события, подключения обмена, выгрузка из LMS и
 * подключение к Dadata (ключ подсказок и адрес сервиса).
 *
 * Раздел открыт правом `integrations.manage` — им же открыт журнал обмена, и
 * ради него стенд и показывают. Правка того, что уводит данные на чужой узел, —
 * отдельное право `integrations.manage_endpoints`: адрес и секрет подписки,
 * адрес и токен системы обучения, подключения обмена, периодичность фоновой
 * работы. Его публичная демонстрация не получает ни при какой роли
 * (`demoSessionPermissions`): заведённая подписка продолжает слать данные на
 * чужой адрес и после того, как посетитель ушёл.
 *
 * Поэтому без этого права страница показывает настройки, но не даёт их менять:
 * спрятать раздел целиком значило бы не показать обмен вовсе, а спрятанная
 * кнопка от `curl` не защищает — граница держится проверками в сервисах.
 */

/** Идентификаторы форм: связывают форму на сервере с формой в браузере. */
const FORM_IDS = {
	webhook: 'webhook',
	lms: 'lms-settings',
	delivery: 'delivery-settings',
	exchangeCms: 'exchange-cms-settings',
	exchangeLms: 'exchange-lms-settings',
	dadata: 'dadata-settings'
} as const;

export const load: PageServerLoad = async (event) => {
	const ctx = actorFromEvent(event);

	if (!can(ctx, 'integrations.manage')) {
		error(403, `Раздел доступен только с правом «${PERMISSIONS['integrations.manage']}»`);
	}

	const [webhooks, lms, delivery, lmsState, exchange, owners, dadata] = await Promise.all([
		listWebhooks(ctx),
		getLmsSettingsView(ctx),
		getDeliverySettings(),
		readLmsState(),
		getExchangeSettingsView(ctx),
		listIntakeOwners(),
		getDadataSettingsView(ctx)
	]);

	const config = getConfig();

	return {
		webhooks,
		lms,
		lmsState,
		exchange,
		owners,
		// Ключ Dadata целиком сюда не попадает: только маска и источник.
		dadata,
		// Адрес имитатора показывается только тогда, когда развёртывание его
		// назвало: подсказывать адрес, которого нет, значит врать.
		lmsHint: config.EXCHANGE_LMS_BASE_URL,
		// Адреса, секреты и периодичность правит не всякий, кто ведёт обмен: они
		// уводят данные на чужой узел и переживают сессию
		// (`docs/access-matrix.md`, раздел 5).
		canManageEndpoints: can(ctx, 'integrations.manage_endpoints'),
		// Демонстрационная сессия этого права не получает, даже если роль его
		// даёт (`demoSessionPermissions`): страница обязана сказать об этом
		// прямо, а не отсылать к праву, которое у роли в матрице есть.
		demoSession: ctx.user?.isDemo === true,
		origin: config.ORIGIN,
		webhookForm: await superValidate(zod4(webhookFormSchema), { id: FORM_IDS.webhook }),
		lmsForm: await superValidate(
			{
				baseUrl: lms.baseUrl ?? '',
				token: null,
				enabled: lms.enabled,
				syncIntervalMinutes: lms.syncIntervalMinutes
			},
			zod4(lmsSettingsFormSchema),
			{ id: FORM_IDS.lms }
		),
		deliveryForm: await superValidate(delivery, zod4(deliverySettingsSchema), {
			id: FORM_IDS.delivery
		}),
		exchangeCmsForm: await superValidate(
			{
				cmsInstance: exchange.cms.instance,
				cmsStatusUrl: exchange.cms.statusUrl ?? '',
				cmsSecret: null,
				cmsDefaultOwnerUserId: exchange.cms.defaultOwnerUserId
			},
			zod4(exchangeCmsFormSchema),
			{ id: FORM_IDS.exchangeCms }
		),
		exchangeLmsForm: await superValidate(
			{
				lmsInstance: exchange.lms.instance,
				lmsGroupsUrl: exchange.lms.groupsUrl ?? '',
				lmsSecret: null
			},
			zod4(exchangeLmsFormSchema),
			{ id: FORM_IDS.exchangeLms }
		),
		dadataForm: await superValidate(
			{ baseUrl: dadata.customBaseUrl ? dadata.baseUrl : '', apiKey: null },
			zod4(dadataSettingsFormSchema),
			{ id: FORM_IDS.dadata }
		)
	};
};

/**
 * Кого можно назначить ответственным за входящие заявки: действующие сотрудники,
 * кроме машинного субъекта — тот заявки не ведёт.
 */
async function listIntakeOwners(): Promise<{ id: string; fullName: string }[]> {
	return getDb()
		.select({ id: users.id, fullName: users.fullName })
		.from(users)
		.where(and(eq(users.isActive, true), ne(users.roleId, 'service')))
		.orderBy(asc(users.fullName));
}

/**
 * Предметная ошибка показывается над формой целиком: у неё нет поля, к
 * которому её можно отнести, а угадывать поле по тексту сообщения значит
 * сломаться на первой же правке текста. Отказ по правам уходит своим кодом —
 * он не претензия к заполнению и правкой полей не поправляется.
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

/** Подписка из тела формы действия — по её идентификатору. */
async function subscriptionFrom(request: Request) {
	const webhookId = id('Некорректный идентификатор подписки').safeParse(
		(await request.formData()).get('webhookId')
	);

	if (!webhookId.success) {
		return null;
	}

	return readSubscription(webhookId.data);
}

export const actions: Actions = {
	webhook: async (event) => {
		const form = await superValidate(event.request, zod4(webhookFormSchema), {
			id: FORM_IDS.webhook
		});

		if (!form.valid) {
			return fail(400, { form });
		}

		const ctx = actorFromEvent(event);

		try {
			if (form.data.id === null) {
				const created = await createWebhook(ctx, form.data);

				// Единственный раз, когда секрет покидает сервер: дальше им только
				// подписывают, и восстановить его неоткуда.
				return message(form, { secret: created.secret, name: created.webhook.name });
			}

			await updateWebhook(ctx, { ...form.data, id: form.data.id });
		} catch (failure) {
			return asFormError(form, failure);
		}

		return message(form, null);
	},

	test: async (event) => {
		const ctx = actorFromEvent(event);

		if (!can(ctx, 'integrations.manage')) {
			return toActionFailure(
				new ForbiddenError('Недостаточно прав: требуется «integrations.manage»')
			);
		}

		const subscription = await subscriptionFrom(event.request);

		if (subscription === null) {
			return fail(400, {
				message: 'Не указано, в какую подписку отправлять',
				issues: [],
				ok: false
			});
		}

		const outcome = await sendTestEvent(ctx, subscription);

		// Недоставка тестового события — ответ на вопрос «дойдёт ли», а не сбой
		// запроса: страница отвечает обычным ответом с `ok: false`. Код 502
		// здесь значил бы, что сломалась сама CRM, и сыпался бы в консоль.
		return {
			message: outcome.ok
				? `Получатель ответил ${outcome.status ?? ''}`.trim()
				: `Тестовое событие не доставлено: ${outcome.error ?? 'получатель не принял событие'}`,
			issues: [],
			ok: outcome.ok
		};
	},

	lms: async (event) => {
		const form = await superValidate(event.request, zod4(lmsSettingsFormSchema), {
			id: FORM_IDS.lms
		});

		const token = form.data.token;

		// Токен не возвращается в браузер ни при каком исходе — как пароль на
		// странице входа: ответ действия перерисовывает форму её же данными, и
		// токен веб-сервиса оказался бы в разметке ответа, хотя на экране его не
		// показывают даже сохранённым.
		form.data.token = null;

		if (!form.valid) {
			return fail(400, { form });
		}

		try {
			await setLmsSettings(actorFromEvent(event), {
				baseUrl: form.data.baseUrl === '' ? null : form.data.baseUrl,
				// Пустое поле означает «оставить прежний токен»: показать сохранённый
				// нельзя, и требовать набирать его заново ради смены адреса значило
				// бы заставлять хранить его в переписке.
				token,
				enabled: form.data.enabled,
				syncIntervalMinutes: form.data.syncIntervalMinutes
			});
		} catch (failure) {
			return asFormError(form, failure);
		}

		return message(form, 'Настройки системы обучения сохранены');
	},

	forgetToken: async (event) => {
		try {
			await clearLmsToken(actorFromEvent(event));
		} catch (failure) {
			return toActionFailure(failure);
		}

		return { message: 'Токен удалён, выгрузка по расписанию выключена', issues: [], ok: true };
	},

	sync: async (event) => {
		const ctx = actorFromEvent(event);

		if (!can(ctx, 'integrations.manage')) {
			return toActionFailure(
				new ForbiddenError('Недостаточно прав: требуется «integrations.manage»')
			);
		}

		try {
			const state = await syncLms(ctx);

			// Неудачная выгрузка — исход, а не сбой запроса: тот же ответ, что и
			// у тестового события.
			return { message: state.message, issues: [], ok: state.ok };
		} catch (failure) {
			// Сюда доходит только отказ по правам: сбой самой выгрузки возвращается
			// состоянием, а не исключением.
			return toActionFailure(failure);
		}
	},

	/**
	 * Подключение сайта (CMS). Половина системы обучения не приходит с формой и
	 * не меняется: сервис берёт её из базы как есть.
	 */
	exchangeCms: async (event) => {
		const form = await superValidate(event.request, zod4(exchangeCmsFormSchema), {
			id: FORM_IDS.exchangeCms
		});

		const cmsSecret = form.data.cmsSecret;

		// Секрет не возвращается в браузер ни при каком исходе: ответ действия
		// перерисовывает форму её же данными, и секрет подписи оказался бы в
		// разметке ответа, хотя на экране его не показывают даже сохранённым.
		form.data.cmsSecret = null;

		if (!form.valid) {
			return fail(400, { form });
		}

		try {
			await setExchangeCmsSettings(actorFromEvent(event), { ...form.data, cmsSecret });
		} catch (failure) {
			return asFormError(form, failure);
		}

		return message(form, 'Подключение сайта сохранено');
	},

	/** Обмен учебными группами: половина сайта не меняется. */
	exchangeLms: async (event) => {
		const form = await superValidate(event.request, zod4(exchangeLmsFormSchema), {
			id: FORM_IDS.exchangeLms
		});

		const lmsSecret = form.data.lmsSecret;

		form.data.lmsSecret = null;

		if (!form.valid) {
			return fail(400, { form });
		}

		try {
			await setExchangeLmsSettings(actorFromEvent(event), { ...form.data, lmsSecret });
		} catch (failure) {
			return asFormError(form, failure);
		}

		return message(form, 'Обмен учебными группами сохранён');
	},

	dadata: async (event) => {
		const form = await superValidate(event.request, zod4(dadataSettingsFormSchema), {
			id: FORM_IDS.dadata
		});

		const apiKey = form.data.apiKey;

		// Ключ не возвращается в браузер ни при каком исходе: ответ действия
		// перерисовывает форму её же данными, и ключ оказался бы в разметке.
		form.data.apiKey = null;

		if (!form.valid) {
			return fail(400, { form });
		}

		try {
			await setDadataSettings(actorFromEvent(event), {
				baseUrl: form.data.baseUrl === '' ? null : form.data.baseUrl,
				apiKey
			});
		} catch (failure) {
			return asFormError(form, failure);
		}

		return message(form, 'Настройки Dadata сохранены');
	},

	forgetDadataKey: async (event) => {
		let view: DadataSettingsView;

		try {
			view = await clearDadataKey(actorFromEvent(event));
		} catch (failure) {
			return toActionFailure(failure);
		}

		return {
			message:
				view.keySource === 'environment'
					? 'Ключ из интерфейса удалён. Действует ключ из окружения сервера, адрес — облачный'
					: 'Ключ удалён: поиск по ЕГРЮЛ не подключён',
			issues: [],
			ok: true
		};
	},

	delivery: async (event) => {
		const form = await superValidate(event.request, zod4(deliverySettingsSchema), {
			id: FORM_IDS.delivery
		});

		if (!form.valid) {
			return fail(400, { form });
		}

		try {
			await setDeliverySettings(actorFromEvent(event), form.data);
		} catch (failure) {
			return asFormError(form, failure);
		}

		return message(form, 'Периодичность доставки сохранена');
	}
};
