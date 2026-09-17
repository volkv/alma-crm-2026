import { error } from '@sveltejs/kit';
import { fail, message, setError, superValidate } from 'sveltekit-superforms';
import { zod4 } from 'sveltekit-superforms/adapters';
import { createApiKeySchema } from '$lib/contracts/api';
import { id } from '$lib/contracts/common';
import { actorFromEvent } from '$lib/server/actor';
import { createApiKey, listApiKeys, revokeApiKey } from '$lib/server/api/keys';
import { listUsers } from '$lib/server/auth/users';
import { AppError, ForbiddenError, ValidationError } from '$lib/server/errors';
import { toActionFailure } from '$lib/server/http';
import { can } from '$lib/server/rbac';
import type { Actions, PageServerLoad } from './$types';

/**
 * Ключи доступа к публичному API.
 *
 * Сам ключ виден один раз — в ответе на выпуск; в базе остаётся только его
 * `sha256`, поэтому потерянный ключ не восстанавливают, а отзывают и выпускают
 * заново. Отозванные остаются в списке: на них ссылается журнал.
 */

/** Сколько владельцев предлагает выбор при выпуске. */
const OWNER_CHOICES = 100;

export const load: PageServerLoad = async (event) => {
	const ctx = actorFromEvent(event);

	if (!can(ctx, 'api_keys.manage')) {
		error(403, 'Раздел доступен только с правом «Управление ключами доступа к API»');
	}

	// Ключ действует правами и областью своего владельца, поэтому владельца
	// выбирают из списка. Списком пользователей распоряжается другое право — без
	// него остаётся один вариант: выпустить ключ на себя.
	//
	// Ключи обмена с CMS и системой обучения выпускаются на машинного субъекта
	// (роль `service`): живого владельца у них нет, а привязка к сотруднику
	// отдала бы чужой системе его права и его область. Такой владелец помечен в
	// списке — иначе выбор между «Внешние системы (обмен)» и человеком выглядит
	// произвольным.
	const owners = can(ctx, 'users.manage')
		? (await listUsers(ctx, { page: 1, pageSize: OWNER_CHOICES })).items
				.filter((user) => user.isActive)
				.map((user) => ({
					id: user.id,
					fullName: user.roleId === 'service' ? `${user.fullName} — только обмен` : user.fullName,
					// Ключу машинного субъекта нужна вторая половина — подключение
					// обмена: форма спрашивает её только у такого владельца.
					isService: user.roleId === 'service'
				}))
		: [{ id: ctx.user?.id ?? '', fullName: ctx.user?.fullName ?? '', isService: false }];

	return {
		keys: await listApiKeys(ctx),
		owners,
		form: await superValidate(zod4(createApiKeySchema))
	};
};

export const actions: Actions = {
	create: async (event) => {
		const form = await superValidate(event.request, zod4(createApiKeySchema));

		if (!form.valid) {
			return fail(400, { form });
		}

		try {
			const created = await createApiKey(actorFromEvent(event), form.data);

			// Единственный раз, когда ключ покидает сервер. Дальше он живёт только
			// у того, кто его забрал.
			return message(form, { name: created.name, key: created.key });
		} catch (failure) {
			// Отказ по правам — не претензия к заполнению: правкой полей он не
			// поправляется. Загрузчик до этого места и не пустит — но форму можно
			// отправить и мимо страницы.
			if (failure instanceof ForbiddenError) {
				return toActionFailure(failure);
			}

			if (failure instanceof AppError) {
				return setError(form, '', [
					failure.message,
					...(failure instanceof ValidationError ? failure.issues : [])
				]);
			}

			throw failure;
		}
	},

	revoke: async (event) => {
		// Идентификатор разбирается схемой, а не проверкой на непустую строку: в
		// базе это `uuid`, и строка «abc» дошла бы до запроса и вернулась ошибкой
		// PostgreSQL — пятисотой на месте обычного «не то прислали».
		const apiKeyId = id('Некорректный идентификатор ключа').safeParse(
			(await event.request.formData()).get('apiKeyId')
		);

		if (!apiKeyId.success) {
			return fail(400, { message: 'Не указано, какой ключ отзывать', issues: [] });
		}

		try {
			await revokeApiKey(actorFromEvent(event), apiKeyId.data);
		} catch (failure) {
			return toActionFailure(failure);
		}

		return { message: 'Ключ отозван: обращения с ним больше не проходят', issues: [] };
	}
};
