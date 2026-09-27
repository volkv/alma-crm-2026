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
import { listInteractions, readInteractionFilterOptions } from '$lib/server/interactions/read';
import { can } from '$lib/server/rbac';
import { advanceStage, returnStage, setResponsible, skipStage } from '$lib/server/stages/commands';
import { readFilters } from './filters';
import { responsibleOptions } from './responsible';
import { chooseView, VIEW_COOKIE } from './view-preference';
import type { Actions, PageServerLoad, RequestEvent } from './$types';

/** Колонки, по которым список сортируется на сервере. */
const SORTABLE = new Set(['title', 'dueAt', 'lastActivityAt']);

/**
 * Порядок по умолчанию — по сроку текущей стадии, от самого горящего.
 *
 * Список открывают, чтобы решить, за что браться сегодня, и тот же вопрос по
 * той же логике решает «Сводка»: сначала просроченные. Пустой срок
 * (`nulls last`) уходит в конец — завершённым и не начатым торопиться некуда.
 */
const DEFAULT_SORT: InteractionSort = 'dueAt';

function toSort(sortBy: string | null, direction: 'asc' | 'desc'): InteractionSort {
	if (sortBy === null || !SORTABLE.has(sortBy)) {
		return DEFAULT_SORT;
	}

	return `${direction === 'desc' ? '-' : ''}${sortBy}` as InteractionSort;
}

/**
 * Выбранное представление: адрес, иначе кука прошлого выбора, иначе доска —
 * правило целиком в `chooseView` (`view-preference.ts`).
 */
function readView(
	event: Pick<RequestEvent, 'url' | 'cookies'>,
	hasWorkflow: boolean
): { view: InteractionViewMode; remember: boolean } {
	return chooseView({
		requested: event.url.searchParams.get('view'),
		stored: event.cookies.get(VIEW_COOKIE),
		hasWorkflow
	});
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
	// Пространство приходит из адреса: его разобрал и проверил загрузчик ветки
	// (`/w/[workspace]/+layout.server.ts`), и незнакомый ключ до сюда не доходит.
	const { workspace } = await event.parent();
	const { view, remember: rememberView } = readView(event, workspace.hasWorkflow);
	// На доске колонки и есть стадии: фильтра стадии там нет, и параметр,
	// оставшийся в адресе от таблицы, не должен прятать колонки без объяснения.
	const stageCategory = view === 'board' ? null : filters.stageCategory;

	// Пустой список под фильтром и пустой раздел — разные состояния: в первом
	// случае человеку нужно снять фильтр, во втором — завести первую запись.
	const isFiltered =
		table.search !== '' ||
		filters.status !== null ||
		stageCategory !== null ||
		filters.overdue ||
		filters.org.length > 0 ||
		filters.dir.length > 0 ||
		filters.prog.length > 0 ||
		filters.prod.length > 0 ||
		filters.owner.length > 0;

	const common = {
		filters,
		isFiltered,
		search: table.search,
		/** Показанное представление — выбор человека, а не вынужденное умолчание. */
		rememberView,
		canAssign: can(ctx, 'interactions.reassign'),
		/** Право двигать стадии: без него доска только показывает. */
		canTransition: can(ctx, 'stages.transition')
	};

	// Грузится только то, что показано: доска не платит за страницу таблицы, а
	// таблица — за выборку доски. Варианты фильтров нужны обоим представлениям.
	if (view === 'board') {
		const [board, filterOptions] = await Promise.all([
			getInteractionBoard(ctx, workspace, {
				status: filters.status,
				stageCategory,
				overdue: filters.overdue,
				q: table.search === '' ? null : table.search,
				org: filters.org,
				dir: filters.dir,
				prog: filters.prog,
				prod: filters.prod,
				owner: filters.owner
			}),
			readInteractionFilterOptions(ctx, workspace.id)
		]);

		return { view: 'board' as const, ...common, board, filterOptions };
	}

	const query = interactionListQuerySchema.parse({
		status: filters.status,
		workspace: workspace.key,
		stageCategory: filters.stageCategory,
		overdue: filters.overdue,
		org: filters.org,
		dir: filters.dir,
		prog: filters.prog,
		prod: filters.prod,
		owner: filters.owner,
		sort: toSort(table.sortBy, table.sortDirection),
		q: table.search,
		page: table.page,
		pageSize: table.size
	});

	const [result, users, filterOptions] = await Promise.all([
		listInteractions(ctx, query),
		responsibleOptions(event),
		readInteractionFilterOptions(ctx, workspace.id)
	]);

	return {
		view: 'table' as const,
		...common,
		rows: result.items,
		total: result.total,
		users,
		filterOptions
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
	 * Вид перехода приходит из описания процесса, поэтому разбирается схемой
	 * своей команды — у возврата и пропуска причина обязательна, и требование
	 * это не интерфейса, а контракта. Двигают запись те же атомарные команды
	 * движка, что и карточка: прав и готовности перехода доска не решает.
	 *
	 * Номер редакции едет с доски вместе с командой: если процесс изменили, пока
	 * доска была открыта, команда отказывает словами, а не двигает запись по
	 * правилам, которых уже нет.
	 */
	transition: async (event) => {
		const data = await event.request.formData();

		const input = {
			interactionId: data.get('interactionId'),
			fromStageId: data.get('fromStageId'),
			toStageId: data.get('toStageId'),
			revision: Number(data.get('revision')),
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
