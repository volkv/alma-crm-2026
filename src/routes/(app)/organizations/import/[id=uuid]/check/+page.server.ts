import { redirect } from '@sveltejs/kit';
import { resolve } from '$app/paths';
import {
	CATALOG_ROWS_PAGE,
	CATALOG_ROW_ACTIONS,
	type CatalogRowAction
} from '$lib/contracts/directory-import';
import { actorFromEvent } from '$lib/server/actor';
import {
	confirmCatalogImport,
	getCatalogImport,
	listCatalogImportRows,
	rejectCatalogImport
} from '$lib/server/directory/import';
import { toActionFailure, toPageError } from '$lib/server/http';
import { requirePermission } from '$lib/server/rbac';
import type { Actions, PageServerLoad } from './$types';

/** Фильтр по действию живёт в адресе: «покажи, что он собрался создать» — ссылка. */
function readAction(url: URL): CatalogRowAction | null {
	const value = url.searchParams.get('action');

	return (CATALOG_ROW_ACTIONS as readonly string[]).includes(value ?? '')
		? (value as CatalogRowAction)
		: null;
}

export const load: PageServerLoad = async (event) => {
	const ctx = actorFromEvent(event);

	const action = readAction(event.url);

	try {
		// Внутри `try`: отказ по правам обязан стать ответом 403, а не пятисотой.
		requirePermission(ctx, 'directory.import');

		const [record, rows] = await Promise.all([
			getCatalogImport(ctx, event.params.id),
			listCatalogImportRows(ctx, event.params.id, {
				action,
				page: 1,
				pageSize: CATALOG_ROWS_PAGE
			})
		]);

		// Решённая загрузка — уже не предпросмотр: «Создать» над применёнными
		// строками (скажем, после «Назад» в браузере) звучало бы как обещание.
		// Итог в прошедшем времени живёт на карточке загрузки. Переадресация
		// не `AppError`, и `toPageError` пропускает её как есть.
		if (record.status === 'confirmed' || record.status === 'rejected') {
			const target = resolve('/(app)/organizations/import/[id=uuid]', { id: event.params.id });

			redirect(303, action === null ? target : `${target}?action=${action}`);
		}

		return { record, rows: rows.items, shown: rows.items.length, total: rows.total, action };
	} catch (error) {
		toPageError(error);
	}
};

export const actions: Actions = {
	confirm: async (event) => {
		try {
			await confirmCatalogImport(actorFromEvent(event), event.params.id);
		} catch (error) {
			return toActionFailure(error);
		}

		redirect(303, resolve('/(app)/organizations/import/[id=uuid]', { id: event.params.id }));
	},

	reject: async (event) => {
		const data = await event.request.formData();
		const reason = data.get('reason');

		try {
			await rejectCatalogImport(
				actorFromEvent(event),
				event.params.id,
				typeof reason === 'string' ? reason : ''
			);
		} catch (error) {
			return toActionFailure(error);
		}

		redirect(303, resolve('/(app)/organizations/import/[id=uuid]', { id: event.params.id }));
	}
};
