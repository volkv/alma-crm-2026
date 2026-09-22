import { error } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { NotFoundError } from '$lib/server/errors';
import { readWorkflowForWorkspace, readWorkspaceByKey } from '$lib/server/stages/process';
import type { LayoutServerLoad } from './$types';

/**
 * Пространство из адреса — один раз на всю ветку.
 *
 * Ключ в пути, а не в параметре запроса: ссылка на доску без указания места
 * открывалась бы у разных людей по-разному, и именно так и было, пока доска
 * выбирала группу по загруженности. Отсюда же подсветка секции в меню — тем же
 * способом, каким она работает у всех разделов: по префиксу адреса.
 *
 * Незнакомый ключ — 404, а не молчаливый выбор соседнего пространства: человек
 * пришёл по ссылке и обязан узнать, что её адресата больше нет, а не увидеть
 * чужую работу под своим заголовком.
 */
export const load: LayoutServerLoad = async ({ params }) => {
	const db = getDb();

	const workspace = await readWorkspaceByKey(db, params.workspace).catch((cause: unknown) => {
		if (cause instanceof NotFoundError) {
			error(404, 'Пространство не найдено');
		}

		throw cause;
	});

	const workflow = await readWorkflowForWorkspace(db, workspace.id);

	return {
		workspace: {
			id: workspace.id,
			key: workspace.key,
			name: workspace.name,
			/** Процесс назначен: без него работать здесь нечем, и это говорит доска. */
			hasWorkflow: workflow !== null
		}
	};
};
