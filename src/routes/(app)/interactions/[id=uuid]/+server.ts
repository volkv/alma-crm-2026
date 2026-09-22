import { error, redirect } from '@sveltejs/kit';
import { actorFromEvent } from '$lib/server/actor';
import { AppError, statusForError } from '$lib/server/errors';
import { getInteraction } from '$lib/server/interactions/read';
import type { RequestHandler } from './$types';

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
 */
export const GET: RequestHandler = async (event) => {
	try {
		const interaction = await getInteraction(actorFromEvent(event), event.params.id);

		redirect(
			307,
			`/w/${encodeURIComponent(interaction.workspaceKey)}/interactions/${interaction.id}`
		);
	} catch (cause) {
		if (cause instanceof AppError) {
			error(statusForError(cause), cause.message);
		}

		throw cause;
	}
};
