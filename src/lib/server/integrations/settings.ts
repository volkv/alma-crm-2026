/**
 * Настройки интеграций: адрес системы обучения, её токен, периодичность
 * выгрузки и периодичность цикла доставки вебхуков.
 *
 * Хранятся там же, где остальные настройки приложения (`app_settings`), но
 * своим модулем и под своими правами: общий словарь `settingSchemas` описывает
 * правила входа и блокировки, которые читает каждый запрос, а здесь — адрес
 * чужой системы и её токен. `settings.write` тут ни при чём: настраивает
 * интеграции тот, кто отвечает за обмен, и давать ему заодно политику паролей
 * незачем.
 *
 * Прав два, и граница между ними проходит по последствиям. Читать состояние
 * интеграций — `integrations.manage`. Менять то, что уводит данные на чужой
 * узел или переживает сессию, — `integrations.manage_endpoints`: адрес и токен
 * системы обучения, адреса и секреты подключений обмена, периодичность фоновой
 * работы. Именно второго права не получает публичная демонстрация
 * (`demoSessionPermissions`), и потому оно стоит на **записи**, а не на
 * чтении.
 *
 * Правило чтения то же, что у общих настроек: «нет строки» — это нормальное
 * состояние свежей базы и подменяется значением по умолчанию, а непонятное
 * значение роняет запрос. Настройка, которую никто не понял, опаснее
 * отсутствующей.
 */
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import {
	deliverySettingsSchema,
	exchangeSettingsSchema,
	INTEGRATION_SETTING_KEYS,
	lmsSettingsSchema,
	type DeliverySettings,
	type ExchangeSettings,
	type ExchangeSettingsFormInput,
	type ExchangeSettingsView,
	type LmsSettings,
	type LmsSettingsView
} from '$lib/contracts/integrations';
import type { ActorContext } from '../actor';
import { recordAuditEvent } from '../audit';
import { getConfig } from '../config';
import { getDb } from '../db';
import { appSettings } from '../db/schema';
import { withTransaction, type Tx } from '../db/transaction';
import { ValidationError } from '../errors';
import { requirePermission } from '../rbac';
import { outboundTargetIssue } from './outbound';

/** Значения, с которыми интеграции работают, пока их не настроили. */
export const LMS_SETTINGS_DEFAULT: LmsSettings = lmsSettingsSchema.parse({});
export const DELIVERY_SETTINGS_DEFAULT: DeliverySettings = deliverySettingsSchema.parse({});

async function readSetting<TSchema extends z.ZodType>(
	key: string,
	schema: TSchema,
	fallback: z.output<TSchema>,
	executor: Tx | ReturnType<typeof getDb> = getDb()
): Promise<z.output<TSchema>> {
	const [row] = await executor
		.select({ value: appSettings.value })
		.from(appSettings)
		.where(eq(appSettings.key, key))
		.limit(1);

	if (row === undefined) {
		return fallback;
	}

	const result = schema.safeParse(row.value);

	if (!result.success) {
		throw new Error(
			`Настройка «${key}» хранит недопустимое значение: ${result.error.issues
				.map((issue) => issue.message)
				.join('; ')}`
		);
	}

	return result.data;
}

/**
 * Настройки системы обучения вместе с токеном. Только для того кода, который
 * действительно идёт в LMS: на экран токен не выходит ни при каких условиях.
 */
export async function getLmsSettings(): Promise<LmsSettings> {
	return readSetting(INTEGRATION_SETTING_KEYS.lms, lmsSettingsSchema, LMS_SETTINGS_DEFAULT);
}

/** Те же настройки для экрана: вместо токена — знает ли система токен вообще. */
export async function getLmsSettingsView(ctx: ActorContext): Promise<LmsSettingsView> {
	requirePermission(ctx, 'integrations.manage');

	const { token, ...rest } = await getLmsSettings();

	return { ...rest, hasToken: token !== null };
}

export async function getDeliverySettings(): Promise<DeliverySettings> {
	return readSetting(
		INTEGRATION_SETTING_KEYS.delivery,
		deliverySettingsSchema,
		DELIVERY_SETTINGS_DEFAULT
	);
}

/**
 * Запись значения вместе с записью о ней в журнале — одной транзакцией, как и
 * у общих настроек: настройка, поменянная без следа, ничем не отличается от
 * подменённой.
 */
async function writeSetting(ctx: ActorContext, key: string, value: unknown): Promise<void> {
	await withTransaction(ctx, async (tx) => {
		await tx
			.insert(appSettings)
			.values({ key, value, updatedBy: ctx.user?.id ?? null })
			.onConflictDoUpdate({
				target: appSettings.key,
				set: { value, updatedAt: new Date(), updatedBy: ctx.user?.id ?? null }
			});

		// Ключ настройки — не UUID, поэтому он идёт в `changedFields`, а не в
		// `subject`: столбец `subject_id` типизирован как ссылка на запись.
		await recordAuditEvent(
			ctx,
			{ type: 'settings.updated', outcome: 'success', details: { changedFields: [key] } },
			tx
		);
	});
}

