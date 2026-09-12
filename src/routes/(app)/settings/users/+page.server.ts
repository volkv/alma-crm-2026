import { error } from '@sveltejs/kit';
import { fail, message, setError, superValidate } from 'sveltekit-superforms';
import { zod4 } from 'sveltekit-superforms/adapters';
import { readTableQuery } from '$lib/components/data-table/query';
import { actorFromEvent } from '$lib/server/actor';
import { activateUser, createUser, deactivateUser, listUsers } from '$lib/server/auth/users';
import { AppError, ConflictError, ForbiddenError, ValidationError } from '$lib/server/errors';
import { DEFAULT_ROLES } from '$lib/server/rbac/permissions';
import { can } from '$lib/server/rbac';
import { toActionFailure } from '$lib/server/http';
import { getSetting } from '$lib/server/settings';
import { createUserSchema } from './schema';
import type { Actions, PageServerLoad } from './$types';

/**
 * Управление доступом: кто заведён в системе и с какой ролью.
 *
 * Пароль нового сотрудника задаёт администратор и передаёт его лично —
 * приглашения по почте в системе нет, а хранить пароль где-то ещё, кроме хеша,
 * негде. Учётные записи не удаляются, а выключаются: на авторе действия в
 * журнале стоит внешний ключ, и удаление пользователя стёрло бы историю.
 */
export const load: PageServerLoad = async (event) => {
	const ctx = actorFromEvent(event);

	if (!can(ctx, 'users.manage')) {
		error(403, 'Раздел доступен только с правом «Управление пользователями и ролями»');
	}

	const query = readTableQuery(event.url);

	return {
		users: await listUsers(ctx, { page: query.page, pageSize: query.size, q: query.search }),
		roles: DEFAULT_ROLES.map((role) => ({ id: role.id, name: role.name })),
		policy: await getSetting('password_policy'),
		form: await superValidate(zod4(createUserSchema))
	};
};

export const actions: Actions = {
	create: async (event) => {
		const form = await superValidate(event.request, zod4(createUserSchema));
		const password = form.data.password;

		// Пароль не возвращается в браузер: форма перерисовывается без него.
		form.data.password = '';

		if (!form.valid) {
			return fail(400, { form });
		}

		try {
			const created = await createUser(actorFromEvent(event), {
				email: form.data.email,
				fullName: form.data.fullName,
				roleId: form.data.roleId,
				password
			});

			return message(form, `Пользователь ${created.fullName} заведён`);
		} catch (failure) {
			if (failure instanceof ConflictError) {
				return setError(form, 'email', failure.message);
			}

			// Отказ по правам — не претензия к заполнению: он не поправляется
			// правкой полей, и отвечать на него ошибкой формы значило бы обещать
			// обратное. Загрузчик до этого места и не пустит — но форму можно
			// отправить и мимо страницы.
			if (failure instanceof ForbiddenError) {
				return toActionFailure(failure);
			}

			// Претензии к паролю приходят из политики, а не из схемы формы: их
			// знает только сервер. Предметная ошибка не говорит, какого поля
			// касается, поэтому показываются они над формой целиком — угадывать
			// поле по тексту сообщения значит сломаться на первой же правке текста.
			if (failure instanceof AppError) {
				return setError(form, '', [
					failure.message,
					...(failure instanceof ValidationError ? failure.issues : [])
				]);
			}

			throw failure;
		}
	},

	deactivate: async (event) => {
		const userId = (await event.request.formData()).get('userId');

		if (typeof userId !== 'string' || userId === '') {
			return fail(400, { message: 'Не указано, какую учётную запись выключать', issues: [] });
		}

		try {
			await deactivateUser(actorFromEvent(event), userId);
		} catch (failure) {
			return toActionFailure(failure);
		}

		return { message: 'Учётная запись выключена, её сессии завершены', issues: [] };
	},

	activate: async (event) => {
		const userId = (await event.request.formData()).get('userId');

		if (typeof userId !== 'string' || userId === '') {
			return fail(400, { message: 'Не указано, какую учётную запись включать', issues: [] });
		}

		try {
			await activateUser(actorFromEvent(event), userId);
		} catch (failure) {
			return toActionFailure(failure);
		}

		return { message: 'Учётная запись включена, вход открыт', issues: [] };
	}
};
