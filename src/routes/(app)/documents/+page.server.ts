import { readTableQuery } from '$lib/components/data-table/query';
import { documentListQuerySchema } from '$lib/contracts/documents';
import { actorFromEvent } from '$lib/server/actor';
import { listDocuments } from '$lib/server/documents/read';
import { toPageError } from '$lib/server/http';
import type { PageServerLoad } from './$types';

/**
 * Список документов. Страница, сортировка, поиск и все три фильтра живут в
 * строке запроса — значит, отфильтрованный список это ссылка, а сервер отдаёт
 * ровно одну страницу строк и общее их число.
 */
export const load: PageServerLoad = async (event) => {
	const table = readTableQuery(event.url);
	const query = documentListQuerySchema.parse({
		kind: event.url.searchParams.get('kind') ?? undefined,
		format: event.url.searchParams.get('format') ?? undefined,
		fact: event.url.searchParams.get('fact') ?? undefined,
		// Пустой параметр — это «только действующие»: заменённая редакция
		// остаётся в базе навсегда, и без отбора раздел показывал бы историю.
		revisions: event.url.searchParams.get('revisions') ?? undefined,
		q: table.search,
		sortBy: table.sortBy ?? undefined,
		// Раздел открывается свежими документами: пока колонку не выбрали, это
		// дата по убыванию, а не первая колонка по алфавиту.
		sortDirection: table.sortBy === null ? 'desc' : table.sortDirection,
		page: table.page,
		pageSize: table.size
	});

	const ctx = actorFromEvent(event);

	try {
		const result = await listDocuments(ctx, query);

		return {
			rows: result.items,
			total: result.total,
			// Пустой список под фильтром и пустой раздел — разные состояния: в
			// первом случае надо снять фильтр, во втором — завести первый документ
			// в карточке взаимодействия.
			filtered:
				query.kind !== null ||
				query.format !== null ||
				query.fact !== null ||
				query.revisions !== 'current' ||
				query.q !== null
		};
	} catch (error) {
		toPageError(error);
	}
};
