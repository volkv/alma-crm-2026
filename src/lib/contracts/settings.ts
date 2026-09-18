/**
 * Настройки приложения: те значения, которые администратор меняет из интерфейса,
 * а не переменными окружения.
 *
 * Здесь описано, что считается допустимым значением каждой настройки. Значения
 * по умолчанию живут на сервере (`$lib/server/settings`), потому что применяются
 * они там же, где читаются из базы.
 */
import { z } from 'zod';
import { notificationChannelsSchema } from './notifications';

export const settingSchemas = {
	/** Текст на странице входа: предупреждение о доступе, контакты поддержки. */
	login_banner: z.object({
		title: z.string().trim().min(1, { error: 'Заголовок не может быть пустым' }).max(200),
		text: z.string().trim().max(2000, { error: 'Текст не длиннее 2000 символов' })
	}),
	/** Через сколько минут бездействия сессия заканчивается. */
	session_idle_minutes: z
		.number({ error: 'Укажите число минут' })
		.int()
		.min(5, { error: 'Не меньше 5 минут' })
		.max(240, { error: 'Не больше 240 минут' }),
	/** Предельный срок жизни сессии независимо от активности. */
	session_absolute_hours: z
		.number({ error: 'Укажите число часов' })
		.int()
		.min(1, { error: 'Не меньше часа' })
		.max(72, { error: 'Не больше 72 часов' }),
	/**
	 * Сколько дней открытая запись стадии может стоять, прежде чем система
	 * напомнит о ней руководителю ответственного. Часы считаются без пауз:
	 * ждать ответа вуза и стоять — разные вещи.
	 *
	 * Ноль допустим и означает «напоминать сразу»: так стенд показывает
	 * эскалацию, не дожидаясь недели. Повтор при этом всё равно не чаще раза в
	 * сутки — см. `$lib/server/notifications/schedule`.
	 */
	stuck_threshold_days: z
		.number({ error: 'Укажите число дней' })
		.int()
		.min(0, { error: 'Не меньше нуля' })
		.max(365, { error: 'Не больше 365 дней' }),
	/** Какими каналами уходит напоминание о зависшем взаимодействии. */
	notification_channels: notificationChannelsSchema
} as const;

export type SettingKey = keyof typeof settingSchemas;
export type SettingValue<TKey extends SettingKey> = z.output<(typeof settingSchemas)[TKey]>;
