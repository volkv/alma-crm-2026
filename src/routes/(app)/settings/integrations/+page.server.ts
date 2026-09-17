import { error, type ActionFailure } from '@sveltejs/kit';
import { and, asc, eq, ne } from 'drizzle-orm';
import { fail, message, setError, superValidate, type SuperValidated } from 'sveltekit-superforms';
import { zod4 } from 'sveltekit-superforms/adapters';
import { id } from '$lib/contracts/common';
import {
	deliverySettingsSchema,
	exchangeSettingsFormSchema,
	lmsSettingsFormSchema,
	webhookFormSchema
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
	clearLmsToken,
	getDeliverySettings,
	getExchangeSettingsView,
	getLmsSettingsView,
	setDeliverySettings,
	setExchangeSettings,
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

/**
 * Интеграции: подписки на события, подключения обмена и выгрузка из LMS.
 *
 * Раздел закрыт правом `integrations.manage`. Публичная демонстрация его не
 * получает ни при какой роли (`demoSessionPermissions`): заведённый вебхук
 * продолжает слать данные на чужой адрес и после того, как посетитель ушёл.
 */

/** Идентификаторы форм: связывают форму на сервере с формой в браузере. */
const FORM_IDS = {
	webhook: 'webhook',
	lms: 'lms-settings',
	delivery: 'delivery-settings',
	exchange: 'exchange-settings'
} as const;

export const load: PageServerLoad = async (event) => {
	const ctx = actorFromEvent(event);

	if (!can(ctx, 'integrations.manage')) {
		error(403, 'Раздел доступен только с правом «Настройка вебхуков и интеграций»');
	}

	const [webhooks, lms, delivery, lmsState, exchange, owners] = await Promise.all([
		listWebhooks(ctx),
		getLmsSettingsView(ctx),
		getDeliverySettings(),
		readLmsState(),
		getExchangeSettingsView(ctx),
		listIntakeOwners()
	]);

	const config = getConfig();

	return {
		webhooks,
		lms,
		lmsState,
		exchange,
		owners,
		// Адрес имитатора показывается только тогда, когда развёртывание его
		// назвало: подсказывать адрес, которого нет, значит врать.
		lmsHint: config.EXCHANGE_LMS_BASE_URL,
		// Адреса и секреты подключений правит не всякий, кто ведёт обмен: они
		// уводят данные на чужой узел (`docs/access-matrix.md`, раздел 5).
		canManageEndpoints: can(ctx, 'integrations.manage_endpoints'),
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
		exchangeForm: await superValidate(
			{
				cmsInstance: exchange.cms.instance,
				cmsStatusUrl: exchange.cms.statusUrl ?? '',
				cmsSecret: null,
				cmsDefaultOwnerUserId: exchange.cms.defaultOwnerUserId,
				lmsInstance: exchange.lms.instance,
				lmsGroupsUrl: exchange.lms.groupsUrl ?? '',
				lmsSecret: null
			},
			zod4(exchangeSettingsFormSchema),
			{ id: FORM_IDS.exchange }
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

		return outcome.ok
			? { message: `Получатель ответил ${outcome.status ?? ''}`.trim(), issues: [], ok: true }
			: fail(502, { message: outcome.error ?? 'Доставка не удалась', issues: [], ok: false });
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

			return state.ok
				? { message: state.message, issues: [], ok: true }
				: fail(502, { message: state.message, issues: [], ok: false });
		} catch (failure) {
			// Сюда доходит только отказ по правам: сбой самой выгрузки возвращается
			// состоянием, а не исключением.
			return toActionFailure(failure);
		}
	},

	exchange: async (event) => {
		const form = await superValidate(event.request, zod4(exchangeSettingsFormSchema), {
			id: FORM_IDS.exchange
		});

		const cmsSecret = form.data.cmsSecret;
		const lmsSecret = form.data.lmsSecret;

		// Секреты не возвращаются в браузер ни при каком исходе: ответ действия
		// перерисовывает форму её же данными, и секрет подписи оказался бы в
		// разметке ответа, хотя на экране его не показывают даже сохранённым.
		form.data.cmsSecret = null;
		form.data.lmsSecret = null;

		if (!form.valid) {
			return fail(400, { form });
		}

		try {
			await setExchangeSettings(actorFromEvent(event), { ...form.data, cmsSecret, lmsSecret });
		} catch (failure) {
			return asFormError(form, failure);
		}

		return message(form, 'Подключения обмена сохранены');
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
