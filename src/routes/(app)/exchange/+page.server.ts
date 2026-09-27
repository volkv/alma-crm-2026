import { error, fail } from '@sveltejs/kit';
import {
	dismissMessageSchema,
	exchangeQuerySchema,
	retryMessageSchema
} from '$lib/contracts/exchange';
import { pluralize } from '$lib/format';
import { actorFromEvent } from '$lib/server/actor';
import { getConfig } from '$lib/server/config';
import { toActionFailure } from '$lib/server/http';
import {
	DEMO_APPLICATION_FORMS,
	DEMO_MOCK_SYSTEMS,
	DEMO_OFFLINE_TTL_SECONDS,
	readDemoMocks,
	sendDemoApplication,
	setDemoMockAvailability,
	type DemoApplicationForm,
	type DemoMockSystem
} from '$lib/server/integrations/exchange/demo';
import {
	dismissExchangeMessage,
	listExchangeMessages,
	retryExchangeMessage
} from '$lib/server/integrations/exchange/messages';
import { importPayments, previewPayments } from '$lib/server/integrations/exchange/payments';
import { can } from '$lib/server/rbac';
import type { Actions, PageServerLoad, RequestEvent } from './$types';
import { PERMISSIONS } from '$lib/server/rbac/permissions';

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
		error(403, `Раздел доступен только с правом «${PERMISSIONS['integrations.manage']}»`);
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

	const config = getConfig();

	return {
		messages: await listExchangeMessages(ctx, parsed.data),
		filter: parsed.data,
		// Кнопка «Демо: заявка с сайта» — принадлежность стенда: она жмёт триггер
		// имитатора CMS, которого у установки с настоящей CMS нет.
		demoApplication: config.DEMO_MODE && config.DEMO_CMS_TRIGGER_URL !== null,
		// Демо-переключатель доступности имитаторов — тоже принадлежность
		// стенда; вне DEMO_MODE список пуст.
		demoMocks: await readDemoMocks(ctx),
		demoOfflineMinutes: DEMO_OFFLINE_TTL_SECONDS / 60
	};
};

/** Файл выгрузки оплат из формы; `null` — файла не выбрали. */
async function paymentsFile(
	event: RequestEvent
): Promise<{ name: string; bytes: Uint8Array } | null> {
	const file = (await event.request.formData()).get('file');

	return file instanceof File && file.size > 0
		? { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) }
		: null;
}

/** Итог приёма заявки словами — для сообщения кнопки «Демо: заявка с сайта». */
const DEMO_RESULT_LABELS: Record<string, string> = {
	created: 'заведено новое дело',
	updated: 'дело обновлено',
	unchanged: 'эту редакцию заявки CRM уже приняла, ничего не изменилось'
};

const NO_PAYMENTS_FILE = {
	message: 'Выберите файл выгрузки оплат с сайта',
	issues: [] as string[],
	ok: false
};

export const actions: Actions = {
	/**
	 * Предпросмотр загрузки оплат: что станет с каждой записью файла. Ничего не
	 * пишет — подтверждение присылает тот же файл ещё раз.
	 */
	paymentsPreview: async (event) => {
		const file = await paymentsFile(event);

		if (file === null) {
			return fail(400, NO_PAYMENTS_FILE);
		}

		try {
			const payments = await previewPayments(actorFromEvent(event), file);

			return { message: 'Файл проверен', issues: [] as string[], ok: true, payments };
		} catch (failure) {
			return toActionFailure(failure);
		}
	},

	/**
	 * Загрузка оплат: тот же разбор и та же сверка, что в предпросмотре, но с
	 * записью. Каждая запись — своя транзакция: ошибка одной не роняет файл.
	 */
	paymentsImport: async (event) => {
		const file = await paymentsFile(event);

		if (file === null) {
			return fail(400, NO_PAYMENTS_FILE);
		}

		try {
			const payments = await importPayments(actorFromEvent(event), file);

			return { message: 'Оплаты загружены', issues: [] as string[], ok: true, payments };
		} catch (failure) {
			return toActionFailure(failure);
		}
	},

	/**
	 * Сцена «заявка с сайта» с этого же экрана: приложение просит имитатор CMS
	 * подать заявку, и дальше всё идёт обычным путём — приём по контракту,
	 * взаимодействие, снимок статуса обратно. Право то же, что на раздел.
	 */
	demoApplication: async (event) => {
		const form = (await event.request.formData()).get('form');

		if (!DEMO_APPLICATION_FORMS.includes(form as DemoApplicationForm)) {
			return fail(400, {
				message: 'Не указано, чью заявку подать: вуза (b2b) или физического лица (b2c)',
				issues: [] as string[],
				ok: false
			});
		}

		try {
			const sent = await sendDemoApplication(actorFromEvent(event), form as DemoApplicationForm);
			const outcome =
				sent.result === null ? '' : `, итог — ${DEMO_RESULT_LABELS[sent.result] ?? sent.result}`;

			return {
				message: `Имитатор CMS подал заявку ${sent.externalId}: CRM приняла её (код ${sent.crmStatus}${outcome}). Входящая строка — первая в журнале ниже`,
				issues: [] as string[],
				ok: true,
				interactionId: sent.interactionId
			};
		} catch (failure) {
			return toActionFailure(failure);
		}
	},

	/**
	 * Демо-переключатель «имитатор недоступен / доступен»: показать отказ
	 * доставки и восстановление обмена на стенде (`demo.ts`).
	 */
	mockAvailability: async (event) => {
		const form = await event.request.formData();
		const system = form.get('system');
		const available = form.get('available');

		if (
			!DEMO_MOCK_SYSTEMS.includes(system as DemoMockSystem) ||
			(available !== 'true' && available !== 'false')
		) {
			return fail(400, {
				message: 'Не указано, какой имитатор и в какое состояние переключить',
				issues: [] as string[],
				ok: false
			});
		}

		try {
			await setDemoMockAvailability(
				actorFromEvent(event),
				system as DemoMockSystem,
				available === 'true'
			);
		} catch (failure) {
			return toActionFailure(failure);
		}

		return {
			message:
				available === 'true'
					? 'Имитатор снова доступен: сообщения из очереди уйдут следующим повтором — или нажмите «Повторить» у строки'
					: `Имитатор недоступен: исходящие к нему встанут в очередь повторов с сетевой ошибкой. Через ${pluralize(DEMO_OFFLINE_TTL_SECONDS / 60, ['минуту', 'минуты', 'минут'])} он вернётся сам — имитатор общий для всего стенда`,
			issues: [] as string[],
			ok: true
		};
	},

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

			// Недоставка — исход доставки, а не сбой запроса: страница отвечает
			// обычным ответом с `ok: false`, и журнал ниже перечитывается с новой
			// попыткой. Код 502 здесь значил бы, что сломалась сама CRM.
			return {
				message: outcome.ok
					? 'Сообщение доставлено'
					: `Не доставлено: ${outcome.error ?? 'получатель не принял сообщение'}. Сообщение осталось в очереди повторов`,
				issues: [] as string[],
				ok: outcome.ok
			};
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