/**
 * Запись настроек LMS. Токен, которого не прислали, остаётся прежним: показать
 * сохранённый токен на экране нельзя, и требовать набирать его заново ради
 * смены адреса значило бы заставлять хранить его в переписке.
 */
export async function setLmsSettings(
	ctx: ActorContext,
	input: {
		baseUrl: string | null;
		token: string | null;
		enabled: boolean;
		syncIntervalMinutes: number;
	}
): Promise<LmsSettingsView> {
	// Адрес и токен — это чужой узел и ключ к его данным: смена адреса при
	// сохранённом токене уносит токен туда, куда укажут. Право то же, что у
	// адресов обмена (`docs/access-matrix.md`, раздел 5).
	await requirePermission(ctx, 'integrations.manage_endpoints', { type: 'settings.updated' });

	const current = await getLmsSettings();
	const parsed = lmsSettingsSchema.safeParse({
		baseUrl: input.baseUrl,
		token: input.token ?? current.token,
		enabled: input.enabled,
		syncIntervalMinutes: input.syncIntervalMinutes
	});

	if (!parsed.success) {
		throw new ValidationError(
			'Настройки системы обучения не прошли проверку',
			parsed.error.issues.map((issue) => issue.message)
		);
	}

	// Куда ведёт адрес площадки, схема не знает: разрешать имя в адрес умеет
	// только сервер. По этому адресу уедет токен веб-сервиса, поэтому проверка
	// стоит до записи, а не только перед заходом.
	if (parsed.data.baseUrl !== null) {
		const refusal = await outboundTargetIssue(parsed.data.baseUrl);

		if (refusal !== null) {
			throw new ValidationError('Адрес системы обучения не годится', [refusal]);
		}
	}

	// Выгрузка по таймеру без адреса или без токена не состоится ни разу, а
	// сотрудник увидит включённый выключатель и решит, что она идёт.
	if (parsed.data.enabled && (parsed.data.baseUrl === null || parsed.data.token === null)) {
		throw new ValidationError('Выгрузку по расписанию включать рано', [
			'Сначала укажите адрес системы обучения и токен веб-сервиса'
		]);
	}

	await writeSetting(ctx, INTEGRATION_SETTING_KEYS.lms, parsed.data);

	const { token, ...rest } = parsed.data;

	return { ...rest, hasToken: token !== null };
}

/** Забыть токен: единственный способ убрать его, раз показать его нельзя. */
export async function clearLmsToken(ctx: ActorContext): Promise<LmsSettingsView> {
	await requirePermission(ctx, 'integrations.manage_endpoints', { type: 'settings.updated' });

	const current = await getLmsSettings();
	const next: LmsSettings = { ...current, token: null, enabled: false };

	await writeSetting(ctx, INTEGRATION_SETTING_KEYS.lms, next);

	return {
		baseUrl: next.baseUrl,
		enabled: false,
		syncIntervalMinutes: next.syncIntervalMinutes,
		hasToken: false
	};
}

export async function setDeliverySettings(
	ctx: ActorContext,
	input: DeliverySettings
): Promise<DeliverySettings> {
	// Периодичность фоновой работы переживает сессию: выставленные пять секунд
	// продолжают стучаться в чужие приёмники и после того, как посетитель ушёл.
	await requirePermission(ctx, 'integrations.manage_endpoints', { type: 'settings.updated' });

	const parsed = deliverySettingsSchema.safeParse(input);

	if (!parsed.success) {
		throw new ValidationError(
			'Периодичность доставки не прошла проверку',
			parsed.error.issues.map((issue) => issue.message)
		);
	}

	await writeSetting(ctx, INTEGRATION_SETTING_KEYS.delivery, parsed.data);

	return parsed.data;
}

/* ------------------------------------------------------------------ */
/* Подключения обмена                                                  */
/* ------------------------------------------------------------------ */

/**
 * Значения обмена, с которыми стенд работает, пока их не правили руками.
 *
 * Берутся из окружения: адреса имитаторов и секрет подписи задаёт развёртывание
 * (`docker-compose.yml`), а не сотрудник, — иначе стенд поднимался бы ненастроенным
 * и обмен на нём приходилось бы каждый раз включать через интерфейс. Настройка,
 * записанная в базу, окружение перекрывает целиком: сохранённое человеком
 * сильнее умолчания развёртывания.
 */
