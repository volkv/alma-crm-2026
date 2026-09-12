import { error, type ActionFailure } from '@sveltejs/kit';
import { fail, message, setError, superValidate, type SuperValidated } from 'sveltekit-superforms';
import { zod4 } from 'sveltekit-superforms/adapters';
import { id } from '$lib/contracts/common';
import {
	deliverySettingsSchema,
	lmsSettingsFormSchema,
	webhookFormSchema
} from '$lib/contracts/integrations';
import { actorFromEvent } from '$lib/server/actor';
import { getConfig } from '$lib/server/config';
import { AppError, ForbiddenError } from '$lib/server/errors';
import { errorIssues, toActionFailure, type ActionErrorPayload } from '$lib/server/http';
import { syncLms, readLmsState } from '$lib/server/integrations/lms/sync';
import { sendTestEvent } from '$lib/server/integrations/pump';
import {
	clearLmsToken,
	getDeliverySettings,
	getLmsSettingsView,
	setDeliverySettings,
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
 * Интеграции: подписки на события, обмен с системой обучения и приём заявок.
 *
 * Раздел закрыт правом `integrations.manage`. Публичная демонстрация его не
 * получает ни при какой роли (`demoSessionPermissions`): заведённый вебхук
 * продолжает слать данные на чужой адрес и после того, как посетитель ушёл.
 */

/** Идентификаторы форм: связывают форму на сервере с формой в браузере. */
const FORM_IDS = {
	webhook: 'webhook',
	lms: 'lms-settings',
	delivery: 'delivery-settings'
} as const;

export const load: PageServerLoad = async (event) => {
	const ctx = actorFromEvent(event);

	if (!can(ctx, 'integrations.manage')) {
		error(403, 'Раздел доступен только с правом «Настройка вебхуков и интеграций»');
	}

	const [webhooks, lms, delivery, lmsState] = await Promise.all([
		listWebhooks(ctx),
		getLmsSettingsView(ctx),
		getDeliverySettings(),
		readLmsState()
	]);

	return {
		webhooks,
		lms,
		lmsState,
		// Заглушка LMS видна на экране только тогда, когда она действительно
		// включена: подсказывать адрес, которого нет, значит врать.
		mockLms: getConfig().MOCK_LMS,
		origin: getConfig().ORIGIN,
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
		})
	};
};

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
