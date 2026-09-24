import { error } from '@sveltejs/kit';
import {
	AUTOMATION_COUNTER_LABELS,
	AUTOMATION_CROSS_CUTTING,
	AUTOMATION_STEPS,
	automationScreen,
	type AutomationAction,
	type AutomationScreen,
	type AutomationCounter,
	type AutomationKind,
	type AutomationStatus
} from '$lib/automation-map';
import type { ExchangeQuery } from '$lib/contracts/exchange';
import { actorFromEvent, type ActorContext } from '$lib/server/actor';
import { listExchangeMessages } from '$lib/server/integrations/exchange/messages';
import { can } from '$lib/server/rbac';
import { B2B_PROCESS, B2B_WORKSPACE_KEY } from '$lib/server/stages/definitions';
import type { PageServerLoad } from './$types';

/**
 * Карта автоматизации: четырнадцать шагов базового процесса и то, что на каждом
 * из них берёт на себя система.
 *
 * Право — то же, что у списка взаимодействий: карта рассказывает о работе с
 * вузом, и тому, кто этой работы не видит, показывать на ней нечего. Ссылка
 * «Где это» остаётся только там, где экран открыт роли: остальное названо
 * словами, без ссылки на отказ.
 *
 * Числа — только из журнала обмена, и только тому, кто журнал видит
 * (`integrations.manage`). Журнал обмена — техническая хроника без области
 * доступа (`docs/access-matrix.md`, раздел 4), поэтому и числа по нему общие, а
 * не по области человека.
 */

type ActionView = {
	kind: AutomationKind;
	title: string;
	result: string;
	status: AutomationStatus;
	where: { label: string; href: string | null };
	help: AutomationScreen['help'];
	count: { value: number; label: string } | null;
};

/** Фильтр журнала под счётчик: сколько строк, а не какие. */
const COUNTER_FILTERS: Record<
	AutomationCounter,
	Pick<ExchangeQuery, 'direction' | 'system' | 'state'>
> = {
	cms_applications: { direction: 'inbound', system: 'cms', state: 'processed' },
	lms_requests: { direction: 'outbound', system: 'lms', state: null },
	lms_results: { direction: 'inbound', system: 'lms', state: 'processed' }
};

async function countMessages(ctx: ActorContext, counter: AutomationCounter): Promise<number> {
	const page = await listExchangeMessages(ctx, {
		...COUNTER_FILTERS[counter],
		q: null,
		page: 1,
		pageSize: 1
	});

	return page.total;
}

async function readCounters(ctx: ActorContext): Promise<Map<AutomationCounter, number> | null> {
	if (!can(ctx, 'integrations.manage')) {
		return null;
	}

	const keys = Object.keys(COUNTER_FILTERS) as AutomationCounter[];
	const values = await Promise.all(keys.map((key) => countMessages(ctx, key)));

	return new Map(keys.map((key, index) => [key, values[index]]));
}

export const load: PageServerLoad = async (event) => {
	const ctx = actorFromEvent(event);

	if (!can(ctx, 'interactions.read')) {
		error(403, 'Раздел доступен только с правом «Просмотр взаимодействий»');
	}

	const counters = await readCounters(ctx);

	function view(action: AutomationAction): ActionView {
		const screen = automationScreen(action.screen, B2B_WORKSPACE_KEY);
		const open = screen.permission === null || can(ctx, screen.permission);
		const value = action.counter === undefined ? undefined : counters?.get(action.counter);

		return {
			kind: action.kind,
			title: action.title,
			result: action.result,
			status: action.status,
			where: { label: action.where ?? screen.title, href: open ? screen.href : null },
			help: screen.help,
			count:
				action.counter === undefined || value === undefined
					? null
					: { value, label: AUTOMATION_COUNTER_LABELS[action.counter] }
		};
	}

	const names = new Map(B2B_PROCESS.stages.map((stage) => [stage.key, stage.name]));

	return {
		processName: B2B_PROCESS.name,
		steps: AUTOMATION_STEPS.map((step, index) => {
			const name = names.get(step.stageKey);

			if (name === undefined) {
				throw new Error(`Стадия «${step.stageKey}» карты автоматизации не найдена в процессе`);
			}

			return { number: index + 1, key: step.stageKey, name, actions: step.actions.map(view) };
		}),
		crossCutting: AUTOMATION_CROSS_CUTTING.map(view),
		countersShown: counters !== null
	};
};
