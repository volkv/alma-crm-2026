import { json } from '@sveltejs/kit';
import { createInteractionContactSchema } from '$lib/contracts/directory';
import { id } from '$lib/contracts/common';
import { contactChannelField } from '$lib/contracts/interactions';
import { actorFromEvent } from '$lib/server/actor';
import { AppError, statusForError, ValidationError } from '$lib/server/errors';
import { createInteractionContact, newContactOptions } from '$lib/server/interactions/contact';
import type { RequestHandler } from './$types';

/**
 * Новый контакт стороны прямо из карточки взаимодействия.
 *
 * `GET ?partyId=` — можно ли заводить людей и какие кандидаты из прочитанного
 * паспорта организации стороны есть: `{ canCreate, candidates }`.
 *
 * `POST` — `{ partyId, editVersion, reason, source, channel }`, где `source` —
 * новый человек с ролью (`{ kind: 'manual', contact }`) или кандидат из
 * паспорта (`{ kind: 'site', candidate: { unit, name } }`), а `channel` —
 * «Как связываться» у его роли. Ответ — `{ affiliationId }`.
 * Отказ — `{ error, issues, fields }`: `fields` раскладывает претензии схемы по
 * полям формы, чтобы ошибка стояла у поля, а ввод оставался в диалоге.
 */
const partyIdSchema = id('Некорректный идентификатор стороны');

/** Канал связи — рядом с источником контакта, а не внутри описания человека. */
const bodySchema = createInteractionContactSchema.extend({ channel: contactChannelField });

function failure(error: unknown): Response {
	if (error instanceof AppError) {
		return json(
			{
				error: error.message,
				issues: error instanceof ValidationError ? error.issues : [],
				fields: {}
			},
			{ status: statusForError(error) }
		);
	}

	throw error;
}

export const GET: RequestHandler = async (event) => {
	const partyId = partyIdSchema.safeParse(event.url.searchParams.get('partyId'));

	if (!partyId.success) {
		return json({ error: 'Не указана сторона взаимодействия' }, { status: 400 });
	}

	try {
		return json(
			await newContactOptions(actorFromEvent(event), {
				interactionId: event.params.id,
				partyId: partyId.data
			})
		);
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

	// Запись берётся из адреса, а не из тела: адрес проверен сопоставителем.
	const parsed = bodySchema.safeParse({
		...(typeof body === 'object' && body !== null ? body : {}),
		interactionId: event.params.id
	});

	if (!parsed.success) {
		const fields: Record<string, string[]> = {};

		for (const issue of parsed.error.issues) {
			const field = issue.path.at(-1);

			if (typeof field === 'string') {
				(fields[field] ??= []).push(issue.message);
			}
		}

		return json(
			{
				error: 'Контакт не прошёл проверку',
				issues: parsed.error.issues.map((issue) => issue.message),
				fields
			},
			{ status: 400 }
		);
	}

	try {
		const { channel, ...input } = parsed.data;

		return json(await createInteractionContact(actorFromEvent(event), input, channel), {
			status: 201
		});
	} catch (error) {
		return failure(error);
	}
};
