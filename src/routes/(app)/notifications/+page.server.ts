import { error, fail } from '@sveltejs/kit';
import { notificationQuerySchema, retryNotificationSchema } from '$lib/contracts/notifications';
import { actorFromEvent } from '$lib/server/actor';
import { toActionFailure } from '$lib/server/http';
import { listNotificationDeliveries, retryNotificationDelivery } from '$lib/server/notifications';
import { can } from '$lib/server/rbac';
import { getSetting } from '$lib/server/settings';
import type { Actions, PageServerLoad } from './$types';

/**
 * Уведомления: журнал доставок напоминаний о зависших взаимодействиях.
 *
 * Фильтр живёт в строке запроса — выборка из журнала это ссылка, её кладут в
 * задачу и отправляют коллеге. Право на раздел — `notifications.read`, и срез
 * руководителя сужается его областью: доставки по тем взаимодействиям, которые
 * он и так видит.
 *
 * Порог и включённые каналы страница показывает, но не правит: они живут в
 * общих настройках под `settings.write` — кто распоряжается стендом, тот и
 * решает, когда система начинает напоминать.
 */
export const load: PageServerLoad = async (event) => {
	const ctx = actorFromEvent(event);

	if (!can(ctx, 'notifications.read')) {
		error(403, 'Раздел доступен только с правом «Просмотр журнала уведомлений»');
	}

	const parsed = notificationQuerySchema.safeParse({
		status: event.url.searchParams.get('status'),
		channel: event.url.searchParams.get('channel'),
		page: event.url.searchParams.get('page') ?? undefined,
		pageSize: event.url.searchParams.get('pageSize') ?? undefined
	});

	if (!parsed.success) {
		// Непонятный параметр не отбрасывается молча: человек видит его в адресе и
		// будет уверен, что выборка сужена.
		error(
			400,
			`Фильтр уведомлений не разобран: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`
		);
	}

	const [deliveries, thresholdDays, licenseWarningDays, channels] = await Promise.all([
		listNotificationDeliveries(ctx, parsed.data),
		getSetting('stuck_threshold_days'),
		getSetting('license_warning_days'),
		getSetting('notification_channels')
	]);

	return {
		deliveries,
		filter: parsed.data,
		thresholdDays,
		licenseWarningDays,
		channels,
		canManage: can(ctx, 'notifications.manage')
	};
};

export const actions: Actions = {
	retry: async (event) => {
		const parsed = retryNotificationSchema.safeParse(
			Object.fromEntries(await event.request.formData())
		);

		if (!parsed.success) {
			return fail(400, {
				message: 'Не указано, какую доставку повторить',
				issues: parsed.error.issues.map((issue) => issue.message),
				ok: false
			});
		}

		try {
			const outcome = await retryNotificationDelivery(
				actorFromEvent(event),
				parsed.data.deliveryId
			);

			return outcome.ok
				? { message: 'Уведомление отправлено', issues: [] as string[], ok: true }
				: fail(502, {
						message: outcome.error ?? 'Отправка не удалась',
						issues: [] as string[],
						ok: false
					});
		} catch (failure) {
			return toActionFailure(failure);
		}
	}
};
