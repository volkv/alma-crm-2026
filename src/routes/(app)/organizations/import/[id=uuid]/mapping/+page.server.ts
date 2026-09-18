import { redirect } from '@sveltejs/kit';
import { resolve } from '$app/paths';
import {
	CATALOG_FIELDS,
	CATALOG_FIELD_NONE,
	type CatalogField,
	type CatalogMapping
} from '$lib/contracts/directory-import';
import { actorFromEvent } from '$lib/server/actor';
import {
	applyCatalogMapping,
	getCatalogImport,
	getCatalogImportPreview
} from '$lib/server/directory/import';
import { toActionFailure, toPageError } from '$lib/server/http';
import { requirePermission } from '$lib/server/rbac';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const ctx = actorFromEvent(event);

	try {
		// Внутри `try`: отказ по правам обязан стать ответом 403, а не пятисотой.
		requirePermission(ctx, 'directory.import');

		const [record, preview] = await Promise.all([
			getCatalogImport(ctx, event.params.id),
			getCatalogImportPreview(ctx, event.params.id)
		]);

		return { record, preview };
	} catch (error) {
		toPageError(error);
	}
};

/**
 * Сопоставление из формы. Названия колонок приходят из файла, то есть это
 * произвольный текст: имена полей формы из него не собрать, поэтому колонка и
 * поле едут парой списков одинаковой длины и сопоставляются по порядку.
 */
function readMapping(data: FormData): CatalogMapping {
	const columns = data.getAll('column');
	const fields = data.getAll('field');
	const mapping: CatalogMapping = {};

	columns.forEach((column, index) => {
		const field = fields[index];

		if (typeof column !== 'string' || typeof field !== 'string') {
			return;
		}

		if (field === CATALOG_FIELD_NONE || field === '') {
			return;
		}

		if ((CATALOG_FIELDS as readonly string[]).includes(field)) {
			mapping[column] = field as CatalogField;
		}
	});

	return mapping;
}

export const actions: Actions = {
	default: async (event) => {
		try {
			await applyCatalogMapping(
				actorFromEvent(event),
				event.params.id,
				readMapping(await event.request.formData())
			);
		} catch (error) {
			return toActionFailure(error);
		}

		redirect(303, resolve('/(app)/organizations/import/[id=uuid]/check', { id: event.params.id }));
	}
};
