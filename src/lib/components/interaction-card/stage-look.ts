import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
import CircleDotIcon from '@lucide/svelte/icons/circle-dot';
import CircleIcon from '@lucide/svelte/icons/circle';
import CircleMinusIcon from '@lucide/svelte/icons/circle-minus';
import CirclePauseIcon from '@lucide/svelte/icons/circle-pause';
import OctagonAlertIcon from '@lucide/svelte/icons/octagon-alert';
import type { StageProgressState } from '$lib/contracts/interactions';
import type { LucideIcon } from '$lib/icon';

type StageLook = {
	/** Состояние словами — для подписи и для читалки экрана. */
	label: string;
	icon: LucideIcon;
	/** Цвет значка в списке стадий. */
	iconClass: string;
	/** Отрезок полосы процесса. */
	barClass: string;
};

/**
 * Как выглядит стадия в схеме процесса. Состояние считает сервер
 * (`buildProgress`); здесь только его вид: пройденные — зелёные, текущая —
 * акцентом, просроченная и заблокированная — красным, впереди — серым.
 */
export const STAGE_LOOKS: Record<StageProgressState, StageLook> = {
	done: {
		label: 'пройдена',
		icon: CircleCheckIcon,
		iconClass: 'text-success',
		barClass: 'bg-success'
	},
	current: {
		label: 'текущая',
		icon: CircleDotIcon,
		iconClass: 'text-primary',
		barClass: 'bg-primary'
	},
	overdue: {
		label: 'текущая, срок прошёл',
		icon: CircleAlertIcon,
		iconClass: 'text-danger',
		barClass: 'bg-danger'
	},
	blocked: {
		label: 'текущая, есть помеха',
		icon: OctagonAlertIcon,
		iconClass: 'text-danger',
		barClass: 'bg-danger'
	},
	paused: {
		label: 'текущая, на паузе',
		icon: CirclePauseIcon,
		iconClass: 'text-muted-foreground',
		barClass: 'bg-border-strong'
	},
	skipped: {
		label: 'пропущена',
		icon: CircleMinusIcon,
		iconClass: 'text-faint',
		barClass: 'bg-border-strong'
	},
	pending: {
		label: 'впереди',
		icon: CircleIcon,
		iconClass: 'text-faint',
		barClass: 'bg-border'
	}
};

/** Стадия, на которой запись стоит сейчас, в каком бы состоянии она ни была. */
export const isCurrentState = (state: StageProgressState) =>
	state === 'current' || state === 'overdue' || state === 'blocked' || state === 'paused';
