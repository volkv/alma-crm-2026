import { actorFromEvent } from '$lib/server/actor';
import { toPageError } from '$lib/server/http';
import { can } from '$lib/server/rbac';
import { getSnapshot, listSnapshotRows, SNAPSHOT_ROWS_PAGE } from '$lib/server/stats/read';
import type { PageServerLoad } from './$types';

/**
 * Карточка снимка: что загрузили, что из этого разобралось и что попало в
 * показатели. Строки те же, что на шаге проверки, — вопрос «почему это число
 * такое» задают и после подтверждения.
 */
export const load: PageServerLoad = async (event) => {
	const ctx = actorFromEvent(event);
	const onlyIssues = event.url.searchParams.get('issues') === '1';

	try {
		const snapshot = await getSnapshot(ctx, event.params.id);
		const rows = await listSnapshotRows(ctx, event.params.id, {
			onlyIssues,
			page: 1,
			pageSize: SNAPSHOT_ROWS_PAGE
		});

		const supersedes =
			snapshot.supersedesSnapshotId === null
				? null
				: await getSnapshot(ctx, snapshot.supersedesSnapshotId);

		return {
			snapshot,
			supersedes,
			rows: rows.items,
			shown: rows.items.length,
			total: rows.total,
			onlyIssues,
			canImport: can(ctx, 'stats.import')
		};
	} catch (error) {
		toPageError(error);
	}
};
