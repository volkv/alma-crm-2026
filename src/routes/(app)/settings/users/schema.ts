/**
 * Форма заведения пользователя.
 *
 * Роль здесь — просто непустая строка: каталог ролей живёт на сервере, и
 * проверяет его `createUser`, который всё равно смотрит в базу. Требования к
 * паролю тоже проверяет сервер — они приходят из настройки `password_policy`.
 */
import { z } from 'zod';
import { PASSWORD_MAX_LENGTH } from '$lib/contracts/auth';
import { requiredText } from '$lib/contracts/common';

export const createUserSchema = z.object({
	email: z.email({ error: 'Проверьте адрес электронной почты' }),
	fullName: requiredText(200, 'Укажите имя и фамилию'),
	roleId: z.string({ error: 'Выберите роль' }).min(1, { error: 'Выберите роль' }),
	password: z
		.string({ error: 'Придумайте пароль' })
		.min(1, { error: 'Придумайте пароль' })
		.max(PASSWORD_MAX_LENGTH, { error: `Пароль не длиннее ${PASSWORD_MAX_LENGTH} символов` })
});

export type CreateUserFormInput = z.output<typeof createUserSchema>;
