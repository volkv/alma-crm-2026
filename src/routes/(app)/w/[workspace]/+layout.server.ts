import { error } from '@sveltejs/kit';
import { actorFromEvent } from '$lib/server/actor';
import { getDb } from '$lib/server/db';
import { NotFoundError } from '$lib/server/errors';
import { readActiveModules } from '$lib/server/platform/workspace-modules';
import { canEnterWorkspace } from '$lib/server/rbac';
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
 *
 * Пространство, в которое сотрудник не включён, отвечает тем же 404 и тем же
 * текстом, что и несуществующее: 403 подтвердил бы, что направление есть, и
 * назвал бы его. Это раскладка, а не защита, — данные сужают сервисы
 * (`interactionScopeFilter`), и действие формы, которое загрузчик не проходит,
 * упирается в них же.
 */
export const load: LayoutServerLoad = async (event) => {
	const { params } = event;
	const db = getDb();

	const workspace = await readWorkspaceByKey(db, params.workspace).catch((cause: unknown) => {
		if (cause instanceof NotFoundError) {
			error(404, 'Пространство не найдено');
		}

		throw cause;
	});

	if (!canEnterWorkspace(actorFromEvent(event), workspace.id)) {
		error(404, 'Пространство не найдено');
	}

	const [workflow, modules] = await Promise.all([
		readWorkflowForWorkspace(db, workspace.id),
		readActiveModules(workspace.id)
	]);

	return {
		workspace: {
			id: workspace.id,
			key: workspace.key,
			name: workspace.name,
			/** Процесс назначен: без него работать здесь нечем, и это говорит доска. */
			hasWorkflow: workflow !== null,
			/**
			 * Действующие модули: включённые и нужные стадиям процесса. Страницы
			 * модулей ветки проверяют по ним, подключён ли модуль.
			 */
			modules: modules.active
		}
	};
};
