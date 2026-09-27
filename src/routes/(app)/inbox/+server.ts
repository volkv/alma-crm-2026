import { json } from '@sveltejs/kit';
import { markInboxReadSchema } from '$lib/contracts/inbox';
import { actorFromEvent } from '$lib/server/actor';
import { AppError, statusForError } from '$lib/server/errors';
import { listInbox, markInboxRead } from '$lib/server/inbox';
import type { RequestHandler } from './$types';

/**
 * Колокольчик: `GET` — свои упоминания и новые дела с сайта и число
 * непрочитанных, `POST` — отметить прочитанным.
 *
 * Маршрут внутри оболочки, а не в `/api`: колокольчик — часть страницы, он
 * ходит с сессией того, кто смотрит, и отвечает только о нём самом. Чужих
 * строк здесь не прочитать и не отметить: адресат — всегда тот, кто
 * вошёл.
 */
function failure(error: unknown): Response {
	if (error instanceof AppError) {
		return json({ error: error.message }, { status: statusForError(error) });
	}

	throw error;
}

export const GET: RequestHandler = async (event) => {
	try {
		return json(await listInbox(actorFromEvent(event)));
	} catch (error) {
		return failure(error);
	}
};

export const POST: RequestHandler = async (event) => {
	let body: unknown;

	try {
		body = await event.request.json();
	} catch {
		return json({ error: 'Тело запроса — не JSON' }, { status: 400 });
	}

	const parsed = markInboxReadSchema.safeParse(body);

	if (!parsed.success) {
		return json(
			{ error: parsed.error.issues.map((issue) => issue.message).join('. ') },
			{ status: 400 }
		);
	}

	try {
		return json({ marked: await markInboxRead(actorFromEvent(event), parsed.data) });
	} catch (error) {
		return failure(error);
	}
};
