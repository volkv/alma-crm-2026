<script lang="ts">
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import type { StageDot } from './model';
	import { isCurrentState, STAGE_LOOKS } from './stage-look';

	/**
	 * Процесс столбиком: номер, название и состояние каждой стадии. Столбик не
	 * прокручивается вбок ни на какой ширине — длинное название переносится.
	 *
	 * Пройденные стадии свёрнуты в одну строку: на двенадцатой стадии
	 * одиннадцать зелёных строк над текущей отодвигали её за край экрана.
	 */
	let { stages }: { stages: readonly StageDot[] } = $props();

	const firstOpen = $derived(stages.findIndex((stage) => stage.state !== 'done'));
	const passed = $derived(firstOpen > 1 ? stages.slice(0, firstOpen) : ([] as StageDot[]));
	const rest = $derived(stages.slice(passed.length));
</script>

{#snippet row(stage: StageDot)}
	{@const look = STAGE_LOOKS[stage.state]}
	{@const Icon = look.icon}
	{@const here = isCurrentState(stage.state)}
	<div class="flex items-start gap-2 py-1 {here ? '' : 'text-muted-foreground'}">
		<Icon class="mt-0.5 size-4 shrink-0 {look.iconClass}" aria-hidden="true" />
		<span class="flex min-w-0 flex-col text-sm {here ? 'font-medium text-foreground' : ''}">
			<span class="break-words">
				<span class="tabular-nums">{stage.position}.</span>
				{stage.name}
				<span class="sr-only">— {look.label}</span>
			</span>
			{#if stage.note}
				<span class="text-xs font-normal text-muted-foreground">{stage.note}</span>
			{/if}
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
		<li>{@render row(stage)}</li>
	{/each}
</ol>
