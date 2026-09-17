import { error, type ActionFailure } from '@sveltejs/kit';
import { fail } from 'sveltekit-superforms';
import { readTableQuery } from '$lib/components/data-table/query';
import { id } from '$lib/contracts/common';
import { actorFromEvent } from '$lib/server/actor';
import {
	activateUser,
	deactivateUser,
	listManagerOptions,
	listUsers,
	setUserManager,
	unlinkFromDirectory
} from '$lib/server/auth/users';
import { can } from '$lib/server/rbac';
import { toActionFailure, type ActionErrorPayload } from '$lib/server/http';
import type { Actions, PageServerLoad } from './$types';

/**
 * Управление доступом: кто заведён в системе, кому подчиняется и работает ли
 * его вход.
 *
 * Роль отсюда не назначается: её приносит токен каталога учётных записей на
 * каждом входе, и запись, которой роль поменяли бы здесь, вернулась бы к
 * прежней при первом же заходе владельца. Завести запись руками тоже нельзя и
 * не нужно — она появляется сама при первом входе: до него она была бы строкой
 * без `external_subject`, то есть ровно тем, что вход создаст и так.
 *
 * Учётные записи не удаляются, а выключаются: на авторе действия в журнале
 * стоит внешний ключ, и удаление пользователя стёрло бы историю.
 */
export const load: PageServerLoad = async (event) => {
	const ctx = actorFromEvent(event);

	if (!can(ctx, 'users.manage')) {
		error(403, 'Раздел доступен только с правом «Управление пользователями и ролями»');
	}

	const query = readTableQuery(event.url);
	const [page, managerOptions] = await Promise.all([
		listUsers(ctx, { page: query.page, pageSize: query.size, q: query.search }),
		listManagerOptions(ctx)
	]);

	return { users: page, managerOptions };
};

/**
 * Идентификатор учётной записи из тела формы. Разбирается схемой, а не проверкой
 * на непустую строку: в базе это `uuid`, и строка «abc» дошла бы до запроса и
 * вернулась ошибкой PostgreSQL, то есть пятисотой на месте обычного «не то
 * прислали».
 */
function readUserId(
	form: FormData,
	field: string,
	missing: string
): string | ActionFailure<ActionErrorPayload> {
	const parsed = id('Некорректный идентификатор учётной записи').safeParse(form.get(field));

	return parsed.success ? parsed.data : fail(400, { message: missing, issues: [] });
}

export const actions: Actions = {
	deactivate: async (event) => {
		const userId = readUserId(
			await event.request.formData(),
			'userId',
			'Не указано, какую учётную запись выключать'
		);

		if (typeof userId !== 'string') {
			return userId;
		}

		try {
			await deactivateUser(actorFromEvent(event), userId);
		} catch (failure) {
			return toActionFailure(failure);
		}

		return { message: 'Учётная запись выключена, её сессии завершены', issues: [] };
	},

	activate: async (event) => {
		const userId = readUserId(
			await event.request.formData(),
			'userId',
			'Не указано, какую учётную запись включать'
		);

		if (typeof userId !== 'string') {
			return userId;
		}

		try {
			await activateUser(actorFromEvent(event), userId);
		} catch (failure) {
			return toActionFailure(failure);
		}

		return { message: 'Учётная запись включена, вход открыт', issues: [] };
	},

	/**
	 * Отвязать запись от каталога. Нужно после того, как каталог перезавели:
	 * субъект у того же человека стал другим, и вход его не узнаёт.
	 */
	unlink: async (event) => {
		const userId = readUserId(
			await event.request.formData(),
			'userId',
			'Не указано, какую учётную запись отвязывать'
		);

		if (typeof userId !== 'string') {
			return userId;
		}

		try {
			await unlinkFromDirectory(actorFromEvent(event), userId);
		} catch (failure) {
			return toActionFailure(failure);
		}

		return {
			message:
				'Учётная запись отвязана от каталога: следующий вход свяжет её заново по подтверждённой почте',
			issues: []
		};
	},

	/**
	 * Руководитель сотрудника. Пустое значение — «руководителя нет»: это
	 * законное состояние (сам руководитель, администратор), а не незаполненное
	 * поле.
	 */
	manager: async (event) => {
		const form = await event.request.formData();
		const userId = readUserId(form, 'userId', 'Не указано, кому назначается руководитель');

		if (typeof userId !== 'string') {
			return userId;
		}

		const raw = form.get('managerUserId');
		const managerUserId = typeof raw === 'string' && raw !== '' ? raw : null;

		if (managerUserId !== null) {
			const parsed = id('Некорректный идентификатор руководителя').safeParse(managerUserId);

			if (!parsed.success) {
				return fail(400, { message: 'Некорректный идентификатор руководителя', issues: [] });
			}
		}

		try {
			await setUserManager(actorFromEvent(event), { userId, managerUserId });
		} catch (failure) {
			return toActionFailure(failure);
		}

		return {
			message:
				managerUserId === null
					? 'Руководитель снят, сессии затронутых записей завершены'
					: 'Руководитель назначен, сессии затронутых записей завершены',
			issues: []
		};
	}
};
