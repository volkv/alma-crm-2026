<script lang="ts" module>
	import type { LucideIcon } from '@lucide/svelte';
	import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
	import CircleDotIcon from '@lucide/svelte/icons/circle-dot';
	import CirclePauseIcon from '@lucide/svelte/icons/circle-pause';
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
	import OctagonAlertIcon from '@lucide/svelte/icons/octagon-alert';
	import CircleMinusIcon from '@lucide/svelte/icons/circle-minus';
	import CircleIcon from '@lucide/svelte/icons/circle';
	import type { DateInput } from '$lib/format';

	/** Where a stage of the route stands right now. */
	export type StageState =
		'pending' | 'done' | 'current' | 'paused' | 'overdue' | 'blocked' | 'skipped';

	/** One stage of an interaction route, as the interface receives it. */
	export type Stage = {
		id: string;
		label: string;
		state: StageState;
		/** When the stage is due; drives the deadline chip on the current stage. */
		deadline?: DateInput | null;
		/** Who owns the stage right now. */
		assignee?: string | null;
		/** Why the stage is paused, blocked or skipped. */
		note?: string | null;
	};

	type StageLook = {
		/** What the state is called in the interface. */
		title: string;
		icon: LucideIcon;
		/** The node itself. */
		node: string;
		/** The rail segment that leads into this node. */
		rail: string;
		/** The stage label under the node. */
		label: string;
		/** The bar segment in compact mode. */
		bar: string;
	};

	const looks: Record<StageState, StageLook> = {
		pending: {
			title: 'предстоит',
			icon: CircleIcon,
			node: 'border-border-strong bg-surface text-faint',
			rail: 'bg-border',
			label: 'text-faint',
			bar: 'bg-border'
		},
		done: {
			title: 'пройдена',
			icon: CircleCheckIcon,
			node: 'border-success bg-success text-background',
			rail: 'bg-success',
			label: 'text-muted-foreground',
			bar: 'bg-success'
		},
		current: {
			title: 'текущая',
			icon: CircleDotIcon,
			node: 'border-primary bg-primary text-primary-foreground ring-4 ring-primary-soft',
			rail: 'bg-border',
			label: 'font-medium text-foreground',
			bar: 'bg-primary'
		},
		paused: {
			title: 'на паузе',
			icon: CirclePauseIcon,
			node: 'border-border-strong bg-surface-muted text-muted-foreground',
			rail: 'bg-border',
			label: 'text-muted-foreground',
			bar: 'bg-border-strong'
		},
		overdue: {
			title: 'просрочена',
			icon: CircleAlertIcon,
			node: 'border-danger bg-danger text-background',
			rail: 'bg-border',
			label: 'font-medium text-danger-soft-foreground',
			bar: 'bg-danger'
		},
		blocked: {
			title: 'с помехой',
			icon: OctagonAlertIcon,
			node: 'border-warning bg-warning-soft text-warning-soft-foreground',
			rail: 'bg-border',
			label: 'text-warning-soft-foreground',
			bar: 'bg-warning'
		},
		skipped: {
			title: 'пропущена',
			icon: CircleMinusIcon,
			node: 'border-dashed border-border-strong bg-surface text-faint',
			rail: 'bg-border',
			label: 'text-faint line-through',
			bar: 'bg-border'
		}
	};
</script>

