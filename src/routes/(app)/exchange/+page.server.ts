import { error, fail } from '@sveltejs/kit';
import {
	dismissMessageSchema,
	exchangeQuerySchema,
	retryMessageSchema
} from '$lib/contracts/exchange';
import { actorFromEvent } from '$lib/server/actor';
import { toActionFailure } from '$lib/server/http';
import {
	dismissExchangeMessage,
	listExchangeMessages,
	retryExchangeMessage
} from '$lib/server/integrations/exchange/messages';
import { can } from '$lib/server/rbac';
import type { Actions, PageServerLoad } from './$types';

/**
 * Внешние системы: журнал обмена в обе стороны.
 *
 * Фильтр живёт в строке запроса: выборка из журнала — это ссылка, её кладут в
 * задачу и отправляют коллеге. Право на раздел — `integrations.manage`, то же,
 * что на остальной обмен: журнал показывают на стенде, а за его границей
 * остаются только адреса и секреты подключений.
 */
export const load: PageServerLoad = async (event) => {
	const ctx = actorFromEvent(event);

	if (!can(ctx, 'integrations.manage')) {
		error(403, 'Раздел доступен только с правом «Настройка вебхуков и интеграций»');
	}

	const parsed = exchangeQuerySchema.safeParse({
		direction: event.url.searchParams.get('direction'),
		system: event.url.searchParams.get('system'),
		state: event.url.searchParams.get('state'),
		q: event.url.searchParams.get('q'),
		page: event.url.searchParams.get('page') ?? undefined,
		pageSize: event.url.searchParams.get('pageSize') ?? undefined
	});

	if (!parsed.success) {
		// Непонятный параметр не отбрасывается молча: человек видит его в адресе и
		// будет уверен, что выборка сужена.
		error(
			400,
			`Фильтр обмена не разобран: ${parsed.error.issues.map((i) => i.message).join('; ')}`
		);
	}

	return {
		messages: await listExchangeMessages(ctx, parsed.data),
		filter: parsed.data
	};
};

export const actions: Actions = {
	retry: async (event) => {
		const parsed = retryMessageSchema.safeParse(Object.fromEntries(await event.request.formData()));

		if (!parsed.success) {
			return fail(400, {
				message: 'Не указано, какое сообщение повторить',
				issues: parsed.error.issues.map((issue) => issue.message),
				ok: false
			});
		}

		try {
			const outcome = await retryExchangeMessage(actorFromEvent(event), parsed.data.messageId);

			return outcome.ok
				? { message: 'Сообщение доставлено', issues: [] as string[], ok: true }
				: fail(502, {
						message: outcome.error ?? 'Доставка не удалась, сообщение осталось в очереди',
						issues: [] as string[],
						ok: false
					});
		} catch (failure) {
			return toActionFailure(failure);
		}
	},

	dismiss: async (event) => {
		const parsed = dismissMessageSchema.safeParse(
			Object.fromEntries(await event.request.formData())
		);

		if (!parsed.success) {
			return fail(400, {
				message: 'Сообщение не помечено разобранным',
				issues: parsed.error.issues.map((issue) => issue.message),
				ok: false
			});
		}

		try {
			await dismissExchangeMessage(actorFromEvent(event), parsed.data);
		} catch (failure) {
			return toActionFailure(failure);
		}

		return { message: 'Сообщение помечено разобранным', issues: [] as string[], ok: true };
	}
};
