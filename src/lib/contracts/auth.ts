/**
 * Вход в систему и пользователи.
 *
 * Схема формы входа одна на браузер и на сервер: сообщение, которое человек
 * видит рядом с полем, и сообщение, по которому сервер отказывает, обязаны
 * совпадать. Требования к паролю здесь не описаны — они приходят из настройки
 * `password_policy` и проверяются на сервере (`$lib/server/auth/password`),
 * потому что администратор меняет их без пересборки приложения.
 */
import { z } from 'zod';

/**
 * Потолок длины пароля. Argon2 считает хеш от входа любой длины, поэтому предел
 * нужен не алгоритму, а серверу: без него один запрос с мегабайтным «паролем»
 * занимает память и время.
 */
export const PASSWORD_MAX_LENGTH = 200;

export const loginSchema = z.object({
	email: z.email({ error: 'Проверьте адрес электронной почты' }),
	password: z
		.string({ error: 'Введите пароль' })
		.min(1, { error: 'Введите пароль' })
		.max(PASSWORD_MAX_LENGTH, { error: `Пароль не длиннее ${PASSWORD_MAX_LENGTH} символов` })
});

export type LoginInput = z.output<typeof loginSchema>;

/** Пользователь в списке управления доступом. Хеш пароля наружу не выходит. */
export type UserView = {
	id: string;
	email: string;
	fullName: string;
	roleId: string;
	roleName: string;
	isActive: boolean;
	isDemo: boolean;
	lastLoginAt: Date | null;
	createdAt: Date;
};

/** Учётная запись публичной демонстрации в том виде, в каком её показывает вход. */
export type DemoAccount = {
	roleId: string;
	roleName: string;
};
