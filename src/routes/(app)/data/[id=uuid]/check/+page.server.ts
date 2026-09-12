import { redirect } from '@sveltejs/kit';
import { resolve } from '$app/paths';
import { actorFromEvent } from '$lib/server/actor';
import { toActionFailure, toPageError } from '$lib/server/http';
import { requirePermission } from '$lib/server/rbac';
import { confirmSnapshot, rejectSnapshot } from '$lib/server/stats/import';
import { getSnapshot, listSnapshotRows, SNAPSHOT_ROWS_PAGE } from '$lib/server/stats/read';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const ctx = actorFromEvent(event);

	requirePermission(ctx, 'stats.import');

	// Фильтр живёт в адресе: список «только с ошибками» — это ссылка, которую
	// отправляют коллеге вместе с вопросом «что тут не так».
	const onlyIssues = event.url.searchParams.get('issues') === '1';

	try {
		const [snapshot, rows] = await Promise.all([
			getSnapshot(ctx, event.params.id),
			listSnapshotRows(ctx, event.params.id, {
				onlyIssues,
				page: 1,
				pageSize: SNAPSHOT_ROWS_PAGE
			})
		]);

		return { snapshot, rows: rows.items, shown: rows.items.length, total: rows.total, onlyIssues };
	} catch (error) {
		toPageError(error);
	}
};

export const actions: Actions = {
	confirm: async (event) => {
		try {
			await confirmSnapshot(actorFromEvent(event), event.params.id);
		} catch (error) {
			return toActionFailure(error);
		}

		redirect(303, resolve('/(app)/data/[id=uuid]', { id: event.params.id }));
	},

	reject: async (event) => {
		const data = await event.request.formData();
		const reason = data.get('reason');

		try {
			await rejectSnapshot(
				actorFromEvent(event),
				event.params.id,
				typeof reason === 'string' ? reason : ''
			);
		} catch (error) {
			return toActionFailure(error);
		}

		redirect(303, resolve('/(app)/data/[id=uuid]', { id: event.params.id }));
	}
};
