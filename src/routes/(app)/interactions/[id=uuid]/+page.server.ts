import { redirect } from '@sveltejs/kit';
import { resolve } from '$app/paths';
import { actorFromEvent } from '$lib/server/actor';
import { toPageError } from '$lib/server/http';
import { getInteraction } from '$lib/server/interactions/read';
import type { PageServerLoad } from './$types';

/**
 * Прежний адрес карточки — перенаправление на неё же внутри её пространства.
 *
 * Карточка живёт в пространстве и открывается его адресом, но ссылок вида
 * `/interactions/<id>` разослано письмами, задачами и перепиской столько, что
 * оставить их без ответа нельзя. Пространство берётся из самой записи: у
 * взаимодействия оно одно и не меняется.
 *
 * Видимость проверяется здесь же, а не после перехода: перенаправление на
 * чужую запись назвало бы пространство, в котором она лежит, ещё до отказа.
 * Чужая запись и несуществующая отвечают одним и тем же 404. Отказ идёт через
 * `load` страницы, а не через обработчик запроса, чтобы его нарисовала
 * страница ошибки приложения в его оболочке.
 */
export const load: PageServerLoad = async (event) => {
	const interaction = await getInteraction(actorFromEvent(event), event.params.id).catch(
		toPageError
	);

	redirect(
		307,
		resolve('/(app)/w/[workspace]/interactions/[id=uuid]', {
			workspace: interaction.workspaceKey,
			id: interaction.id
		})
	);
};