<script lang="ts">
	import { formatDate } from '$lib/format';
	import { cn } from '$lib/utils';
	import SlaChip from './sla-chip.svelte';

	/**
	 * The cycle of an interaction, stage by stage: what is behind, what is
	 * happening now, and what is holding it up. This is the frame the record
	 * card opens with, and in `compact` mode the same route fits into a table
	 * cell as a bar of segments — never wider than `COMPACT_WIDTH`, whatever the
	 * cell around it allows.
	 *
	 * The stages arrive as a typed prop — the component fetches nothing and
	 * decides nothing about the process; it only shows the state it is given and
	 * reports a click back through `onselect`.
	 */
	let {
		stages,
		compact = false,
		now = Date.now(),
		onselect,
		class: className
	}: {
		stages: readonly Stage[];
		/** The one-line form for lists; the full stepper is the default. */
		compact?: boolean;
		/** Frozen "now" for the deadline chip. */
		now?: DateInput;
		onselect?: (stage: Stage) => void;
		class?: string;
	} = $props();

	/**
	 * Потолок ширины компактного вида.
	 *
	 * Индикатор стоит в колонке списка, а справа от него — колонки, ради которых
	 * список и открывают: срок и ответственный. Процесс из четырнадцати стадий
	 * растянул бы полосу на треть таблицы и вытеснил бы их за край, поэтому
	 * ширину задаёт не число стадий, а эта константа: полоса — это «докуда
	 * дошли», и на неё хватает 160 px в любом процессе.
	 */
	const COMPACT_WIDTH = 'max-w-40';

	const passed = $derived(stages.filter((stage) => stage.state === 'done').length);

	function describe(stage: Stage): string {
		const parts = [`${stage.label} — ${looks[stage.state].title}`];
		if (stage.deadline) parts.push(`срок ${formatDate(stage.deadline)}`);
		if (stage.assignee) parts.push(stage.assignee);
		if (stage.note) parts.push(stage.note);

		return parts.join(', ');
	}
</script>

{#if compact}
	<div
		class={cn('flex w-full items-center gap-2', COMPACT_WIDTH, className)}
		data-slot="stage-timeline"
	>
		<div
			class="flex flex-1 items-center gap-0.5"
			role="img"
			aria-label="Пройдено этапов: {passed} из {stages.length}"
		>
			{#each stages as stage (stage.id)}
				<!-- min-w-0: у четырнадцати сегментов собственная ширина не важна,
					важно, чтобы полоса целиком укладывалась в отведённые ей 160 px. -->
				<span
					class={cn('h-1.5 min-w-0 flex-1 rounded-full', looks[stage.state].bar)}
					title={describe(stage)}
				></span>
			{/each}
		</div>
		<span class="shrink-0 text-xs text-muted-foreground">{passed}/{stages.length}</span>
	</div>
{:else}
	<div class={cn('overflow-x-auto pb-1', className)} data-slot="stage-timeline">
		<ol class="flex min-w-max items-start">
			{#each stages as stage, index (stage.id)}
				{@const look = looks[stage.state]}
				{@const Icon = look.icon}
				<li class="flex w-36 shrink-0 flex-col items-center">
					<div class="flex w-full items-center">
						<span
							class={cn(
								'h-0.5 flex-1 rounded-full',
								index === 0 ? 'bg-transparent' : looks[stages[index - 1].state].rail
							)}
							aria-hidden="true"
						></span>
						<button
							type="button"
							class={cn(
								'flex size-7 shrink-0 items-center justify-center rounded-full border focus-ring transition-transform hover:scale-110',
								look.node
							)}
							aria-current={stage.state === 'current' ? 'step' : undefined}
							aria-label={describe(stage)}
							onclick={() => onselect?.(stage)}
						>
							<Icon class="size-4" aria-hidden="true" />
						</button>
						<span
							class={cn(
								'h-0.5 flex-1 rounded-full',
								index === stages.length - 1 ? 'bg-transparent' : look.rail
							)}
							aria-hidden="true"
						></span>
					</div>

					<p class={cn('mt-2 px-1 text-center text-xs leading-tight', look.label)}>
						{stage.label}
					</p>

					{#if stage.state === 'current' || stage.state === 'overdue'}
						<div class="mt-1.5 flex flex-col items-center gap-1">
							{#if stage.deadline}
								<SlaChip deadline={stage.deadline} {now} />
							{/if}
							{#if stage.assignee}
								<p class="max-w-32 truncate text-xs text-muted-foreground">{stage.assignee}</p>
							{/if}
						</div>
					{:else if stage.note}
						<p class="mt-1.5 max-w-32 px-1 text-center text-xs text-faint">{stage.note}</p>
					{/if}
				</li>
			{/each}
		</ol>
	</div>
{/if}
