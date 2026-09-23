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
 * Наблюдатель зависших взаимодействий: порог и каналы одной формой.
 *
 * Вместе, а не по отдельности, потому что вместе они и задают правило: порог
 * без единого включённого канала — это правило, о срабатывании которого никто
 * не узнает, и сохранять его отдельной кнопкой значило бы делать вид, что это
 * две разные настройки.
 *
 * Выключатели каналов подаются плоскими полями: форма уходит обычным POST, а в
 * теле формы вложенного объекта нет. Собирает их обратно в настройку действие
 * страницы.
 */
export const stuckWatchSchema = z.object({
	thresholdDays: settingSchemas.stuck_threshold_days,
	email: z.boolean().default(false),
	telegram: z.boolean().default(false),
	max: z.boolean().default(false)
});

export type StuckWatchInput = z.output<typeof stuckWatchSchema>;

/**
 * Сброс демонстрационных данных по расписанию: выключатель и час суток.
 *
 * Поля плоские по той же причине, что и у наблюдателя: форма уходит обычным
 * POST, а в теле формы вложенного объекта нет. Собирает их обратно в настройку
 * действие страницы.
 */
export const demoScheduleSchema = z.object({
	enabled: z.boolean().default(false),
	hour: settingSchemas.demo_reset_schedule.shape.hour
});

export type DemoScheduleInput = z.output<typeof demoScheduleSchema>;

/**
 * Внешние источники паспорта организации: выключатель и суточная квота на
 * сотрудника. Поля плоские — форма уходит обычным POST.
 */
export const enrichmentSchema = z.object({
	enabled: z.boolean().default(false),
	dailyQuota: settingSchemas.enrichment.shape.dailyQuota
});

export type EnrichmentInput = z.output<typeof enrichmentSchema>;
