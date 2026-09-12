/**
 * Форма смены пароля.
 *
 * Требований к самому паролю здесь нет: длина и число классов символов приходят
 * из настройки `password_policy` и проверяются на сервере — администратор
 * меняет их без пересборки приложения. Схема отвечает за другое: что все три
 * поля заполнены и что новый пароль набран дважды одинаково.
 */
import { z } from 'zod';
import { PASSWORD_MAX_LENGTH } from '$lib/contracts/auth';

function password(error: string) {
	return z
		.string({ error })
		.min(1, { error })
		.max(PASSWORD_MAX_LENGTH, {
			error: `Пароль не длиннее ${PASSWORD_MAX_LENGTH} символов`
		});
}

export const changePasswordSchema = z
	.object({
		current: password('Введите текущий пароль'),
		next: password('Придумайте новый пароль'),
		repeat: password('Повторите новый пароль')
	})
	.refine((data) => data.next === data.repeat, {
		error: 'Пароли не совпадают',
		path: ['repeat']
	});

export type ChangePasswordInput = z.output<typeof changePasswordSchema>;
