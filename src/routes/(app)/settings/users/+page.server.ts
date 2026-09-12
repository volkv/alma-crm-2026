import { error, type ActionFailure } from '@sveltejs/kit';
import { fail, message, setError, superValidate } from 'sveltekit-superforms';
import { zod4 } from 'sveltekit-superforms/adapters';
import { readTableQuery } from '$lib/components/data-table/query';
import { id } from '$lib/contracts/common';
import { actorFromEvent } from '$lib/server/actor';
import { mfaEnabledFor, resetMfa } from '$lib/server/auth/mfa';
import { activateUser, createUser, deactivateUser, listUsers } from '$lib/server/auth/users';
import { AppError, ConflictError, ForbiddenError, ValidationError } from '$lib/server/errors';
import { DEFAULT_ROLES } from '$lib/server/rbac/permissions';
import { can } from '$lib/server/rbac';
import { toActionFailure, type ActionErrorPayload } from '$lib/server/http';
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
	const page = await listUsers(ctx, { page: query.page, pageSize: query.size, q: query.search });

	// Состояние второго фактора приходит отдельным запросом: список штата
	// собирает модуль пользователей, а про фактор знает модуль MFA — и знает он
	// это по той же строке, но спрашивают их порознь.
	const withFactor = await mfaEnabledFor(page.items.map((user) => user.id));

	return {
		users: {
			...page,
			items: page.items.map((user) => ({ ...user, mfaEnabled: withFactor.has(user.id) }))
		},
		roles: DEFAULT_ROLES.map((role) => ({ id: role.id, name: role.name })),
		policy: await getSetting('password_policy'),
		form: await superValidate(zod4(createUserSchema))
	};
};

/**
 * Идентификатор учётной записи из тела формы. Разбирается схемой, а не проверкой
 * на непустую строку: в базе это `uuid`, и строка «abc» дошла бы до запроса и
 * вернулась ошибкой PostgreSQL, то есть пятисотой на месте обычного «не то
 * прислали».
 */
function readUserId(form: FormData, missing: string): string | ActionFailure<ActionErrorPayload> {
	const parsed = id('Некорректный идентификатор учётной записи').safeParse(form.get('userId'));

	return parsed.success ? parsed.data : fail(400, { message: missing, issues: [] });
}

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
		const userId = readUserId(
			await event.request.formData(),
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
	 * Сброс второго фактора: телефон потерян, приложение стёрто, резервные коды
	 * кончились. Администратор снимает фактор, и при следующем входе человек
	 * регистрирует его заново — если политика этого требует.
	 */
	resetMfa: async (event) => {
		const userId = readUserId(
			await event.request.formData(),
			'Не указано, у какой учётной записи сбрасывать фактор'
		);

		if (typeof userId !== 'string') {
			return userId;
		}

		try {
			await resetMfa(actorFromEvent(event), userId);
		} catch (failure) {
			return toActionFailure(failure);
		}

		return {
			message: 'Второй фактор сброшен, сессии этой учётной записи завершены',
			issues: []
		};
	}
};
