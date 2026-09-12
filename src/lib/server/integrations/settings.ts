/**
 * Настройки интеграций: адрес системы обучения, её токен, периодичность
 * выгрузки и периодичность цикла доставки вебхуков.
 *
 * Хранятся там же, где остальные настройки приложения (`app_settings`), но
 * своим модулем и под своим правом: общий словарь `settingSchemas` описывает
 * правила входа и блокировки, которые читает каждый запрос, а здесь — адрес
 * чужой системы и её токен. Право на это — `integrations.manage`, а не
 * `settings.write`: настраивает интеграции тот, кто отвечает за обмен, и
 * давать ему заодно политику паролей незачем.
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
	INTEGRATION_SETTING_KEYS,
	lmsSettingsSchema,
	type DeliverySettings,
	type LmsSettings,
	type LmsSettingsView
} from '$lib/contracts/integrations';
import type { ActorContext } from '../actor';
import { recordAuditEvent } from '../audit';
import { getDb } from '../db';
import { appSettings } from '../db/schema';
import { withTransaction } from '../db/transaction';
import { ValidationError } from '../errors';
import { requirePermission } from '../rbac';

/** Значения, с которыми интеграции работают, пока их не настроили. */
export const LMS_SETTINGS_DEFAULT: LmsSettings = lmsSettingsSchema.parse({});
export const DELIVERY_SETTINGS_DEFAULT: DeliverySettings = deliverySettingsSchema.parse({});

async function readSetting<TSchema extends z.ZodType>(
	key: string,
	schema: TSchema,
	fallback: z.output<TSchema>
): Promise<z.output<TSchema>> {
	const [row] = await getDb()
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
	await requirePermission(ctx, 'integrations.manage', { type: 'settings.updated' });

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
	await requirePermission(ctx, 'integrations.manage', { type: 'settings.updated' });

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
	await requirePermission(ctx, 'integrations.manage', { type: 'settings.updated' });

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
