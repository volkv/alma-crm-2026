import { json } from '@sveltejs/kit';
import { sendProgramOfferSchema } from '$lib/contracts/program-offer';
import { actorFromEvent } from '$lib/server/actor';
import { AppError, statusForError, ValidationError } from '$lib/server/errors';
import { readProgramOfferDraft, sendProgramOffer } from '$lib/server/interactions/program-offer';
import type { RequestHandler } from './$types';

/**
 * Письмо «информация о программах» из карточки дела.
 *
 * `GET` — то, что показывает окно письма: получатели без адресов, превью,
 * вложения, политика почты. Читается при каждом открытии окна, а не с
 * карточкой: контакты стороны — персональные данные, и читать их стоит, когда
 * письмо действительно собираются отправить.
 *
 * `POST` — отправка: `{ recipientIds, test }`. Адресов тело не несёт — только
 * роли контактных лиц; адреса к ним сервер подставляет сам. Почтового сервера
 * ответ не ждёт: письма ставятся в очередь и уходят в фоне, а ответ —
 * `ProgramOfferOutcome` (`queued` или `refused`) с кодом 200. Отказ до
 * постановки — словами `{ error, issues }` с тем же кодом, что у действий
 * карточки.
 */
function failure(error: unknown): Response {
	if (error instanceof AppError) {
		return json(
			{ error: error.message, issues: error instanceof ValidationError ? error.issues : [] },
			{ status: statusForError(error) }
		);
	}

	throw error;
}

export const GET: RequestHandler = async (event) => {
	try {
		return json(await readProgramOfferDraft(actorFromEvent(event), event.params.id), {
			// Список получателей — персональные данные: ни браузеру, ни кэшу не хранить.
			headers: { 'Cache-Control': 'no-store' }
		});
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

	// Дело берётся из адреса, а не из тела: адрес проверен сопоставителем.
	const parsed = sendProgramOfferSchema.safeParse({
		...(typeof body === 'object' && body !== null ? body : {}),
		interactionId: event.params.id
	});

	if (!parsed.success) {
		return json(
			{
				error: 'Письмо не прошло проверку',
				issues: parsed.error.issues.map((issue) => issue.message)
			},
			{ status: 400 }
		);
	}

	try {
		return json(await sendProgramOffer(actorFromEvent(event), parsed.data));
	} catch (error) {
		return failure(error);
	}
};
