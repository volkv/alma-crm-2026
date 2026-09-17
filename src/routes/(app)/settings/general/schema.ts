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
