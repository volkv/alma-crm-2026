/**
 * Настройки приложения: те значения, которые администратор меняет из интерфейса,
 * а не переменными окружения.
 *
 * Здесь описано, что считается допустимым значением каждой настройки. Значения
 * по умолчанию живут на сервере (`$lib/server/settings`), потому что применяются
 * они там же, где читаются из базы.
 */
import { z } from 'zod';

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
	/** Требования к паролю: длина и число классов символов. */
	password_policy: z.object({
		minLength: z
			.number({ error: 'Укажите минимальную длину пароля' })
			.int()
			.min(8, { error: 'Не меньше 8 символов' })
			.max(128),
		minClasses: z
			.number({ error: 'Укажите число классов символов' })
			.int()
			.min(1)
			.max(4, { error: 'Классов символов всего четыре' })
	}),
	/** Блокировка после неудачных входов: сколько попыток и на сколько минут. */
	lockout_policy: z.object({
		attempts: z
			.number({ error: 'Укажите число попыток' })
			.int()
			.min(1)
			.max(20, { error: 'Не больше 20 попыток' }),
		minutes: z
			.number({ error: 'Укажите длительность блокировки в минутах' })
			.int()
			.min(1)
			.max(1440, { error: 'Не больше суток' })
	})
} as const;

export type SettingKey = keyof typeof settingSchemas;
export type SettingValue<TKey extends SettingKey> = z.output<(typeof settingSchemas)[TKey]>;
