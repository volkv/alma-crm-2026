import { fail, redirect } from '@sveltejs/kit';
import { resolve } from '$app/paths';
import {
	markDayBounds,
	markDocumentStatusSchema,
	markMomentFromDay
} from '$lib/contracts/documents';
import { actorFromEvent } from '$lib/server/actor';
import {
	assertDocumentAccessible,
	listDocumentContractItems,
	listDocumentRevisions,
	selectDocumentRow,
	toDocumentView
} from '$lib/server/documents/read';
import { markDocument } from '$lib/server/documents/status';
import { uploadDocumentRevision } from '$lib/server/documents/upload';
import { toActionFailure, toPageError } from '$lib/server/http';
import { getInteraction } from '$lib/server/interactions/read';
import { can, requirePermission } from '$lib/server/rbac';
import type { Actions, PageServerLoad } from './$types';

/**
 * Карточка документа.
 *
 * Она стоит между списком и скачиванием намеренно. Сам `download` — почти API:
 * он отдаёт файл и ничего не рисует, поэтому отказ по правам или ненайденный
 * документ доезжали до человека голой страницей ошибки, без разделов и меню.
 * Ссылка со списка ведёт сюда, а отсюда — на файл: «нет такого документа» и
 * «он не вашей области» рисует страница внутри оболочки приложения.
 */
export const load: PageServerLoad = async (event) => {
	const ctx = actorFromEvent(event);

	try {
		requirePermission(ctx, 'documents.read');

		const row = await selectDocumentRow(event.params.id);
		await assertDocumentAccessible(ctx, row);

		// Взаимодействие — ссылка с карточки, и звать за ней сервис стоит только
		// тому, кому взаимодействия вообще видны: без права на них ссылка всё
		// равно приведёт к отказу, а карточка документа не про это.
		const [interaction, revisions, contractItems] = await Promise.all([
			row.interactionId !== null && can(ctx, 'interactions.read')
				? getInteraction(ctx, row.interactionId)
				: null,
			listDocumentRevisions(ctx, row.id),
			// Позиции договора, которые передаёт эта редакция: отметка
			// «Утверждён» переводит их в «передан».
			listDocumentContractItems(row.id)
		]);

		return {
			document: toDocumentView(row),
			interaction: interaction === null ? null : { id: interaction.id, title: interaction.title },
			revisions,
			contractItems,
			canWrite: can(ctx, 'documents.write'),
			// Границы дня отметки считает сервер: часы браузера бывают какими
			// угодно, а последнее слово всё равно за сервисом.
			markBounds: markDayBounds(row.createdAt)
		};
	} catch (error) {
		toPageError(error);
	}
};

export const actions: Actions = {
	/**
	 * Отметка по документу: согласован, утверждён, введён в действие.
	 *
	 * День приходит из календаря формы, а момент по нему считает контракт: у
	 * сегодняшнего дня это «сейчас», у прошлого — его начало по Москве. Снять
	 * отметку нельзя, поэтому форма показывает только те факты, которых ещё нет.
	 */
	mark: async (event) => {
		const data = await event.request.formData();
		const at = data.get('at');
		const note = data.get('note');
		const parsed = markDocumentStatusSchema.safeParse({
			documentId: event.params.id,
			fact: data.get('fact'),
			at: typeof at === 'string' && at.trim() !== '' ? at.trim() : null,
			note: typeof note === 'string' ? note : null
		});

		if (!parsed.success) {
			return fail(400, {
				message: 'Отметка не прошла проверку',
				issues: parsed.error.issues.map((issue) => issue.message)
			});
		}

		try {
			await markDocument(
				actorFromEvent(event),
				parsed.data.documentId,
				parsed.data.fact,
				parsed.data.at === null ? undefined : markMomentFromDay(parsed.data.at),
				parsed.data.note
			);
		} catch (error) {
			return toActionFailure(error);
		}

		return { ok: true };
	},

	/**
	 * Новая редакция этого документа. Название, вид и взаимодействие сервис
	 * берёт у заменяемой редакции — форма спрашивает файл и что изменилось.
	 */
	uploadRevision: async (event) => {
		const data = await event.request.formData();
		const file = data.get('file');
		const note = data.get('note');

		if (!(file instanceof File) || file.size === 0) {
			return fail(400, { message: 'Выберите файл новой редакции', issues: [] as string[] });
		}

		const bytes = new Uint8Array(await file.arrayBuffer());
		let created: { id: string };

		try {
			created = await uploadDocumentRevision(actorFromEvent(event), {
				supersedesId: event.params.id,
				file: { mime: file.type, bytes },
				note: typeof note === 'string' ? note : null
			});
		} catch (error) {
			return toActionFailure(error);
		}

		// Переход на карточку новой редакции: дальше работают с ней, а не с той,
		// которую только что заменили.
		redirect(
			303,
			`${resolve('/(app)/documents/[id=uuid]', { id: created.id })}?done=revision_uploaded`
		);
	}
};
