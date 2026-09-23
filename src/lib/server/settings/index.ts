/**
 * Настройки приложения: чтение с подстановкой значения по умолчанию и запись
 * с проверкой по схеме.
 *
 * Значения по умолчанию живут только здесь. Строки в таблице может не быть —
 * это нормальное состояние свежей базы, — но «нет строки» и «непонятное
 * значение» это разные вещи: первое подменяется умолчанием, второе роняет
 * запрос, потому что настройка безопасности, которую никто не понял, опаснее
 * отсутствующей.
 */
import { eq } from 'drizzle-orm';
import { DEFAULT_RANKING_WEIGHTS } from '$lib/contracts/ranking';
import { settingSchemas, type SettingKey, type SettingValue } from '$lib/contracts/settings';
import type { ActorContext } from '../actor';
import { recordAuditEvent } from '../audit';
import { getDb } from '../db';
import { appSettings } from '../db/schema';
import { withTransaction } from '../db/transaction';
import { ValidationError } from '../errors';
import { requirePermission } from '../rbac';

/** Значения, с которыми система работает, пока администратор не решил иначе. */
export const SETTING_DEFAULTS: { [TKey in SettingKey]: SettingValue<TKey> } = {
	login_banner: {
		title: 'Система контроля взаимодействия с учебными заведениями',
		text: 'Доступ только для сотрудников. Действия в системе записываются в журнал.'
	},
	session_idle_minutes: 30,
	session_absolute_hours: 12,
	stuck_threshold_days: 7,
	// Заглушки выключены: канал, который ничего не отправляет, включают
	// осознанно — чтобы посмотреть, как выглядит доставка, — а не получают в
	// наследство от умолчания.
	notification_channels: { email: true, telegram: false, max: false },
	// Выключен: фоновая работа, стирающая данные, включается руками и на том
	// стенде, где стирать есть что. Час — ночной, чтобы сброс не пришёлся на
	// показ.
	demo_reset_schedule: { enabled: false, hour: 3 },
	ranking_weights: DEFAULT_RANKING_WEIGHTS
};

export async function getSetting<TKey extends SettingKey>(key: TKey): Promise<SettingValue<TKey>> {
	const [row] = await getDb()
		.select({ value: appSettings.value })
		.from(appSettings)
		.where(eq(appSettings.key, key))
		.limit(1);

	if (row === undefined) {
		return SETTING_DEFAULTS[key];
	}

	const result = settingSchemas[key].safeParse(row.value);

	if (!result.success) {
		throw new Error(
			`Настройка «${key}» хранит недопустимое значение: ${result.error.issues
				.map((issue) => issue.message)
				.join('; ')}`
		);
	}

	return result.data as SettingValue<TKey>;
}

export async function setSetting<TKey extends SettingKey>(
	ctx: ActorContext,
	key: TKey,
	value: SettingValue<TKey>
): Promise<SettingValue<TKey>> {
	// Отказ по правам пишется в журнал: настройки — это правила, по которым
	// работает вход и блокировка, и попытка их переписать без права стоит того,
	// чтобы администратор о ней узнал.
	await requirePermission(ctx, 'settings.write', { type: 'settings.updated' });

	const result = settingSchemas[key].safeParse(value);

	if (!result.success) {
		throw new ValidationError(
			`Значение настройки «${key}» не прошло проверку`,
			result.error.issues.map((issue) => issue.message)
		);
	}

	const stored = result.data as SettingValue<TKey>;

	// Значение и запись о нём — одной транзакцией: настройка безопасности,
	// поменянная без следа в журнале, ничем не отличается от подменённой.
	await withTransaction(ctx, async (tx) => {
		await tx
			.insert(appSettings)
			.values({ key, value: stored, updatedBy: ctx.user?.id ?? null })
			.onConflictDoUpdate({
				target: appSettings.key,
				set: { value: stored, updatedAt: new Date(), updatedBy: ctx.user?.id ?? null }
			});

		// Ключ настройки — не UUID, поэтому он попадает в `changedFields`, а не в
		// `subject`: столбец `subject_id` типизирован как ссылка на запись.
		await recordAuditEvent(
			ctx,
			{ type: 'settings.updated', outcome: 'success', details: { changedFields: [key] } },
			tx
		);
	});

	return stored;
}
