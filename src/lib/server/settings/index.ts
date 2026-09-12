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
	password_policy: { minLength: 12, minClasses: 3 },
	lockout_policy: { attempts: 5, minutes: 15 }
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
