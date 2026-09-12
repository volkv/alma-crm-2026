/**
 * Сроки жизни сессии — две настройки, но одна форма: менять их по отдельности
 * бессмысленно, потому что вместе они и задают, когда сессия кончится.
 * Схемы взяты из контракта настроек, чтобы границы и тексты ошибок были
 * ровно теми же, что проверит сервер при записи.
 */
import { z } from 'zod';
import { settingSchemas } from '$lib/contracts/settings';

export const sessionLimitsSchema = z.object({
	idleMinutes: settingSchemas.session_idle_minutes,
	absoluteHours: settingSchemas.session_absolute_hours
});

export type SessionLimitsInput = z.output<typeof sessionLimitsSchema>;

/**
 * Политика второго фактора. Отличается от контракта настройки одним полем:
 * доверенные сети человек набирает списком в поле, по одной на строку, а не
 * массивом. Разбор строки и проверку каждой записи настоящим разбором CIDR
 * делает действие формы — там же, где и запись настройки.
 */
export const mfaPolicySchema = z.object({
	requiredForRoles: settingSchemas.mfa_policy.shape.requiredForRoles,
	remoteOnly: settingSchemas.mfa_policy.shape.remoteOnly,
	trustedNetworks: z.string().trim().max(2000, { error: 'Список сетей не длиннее 2000 символов' })
});

export type MfaPolicyInput = z.output<typeof mfaPolicySchema>;

/**
 * Строки поля — в список сетей. Разделителем считается и перевод строки, и
 * запятая: человек набирает сети то столбиком, то через запятую, и ошибкой это
 * не является.
 */
export function splitNetworks(value: string): string[] {
	return value
		.split(/[\n,;]/)
		.map((entry) => entry.trim())
		.filter((entry) => entry !== '');
}
