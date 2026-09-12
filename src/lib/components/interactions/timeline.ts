import type { Stage } from '$lib/components/stage-timeline.svelte';
import type { StageProgressItem } from '$lib/contracts/interactions';

/**
 * Лента маршрута в том виде, в каком её принимает `StageTimeline`.
 *
 * Состояние стадии считает сервер (`buildProgress`): интерфейс не решает, что
 * считать просроченным и что пропущенным, — он это показывает. Здесь только
 * перевод имён полей.
 */
export function toTimelineStages(
	progress: readonly StageProgressItem[],
	options: { assignee?: string | null } = {}
): Stage[] {
	return progress.map((item) => ({
		id: item.stageId,
		label: item.name,
		state: item.state,
		deadline: item.dueAt,
		assignee:
			item.state === 'current' || item.state === 'overdue' ? (options.assignee ?? null) : null,
		note: item.note
	}));
}
