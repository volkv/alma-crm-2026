import { json } from '@sveltejs/kit';
import { sendDocumentPackageSchema } from '$lib/contracts/document-package-send';
import { actorFromEvent } from '$lib/server/actor';
import { AppError, statusForError, ValidationError } from '$lib/server/errors';
import {
	readPackageSendDraft,
	sendDocumentPackage
} from '$lib/server/interactions/document-package-send';
import type { RequestHandler } from './$types';

/**
 * Пакет документов вузу письмом из карточки дела.
 *
 * `GET` — то, что показывает окно отправки: получатели без адресов, файлы
 * пакета, превью, политика почты. Читается при каждом открытии окна: контакты
 * стороны — персональные данные, а пакет могли пересобрать минуту назад.
 *
 * `POST` — отправка: `{ recipientIds, documentIds, test }`. Адресов тело не
 * несёт — только роли контактных лиц; файлы — идентификаторы документов,
 * сервер сверяет их с текущим пакетом дела. Исход разговора с почтовым
 * сервером — `PackageSendOutcome` с кодом 200; отказ до него — словами
 * `{ error, issues }` с тем же кодом, что у действий карточки.
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
		return json(await readPackageSendDraft(actorFromEvent(event), event.params.id), {
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
	const parsed = sendDocumentPackageSchema.safeParse({
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
		return json(await sendDocumentPackage(actorFromEvent(event), parsed.data));
	} catch (error) {
		return failure(error);
	}
};
