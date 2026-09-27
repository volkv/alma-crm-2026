import { json } from '@sveltejs/kit';
import { changeInteractionContactSchema } from '$lib/contracts/interactions';
import { actorFromEvent } from '$lib/server/actor';
import { AppError, statusForError, ValidationError } from '$lib/server/errors';
import { changeInteractionContact } from '$lib/server/interactions/contact';
import type { RequestHandler } from './$types';

/**
 * Смена контактного лица стороны из карточки взаимодействия. Тело —
 * `{ partyId, contactAffiliationId, editVersion, reason }`, ответ без тела.
 *
 * Маршрут лежит внутри оболочки приложения, как подсказки формы: ходит с
 * сессией и правами того, кто открыл карточку. Право, область доступа и
 * версию правки проверяет сервис; отказ приходит словами — `{ error, issues }`
 * — с тем же кодом, что у действий карточки: 404 для чужой записи, 403 без
 * права, 409 для правки поверх чужой.
 */
export const POST: RequestHandler = async (event) => {
	let body: unknown;

	try {
		body = await event.request.json();
	} catch {
		return json({ error: 'Тело запроса — не JSON' }, { status: 400 });
	}

	// Запись берётся из адреса, а не из тела: адрес проверен сопоставителем.
	const parsed = changeInteractionContactSchema.safeParse({
		...(typeof body === 'object' && body !== null ? body : {}),
		interactionId: event.params.id
	});

	if (!parsed.success) {
		return json(
			{
				error: 'Контактное лицо не прошло проверку',
				issues: parsed.error.issues.map((issue) => issue.message)
			},
			{ status: 400 }
		);
	}

	try {
		await changeInteractionContact(actorFromEvent(event), parsed.data);

		return new Response(null, { status: 204 });
	} catch (error) {
		if (error instanceof AppError) {
			return json(
				{
					error: error.message,
					issues: error instanceof ValidationError ? error.issues : []
				},
				{ status: statusForError(error) }
			);
		}

		throw error;
	}
};
