import { fail } from '@sveltejs/kit';
import type { z } from 'zod';
import {
	advanceStageSchema,
	interactionListQuerySchema,
	returnStageSchema,
	setResponsibleSchema,
	skipStageSchema,
	type InteractionSort,
	type InteractionViewMode
} from '$lib/contracts/interactions';
import { readTableQuery } from '$lib/components/data-table/query';
import { actorFromEvent } from '$lib/server/actor';
import { toActionFailure } from '$lib/server/http';
import { getInteractionBoard } from '$lib/server/interactions/board';
import { listInteractions } from '$lib/server/interactions/read';
import { can } from '$lib/server/rbac';
import { advanceStage, returnStage, setResponsible, skipStage } from '$lib/server/stages/commands';
import { readFilters } from './filters';
import { responsibleOptions } from './responsible';
import type { Actions, PageServerLoad } from './$types';

/** Колонки, по которым список сортируется на сервере. */
const SORTABLE = new Set(['title', 'dueAt', 'lastActivityAt']);

function toSort(sortBy: string | null, direction: 'asc' | 'desc'): InteractionSort {
	if (sortBy === null || !SORTABLE.has(sortBy)) {
		return '-lastActivityAt';
	}

	return `${direction === 'desc' ? '-' : ''}${sortBy}` as InteractionSort;
}

/**
 * Выбранное представление. Значение из адреса — это ввод человека: непонятное
 * `view=xyz` не ошибка запроса, а просто не доска, и раздел открывается тем же
 * списком, что и адрес без параметра вовсе.
 */
function readView(url: URL): InteractionViewMode {
	return url.searchParams.get('view') === 'board' ? 'board' : 'table';
}

/** Претензии схемы перехода — словами и рядом с действием, а не «не вышло». */
function invalidTransition(error: z.ZodError) {
	return fail(400, {
		message: 'Перевести взаимодействие не удалось',
		issues: error.issues.map((issue) => issue.message)
	});
}

export const load: PageServerLoad = async (event) => {
	const ctx = actorFromEvent(event);
	const table = readTableQuery(event.url);
	const filters = readFilters(event.url);
	const view = readView(event.url);
	const ownerUserId = filters.mine ? (event.locals.user?.id ?? null) : null;

	// Пустой список под фильтром и пустой раздел — разные состояния: в первом
	// случае человеку нужно снять фильтр, во втором — завести первую запись.
	const isFiltered =
		table.search !== '' ||
		filters.status !== null ||
		filters.stageCategory !== null ||
		filters.overdue ||
		filters.mine;

	const common = {
		filters,
		isFiltered,
		search: table.search,
		canAssign: can(ctx, 'interactions.write'),
		/** Право двигать стадии: без него доска только показывает. */
		canTransition: can(ctx, 'stages.transition')
	};

	// Грузится только то, что показано: доска не платит за страницу таблицы, а
	// таблица — за выборку доски.
	if (view === 'board') {
		const board = await getInteractionBoard(ctx, {
			routeId: event.url.searchParams.get('route'),
			status: filters.status,
			stageCategory: filters.stageCategory,
			overdue: filters.overdue,
			ownerUserId,
			q: table.search === '' ? null : table.search
		});

		return { view: 'board' as const, ...common, board };
	}

	const query = interactionListQuerySchema.parse({
		status: filters.status,
		stageCategory: filters.stageCategory,
		overdue: filters.overdue,
		ownerUserId,
		sort: toSort(table.sortBy, table.sortDirection),
		q: table.search,
		page: table.page,
		pageSize: table.size
	});

	const [result, users] = await Promise.all([
		listInteractions(ctx, query),
		responsibleOptions(event)
	]);

	return {
		view: 'table' as const,
		...common,
		rows: result.items,
		total: result.total,
		users
	};
};

export const actions: Actions = {
	assign: async (event) => {
		const data = await event.request.formData();

		const parsed = setResponsibleSchema.safeParse({
			interactionIds: data.getAll('interactionId').map(String),
			userId: data.get('userId')
		});

		if (!parsed.success) {
			return fail(400, {
				message: 'Не удалось назначить ответственного',
				issues: parsed.error.issues.map((issue) => issue.message)
			});
		}

		try {
			return { assigned: await setResponsible(actorFromEvent(event), parsed.data) };
		} catch (error) {
			return toActionFailure(error);
		}
	},

	/**
	 * Переход по стадиям с доски: перетаскиванием карточки или пунктом её меню.
	 *
	 * Вид перехода приходит из описания маршрута, поэтому разбирается схемой
	 * своей команды — у возврата и пропуска причина обязательна, и требование
	 * это не интерфейса, а контракта. Двигают запись те же атомарные команды
	 * движка, что и карточка: прав и готовности перехода доска не решает.
	 */
	transition: async (event) => {
		const data = await event.request.formData();

		const input = {
			interactionId: data.get('interactionId'),
			fromStageId: data.get('fromStageId'),
			toStageId: data.get('toStageId'),
			reason: data.get('reason')
		};

		const kind = data.get('kind');
		const ctx = actorFromEvent(event);

		try {
			if (kind === 'forward') {
				const parsed = advanceStageSchema.safeParse({ ...input, checklistState: {} });

				if (!parsed.success) return invalidTransition(parsed.error);

				await advanceStage(ctx, parsed.data);
			} else if (kind === 'return') {
				const parsed = returnStageSchema.safeParse(input);

				if (!parsed.success) return invalidTransition(parsed.error);

				await returnStage(ctx, parsed.data);
			} else if (kind === 'skip') {
				const parsed = skipStageSchema.safeParse(input);

				if (!parsed.success) return invalidTransition(parsed.error);

				await skipStage(ctx, parsed.data);
			} else {
				return fail(400, {
					message: 'Неизвестный вид перехода',
					issues: ['Переход бывает вперёд, назад или мимо стадии']
				});
			}

			return { moved: true };
		} catch (error) {
			return toActionFailure(error);
		}
	}
};
