import { fail, redirect } from '@sveltejs/kit';
import { resolve } from '$app/paths';
import { CATALOG_FILE_FORMATS_HINT } from '$lib/contracts/directory-import';
import { actorFromEvent } from '$lib/server/actor';
import { createCatalogImport, listCatalogImports } from '$lib/server/directory/import';
import { toActionFailure, toPageError } from '$lib/server/http';
import { requirePermission } from '$lib/server/rbac';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const ctx = actorFromEvent(event);

	try {
		// Право проверяется и здесь, и в сервисе: страница, которая рисует форму и
		// отказывает только на отправке, тратит время человека впустую. Проверка
		// стоит внутри `try`, потому что отказ обязан стать ответом 403, а не
		// пятисотой: отказ по правам — это ответ, а не сбой.
		requirePermission(ctx, 'directory.import');

		return { imports: await listCatalogImports(ctx) };
	} catch (error) {
		toPageError(error);
	}
};

export const actions: Actions = {
	default: async (event) => {
		const data = await event.request.formData();
		const note = data.get('note');
		const values = { note: typeof note === 'string' ? note.trim() : '' };
		const file = data.get('file');

		if (!(file instanceof File) || file.size === 0) {
			return fail(400, {
				message: 'Выберите файл каталога',
				issues: [CATALOG_FILE_FORMATS_HINT],
				values
			});
		}

		let importId: string;

		try {
			const created = await createCatalogImport(actorFromEvent(event), {
				note: values.note === '' ? null : values.note,
				file: { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) }
			});

			importId = created.id;
		} catch (error) {
			const failure = toActionFailure(error);

			// Значения возвращаются вместе с отказом: набирать примечание заново
			// из-за неподходящего файла — это наказание за попытку.
			return fail(failure.status, { ...failure.data, values });
		}

		redirect(303, resolve('/(app)/organizations/import/[id=uuid]/mapping', { id: importId }));
	}
};
