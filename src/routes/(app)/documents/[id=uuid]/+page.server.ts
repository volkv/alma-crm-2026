import { actorFromEvent } from '$lib/server/actor';
import {
	assertDocumentAccessible,
	selectDocumentRow,
	toDocumentView
} from '$lib/server/documents/read';
import { toPageError } from '$lib/server/http';
import { getInteraction } from '$lib/server/interactions/read';
import { can, requirePermission } from '$lib/server/rbac';
import type { PageServerLoad } from './$types';

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
		const interaction =
			row.interactionId !== null && can(ctx, 'interactions.read')
				? await getInteraction(ctx, row.interactionId)
				: null;

		return {
			document: toDocumentView(row),
			interaction: interaction === null ? null : { id: interaction.id, title: interaction.title }
		};
	} catch (error) {
		toPageError(error);
	}
};
