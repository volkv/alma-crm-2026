import { redirect } from '@sveltejs/kit';
import { resolve } from '$app/paths';
import {
	STAT_FIELDS,
	STAT_FIELD_NONE,
	type StatField,
	type StatMapping
} from '$lib/contracts/stats';
import { actorFromEvent } from '$lib/server/actor';
import { toActionFailure, toPageError } from '$lib/server/http';
import { requirePermission } from '$lib/server/rbac';
import { applyMapping, validateSnapshot } from '$lib/server/stats/import';
import { getSnapshot, getSnapshotPreview } from '$lib/server/stats/read';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const ctx = actorFromEvent(event);

	// Шаг мастера — часть загрузки, а не чтения: право проверяется до того, как
	// человек разберёт таблицу колонок.
	requirePermission(ctx, 'stats.import');

	try {
		const [snapshot, preview] = await Promise.all([
			getSnapshot(ctx, event.params.id),
			getSnapshotPreview(ctx, event.params.id)
		]);

		return { snapshot, preview };
	} catch (error) {
		toPageError(error);
	}
};

/**
 * Сопоставление из формы. Названия колонок приходят из файла, то есть это
 * произвольный текст: имена полей формы из него не собрать, поэтому колонка и
 * поле едут парой списков одинаковой длины и сопоставляются по порядку.
 */
function readMapping(data: FormData): StatMapping {
	const columns = data.getAll('column');
	const fields = data.getAll('field');
	const mapping: StatMapping = {};

	columns.forEach((column, index) => {
		const field = fields[index];

		if (typeof column !== 'string' || typeof field !== 'string') {
			return;
		}

		if (field === STAT_FIELD_NONE || field === '') {
			return;
		}

		if ((STAT_FIELDS as readonly string[]).includes(field)) {
			mapping[column] = field as StatField;
		}
	});

	return mapping;
}

export const actions: Actions = {
	default: async (event) => {
		const data = await event.request.formData();
		const ctx = actorFromEvent(event);

		try {
			await applyMapping(ctx, event.params.id, readMapping(data));
			// Проверка идёт сразу за сопоставлением: человек нажал «дальше», и
			// следующий шаг обязан показать счётчики, а не предложить нажать ещё раз.
			await validateSnapshot(ctx, event.params.id);
		} catch (error) {
			return toActionFailure(error);
		}

		redirect(303, resolve('/(app)/data/[id=uuid]/check', { id: event.params.id }));
	}
};
