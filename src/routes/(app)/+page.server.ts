import { STAGE_CATEGORIES, type StageCategory } from '$lib/contracts/interactions';
import {
	interactionsHref,
	type InteractionsFilter,
	type WorkspaceCount
} from '$lib/components/home/links';
import type { ActorContext } from '$lib/server/actor';
import { actorFromEvent } from '$lib/server/actor';
import { toPageError } from '$lib/server/http';
import { getMyDay } from '$lib/server/interactions/my-day';
import { getWorkOverview } from '$lib/server/interactions/overview';
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
 * Ссылки плиток в списки пространств. Отбор считается только там, где есть
 * активная работа: в пространстве без неё ни просрочки, ни «моих», ни стадий
 * нет, и спрашивать об этом базу незачем.
 */
async function listLinks(ctx: ActorContext, workspaces: readonly Workspace[]) {
	const active = await split(ctx, workspaces, { status: 'active' });
	const busy = workspaces.filter((workspace) => active.some((part) => part.key === workspace.key));

	const [overdue, mine, categories] = await Promise.all([
		split(ctx, busy, { status: 'active', overdue: true }),
		// Без пользователя «моих» нет; сама сводка такому запросу откажет правом.
		ctx.user === null ? [] : split(ctx, busy, { status: 'active', owner: ctx.user.id }),
		Promise.all(
			STAGE_CATEGORIES.map(
				async (category) =>
					[category, await split(ctx, busy, { status: 'active', stageCategory: category })] as const
			)
		)
	]);

	return {
		active,
		overdue,
		mine,
		categories: Object.fromEntries(categories) as Record<StageCategory, WorkspaceCount[]>
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
		const [overview, myDay, lists] = await Promise.all([
			getWorkOverview(ctx, now),
			getMyDay(ctx, now),
			listLinks(ctx, workspaces)
		]);

		return { overview, myDay, lists };
	} catch (cause) {
		toPageError(cause);
	}
};
