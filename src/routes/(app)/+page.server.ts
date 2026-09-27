import {
	INTERACTION_LIST_STATES,
	STAGE_CATEGORIES,
	type InteractionListState,
	type StageCategory
} from '$lib/contracts/interactions';
import {
	isMyDayInteractionKind,
	type MyDay,
	type MyDayInteractionKind
} from '$lib/contracts/my-day';
import {
	interactionsHref,
	type InteractionsFilter,
	type WorkspaceCount
} from '$lib/components/home/links';
import type { ActorContext } from '$lib/server/actor';
import { actorFromEvent } from '$lib/server/actor';
import { toPageError } from '$lib/server/http';
import { getMyDay } from '$lib/server/interactions/my-day';
import { COMPLETED_WINDOW_DAYS, getWorkOverview } from '$lib/server/interactions/overview';
import { listInteractions } from '$lib/server/interactions/read';
import type { PageServerLoad } from './$types';

type Workspace = { key: string; name: string };

/**
 * Сколько строк покажет список пространства под фильтром плитки — тем же
 * читателем и тем же условием, что и сам список (`listInteractions`): число
 * рядом со ссылкой обязано совпасть со строками по ней, а второе описание
 * отбора однажды разошлось бы с первым.
 */
async function countIn(
	ctx: ActorContext,
	workspace: Workspace,
	filter: InteractionsFilter
): Promise<WorkspaceCount> {
	const { total } = await listInteractions(ctx, {
		status: filter.status,
		ownerUserId: null,
		organizationId: null,
		workspace: workspace.key,
		stageCategory: filter.stageCategory ?? null,
		overdue: filter.overdue ?? false,
		state: filter.state ?? null,
		day: filter.day ?? null,
		closedWithin: filter.closedWithin ?? null,
		org: [],
		dir: [],
		prog: [],
		prod: [],
		owner: filter.owner === undefined ? [] : [filter.owner],
		sort: '-lastActivityAt',
		q: null,
		page: 1,
		pageSize: 1
	});

	return {
		key: workspace.key,
		name: workspace.name,
		count: total,
		href: interactionsHref(workspace.key, filter)
	};
}

/** Части числа по пространствам — только непустые. */
async function split(
	ctx: ActorContext,
	workspaces: readonly Workspace[],
	filter: InteractionsFilter
): Promise<WorkspaceCount[]> {
	const parts = await Promise.all(workspaces.map((workspace) => countIn(ctx, workspace, filter)));

	return parts.filter((part) => part.count > 0);
}

/**
 * Ссылки плиток и разделов «Моего дня» в списки пространств. Отбор по
 * активной работе считается только там, где она есть: в пространстве без неё
 * ни просрочки, ни «моих», ни стадий нет, и спрашивать об этом базу незачем.
 * Разделы «Моего дня» — только непустые: у пустого раздела нет карточки.
 */
async function listLinks(ctx: ActorContext, workspaces: readonly Workspace[], myDay: MyDay) {
	const active = await split(ctx, workspaces, { status: 'active' });
	const busy = workspaces.filter((workspace) => active.some((part) => part.key === workspace.key));
	const dayKinds = myDay.sections
		.map((section) => section.kind)
		.filter((kind) => isMyDayInteractionKind(kind));

	const [overdue, mine, categories, states, completed, day] = await Promise.all([
		split(ctx, busy, { status: 'active', overdue: true }),
		// Без пользователя «моих» нет; сама сводка такому запросу откажет правом.
		ctx.user === null ? [] : split(ctx, busy, { status: 'active', owner: ctx.user.id }),
		Promise.all(
			STAGE_CATEGORIES.map(
				async (category) =>
					[category, await split(ctx, busy, { status: 'active', stageCategory: category })] as const
			)
		),
		Promise.all(
			INTERACTION_LIST_STATES.map(
				async (state) => [state, await split(ctx, busy, { status: 'active', state })] as const
			)
		),
		// Завершённые — по всем пространствам: активной работы в пространстве
		// может уже не быть, а завершённое за месяц в нём есть.
		split(ctx, workspaces, { status: 'completed', closedWithin: COMPLETED_WINDOW_DAYS }),
		Promise.all(
			dayKinds.map(
				async (kind) => [kind, await split(ctx, busy, { status: 'active', day: kind })] as const
			)
		)
	]);

	return {
		active,
		overdue,
		mine,
		categories: Object.fromEntries(categories) as Record<StageCategory, WorkspaceCount[]>,
		states: Object.fromEntries(states) as Record<InteractionListState, WorkspaceCount[]>,
		completed,
		day: Object.fromEntries(day) as Partial<Record<MyDayInteractionKind, WorkspaceCount[]>>
	};
}

/**
 * Главная — сводка рабочего дня: «Мой день» (что требует внимания сегодня) и
 * картина портфеля. Оба блока считаются на один момент времени, чтобы числа в
 * плитках и строки списка не расходились.
 *
 * Сводка общая по всем пространствам сотрудника, а список дел живёт в
 * пространстве: у плиток, у которых список есть, число раскладывается по
 * пространствам (`listLinks`), и каждая часть ведёт в свой список.
 *
 * Сводка требует права на взаимодействия: без него главная — это 403, а не
 * пятисотая. Первая страница после входа — не то место, где отказ по правам
 * должен выглядеть поломкой.
 */
export const load: PageServerLoad = async (event) => {
	const ctx = actorFromEvent(event);
	const now = new Date();
	const { workspaces } = await event.parent();

	try {
		const [overview, myDay] = await Promise.all([getWorkOverview(ctx, now), getMyDay(ctx, now)]);
		// Разделы «Моего дня» со ссылками — только те, что есть сегодня.
		const lists = await listLinks(ctx, workspaces, myDay);

		return { overview, myDay, lists };
	} catch (cause) {
		toPageError(cause);
	}
};
