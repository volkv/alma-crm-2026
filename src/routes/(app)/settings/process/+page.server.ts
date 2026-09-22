import { error } from '@sveltejs/kit';
import { actorFromEvent } from '$lib/server/actor';
import { can } from '$lib/server/rbac';
import { listWorkspaces } from '$lib/server/stages/process';
import type { PageServerLoad } from './$types';

/**
 * Процесс: список пространств.
 *
 * Версий процесса на экране нет: в каждом пространстве действует ровно один
 * процесс, и его номер не участвует ни в одном решении. Строка отвечает на два
 * вопроса — сколько стадий в действующем процессе и сколько незавершённых
 * взаимодействий он сейчас ведёт: по второму числу видно, что изменение
 * затронет.
 */
export const load: PageServerLoad = async (event) => {
	const ctx = actorFromEvent(event);

	if (!can(ctx, 'stages.configure')) {
		error(403, 'Раздел доступен только с правом «Настройка маршрутов и стадий»');
	}

	return { workspaces: await listWorkspaces(ctx) };
};
