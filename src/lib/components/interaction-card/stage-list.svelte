<script lang="ts">
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import type { Snippet } from 'svelte';
	import type { StageDot } from './model';
	import { isCurrentState, STAGE_LOOKS } from './stage-look';

	/**
	 * Процесс столбиком: номер, название и состояние каждой стадии. Столбик не
	 * прокручивается вбок ни на какой ширине — длинное название переносится.
	 *
	 * `collapseDone` сворачивает пройденные в одну строку: на двенадцатой стадии
	 * одиннадцать зелёных строк над текущей отодвигали её за край экрана.
	 * `current` — то, что стоит под текущей стадией (в рабочем месте там живёт
	 * главное действие).
	 */
	let {
		stages,
		collapseDone = false,
		current
	}: {
		stages: readonly StageDot[];
		collapseDone?: boolean;
		current?: Snippet;
	} = $props();

	const firstOpen = $derived(stages.findIndex((stage) => stage.state !== 'done'));
	const passed = $derived(
		collapseDone && firstOpen > 1 ? stages.slice(0, firstOpen) : ([] as StageDot[])
	);
	const rest = $derived(passed.length === 0 ? stages : stages.slice(passed.length));
</script>

{#snippet row(stage: StageDot)}
	{@const look = STAGE_LOOKS[stage.state]}
	{@const Icon = look.icon}
	{@const here = isCurrentState(stage.state)}
	<div class="flex items-start gap-2 py-1 {here ? '' : 'text-muted-foreground'}">
		<Icon class="mt-0.5 size-4 shrink-0 {look.iconClass}" aria-hidden="true" />
		<span class="min-w-0 text-sm {here ? 'font-medium text-foreground' : ''}">
			<span class="tabular-nums">{stage.position}.</span>
			{stage.name}
			<span class="sr-only">— {look.label}</span>
		</span>
	</div>
{/snippet}

<ol class="flex flex-col" data-slot="stage-list">
	{#if passed.length > 0}
		<li>
			<details class="group">
				<summary
					class="flex list-none items-center gap-2 rounded-sm py-1 text-sm text-muted-foreground focus-ring hover:text-foreground [&::-webkit-details-marker]:hidden"
				>
					<ChevronRightIcon
						class="size-4 shrink-0 text-success transition-transform group-open:rotate-90"
						aria-hidden="true"
					/>
					Пройдено {passed.length} — с 1-й по {passed.length}-ю
				</summary>
				<ol class="flex flex-col">
					{#each passed as stage (stage.id)}
						<li>{@render row(stage)}</li>
					{/each}
				</ol>
			</details>
		</li>
	{/if}
	{#each rest as stage (stage.id)}
		<li>
			{@render row(stage)}
			{#if current && isCurrentState(stage.state)}
				<div class="pb-2 pl-6">{@render current()}</div>
			{/if}
		</li>
	{/each}
</ol>
