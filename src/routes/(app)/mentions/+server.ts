import { json } from '@sveltejs/kit';
import { markMentionsReadSchema } from '$lib/contracts/mentions';
import { actorFromEvent } from '$lib/server/actor';
import { AppError, statusForError } from '$lib/server/errors';
import { listMentionInbox, markMentionsRead } from '$lib/server/mentions';
import type { RequestHandler } from './$types';

/**
 * Колокольчик упоминаний: `GET` — свои упоминания и число непрочитанных,
 * `POST` — отметить прочитанным.
 *
 * Маршрут внутри оболочки, а не в `/api`: колокольчик — часть страницы, он
 * ходит с сессией того, кто смотрит, и отвечает только о нём самом. Чужих
 * упоминаний здесь не прочитать и не отметить: адресат — всегда тот, кто
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
		return json(await listMentionInbox(actorFromEvent(event)));
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

	const parsed = markMentionsReadSchema.safeParse(body);

	if (!parsed.success) {
		return json(
			{ error: parsed.error.issues.map((issue) => issue.message).join('. ') },
			{ status: 400 }
		);
	}

	try {
		return json({ marked: await markMentionsRead(actorFromEvent(event), parsed.data) });
	} catch (error) {
		return failure(error);
	}
};
