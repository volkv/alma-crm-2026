/**
 * Демонстрация поиска реквизитов вуза во внешних источниках.
 *
 * Страница стоит особняком: в меню её нет, из форм справочника её никто не
 * вызывает, в базу она ничего не пишет. Это витрина модуля
 * `$lib/server/enrichment` — одно поле, один ответ, видно, что модуль умеет и
 * чего не умеет. Подключать его к карточке организации будут отдельно, когда
 * станет понятно, в какой момент работы сотруднику нужен черновик.
 *
 * Право спрашивается то же, что на создание организации: поиск существует ради
 * заполнения карточки, и тот, кому карточку заводить нельзя, ищет реквизиты
 * незачем. Плюс каждый запрос стоит подсказки у внешнего поставщика — открывать
 * его всем читающим значит отдать дневной лимит первому же любопытному.
 */
import { fail, message, superValidate } from 'sveltekit-superforms';
import { zod4 } from 'sveltekit-superforms/adapters';
import { organizationLookupSchema, type OrganizationLookupResult } from '$lib/contracts/enrichment';
import { actorFromEvent } from '$lib/server/actor';
import { DadataError, isDadataConfigured } from '$lib/server/enrichment/dadata';
import { lookupOrganization } from '$lib/server/enrichment';
import { NotFoundError } from '$lib/server/errors';
import { toActionFailure, toPageError } from '$lib/server/http';
import { requirePermission } from '$lib/server/rbac';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	try {
		requirePermission(actorFromEvent(event), 'organizations.write');
	} catch (error) {
		toPageError(error);
	}

	return {
		form: await superValidate(zod4(organizationLookupSchema)),
		// Не задан ключ — страница говорит об этом сразу, а не после первого
		// нажатия: искать нечем, и делать вид, что поле работает, незачем.
		configured: isDadataConfigured()
	};
};

export const actions: Actions = {
	default: async (event) => {
		const form = await superValidate(event.request, zod4(organizationLookupSchema));

		if (!form.valid) {
			return fail(400, { form });
		}

		try {
			requirePermission(actorFromEvent(event), 'organizations.write');
		} catch (error) {
			return toActionFailure(error);
		}

		let result: OrganizationLookupResult;

		try {
			result = await lookupOrganization(form.data.query, form.data.website || null);
		} catch (error) {
			// И отказ внешнего справочника, и «ничего не нашлось» — это одна и та же
			// фраза над формой: сотруднику остаётся поправить строку поиска. Всё
			// прочее — сбой приложения, и подменять его сообщением над полем значило
			// бы прятать поломку от того, кто держит стенд.
			if (error instanceof DadataError) {
				return message(form, { text: error.message }, { status: 502 });
			}

			if (error instanceof NotFoundError) {
				return message(form, { text: error.message }, { status: 404 });
			}

			throw error;
		}

		return { form, result };
	}
};