export function exchangeSettingsDefault(): ExchangeSettings {
	const config = getConfig();

	return exchangeSettingsSchema.parse({
		cms: {
			instance: config.EXCHANGE_CMS_INSTANCE,
			statusUrl: config.EXCHANGE_CMS_STATUS_URL,
			secret: config.EXCHANGE_SECRET,
			defaultOwnerUserId: null
		},
		lms: {
			instance: config.EXCHANGE_LMS_INSTANCE,
			groupsUrl: config.EXCHANGE_LMS_GROUPS_URL,
			secret: config.EXCHANGE_SECRET
		}
	});
}

/**
 * Настройки обмена вместе с секретами. Только для того кода, который
 * действительно подписывает сообщение или сверяет экземпляр подключения: на
 * экран секрет не выходит ни при каких условиях.
 *
 * `executor` передаёт тот, кто уже открыл транзакцию: строка исходящего
 * сообщения появляется в той же транзакции, что и доменное изменение, и читать
 * адрес другим соединением, пока она открыта, значит занимать второе место в
 * пуле на каждый переход по стадии.
 */
export async function getExchangeSettings(
	executor?: Tx | ReturnType<typeof getDb>
): Promise<ExchangeSettings> {
	return readSetting(
		INTEGRATION_SETTING_KEYS.exchange,
		exchangeSettingsSchema,
		exchangeSettingsDefault(),
		executor
	);
}

function toExchangeView(settings: ExchangeSettings): ExchangeSettingsView {
	return {
		cms: {
			instance: settings.cms.instance,
			statusUrl: settings.cms.statusUrl,
			hasSecret: settings.cms.secret !== null,
			defaultOwnerUserId: settings.cms.defaultOwnerUserId
		},
		lms: {
			instance: settings.lms.instance,
			groupsUrl: settings.lms.groupsUrl,
			hasSecret: settings.lms.secret !== null
		}
	};
}

/**
 * Настройки обмена для экрана. Читает их тот, кто ведёт обмен
 * (`integrations.manage`); менять адреса и секреты может только тот, у кого
 * есть `integrations.manage_endpoints`.
 */
export async function getExchangeSettingsView(ctx: ActorContext): Promise<ExchangeSettingsView> {
	requirePermission(ctx, 'integrations.manage');

	return toExchangeView(await getExchangeSettings());
}

export async function setExchangeSettings(
	ctx: ActorContext,
	input: ExchangeSettingsFormInput
): Promise<ExchangeSettingsView> {
	await requirePermission(ctx, 'integrations.manage_endpoints', { type: 'settings.updated' });

	const current = await getExchangeSettings();
	const parsed = exchangeSettingsSchema.safeParse({
		cms: {
			instance: input.cmsInstance,
			statusUrl: input.cmsStatusUrl === '' ? null : input.cmsStatusUrl,
			// Пустое поле секрета означает «оставить прежний»: показать сохранённый
			// нельзя, и требовать набирать его заново ради смены адреса значило бы
			// заставлять хранить его в переписке.
			secret: input.cmsSecret ?? current.cms.secret,
			defaultOwnerUserId: input.cmsDefaultOwnerUserId
		},
		lms: {
			instance: input.lmsInstance,
			groupsUrl: input.lmsGroupsUrl === '' ? null : input.lmsGroupsUrl,
			secret: input.lmsSecret ?? current.lms.secret
		}
	});

	if (!parsed.success) {
		throw new ValidationError(
			'Настройки обмена не прошли проверку',
			parsed.error.issues.map((issue) => issue.message)
		);
	}

	// Куда ведут адреса подключений, схема не знает. Ключ заявки в адресе
	// карточки на проверку не влияет — на его место встаёт любая строка.
	for (const [address, what] of [
		[parsed.data.cms.statusUrl?.replace('{externalId}', 'x') ?? null, 'карточки заявки'],
		[parsed.data.lms.groupsUrl, 'учебных групп']
	] as const) {
		if (address === null) {
			continue;
		}

		const refusal = await outboundTargetIssue(address);

		if (refusal !== null) {
			throw new ValidationError(`Адрес ${what} не годится`, [refusal]);
		}
	}

	// Адрес без секрета — это исходящее сообщение, которое получатель обязан
	// отвергнуть: подпись у него проверить нечем. Сказать об этом здесь честнее,
	// чем показывать сотруднику настроенный обмен и очередь отказов.
	if (parsed.data.cms.statusUrl !== null && parsed.data.cms.secret === null) {
		throw new ValidationError('Обмен с CMS настроен не до конца', [
			'Укажите секрет подписи: без него получатель отвергнет сообщение как неподписанное'
		]);
	}

	if (parsed.data.lms.groupsUrl !== null && parsed.data.lms.secret === null) {
		throw new ValidationError('Обмен с системой обучения настроен не до конца', [
			'Укажите секрет подписи: без него получатель отвергнет заявку как неподписанную'
		]);
	}

	await writeSetting(ctx, INTEGRATION_SETTING_KEYS.exchange, parsed.data);

	return toExchangeView(parsed.data);
}
