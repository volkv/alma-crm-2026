<script lang="ts">
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import { Button } from '$lib/components/ui/button/index.js';
	import { getCardCommands } from './commands.svelte';
	import type { StageDot } from './model';
	import { isCurrentState, STAGE_LOOKS } from './stage-look';

	/**
	 * Процесс столбиком: номер, название и состояние каждой стадии. Столбик не
	 * прокручивается вбок ни на какой ширине — длинное название переносится.
	 *
	 * Пройденные стадии свёрнуты в одну строку: на двенадцатой стадии
	 * одиннадцать зелёных строк над текущей отодвигали её за край экрана.
	 *
	 * Каждую стадию можно раскрыть: что на ней спрашивают и как это
	 * закрывается, чем кончился прошлый проход и — если процесс позволяет —
	 * пропустить до неё или вернуться на неё. Переходы те же, что в меню «Ещё»,
	 * с теми же причинами отказа: пропуск не спрятан на одной стадии.
	 */
	let { stages }: { stages: readonly StageDot[] } = $props();

	const commands = getCardCommands();

	const firstOpen = $derived(stages.findIndex((stage) => stage.state !== 'done'));
	const passed = $derived(firstOpen > 1 ? stages.slice(0, firstOpen) : ([] as StageDot[]));
	const rest = $derived(stages.slice(passed.length));
</script>

{#snippet row(stage: StageDot)}
	{@const look = STAGE_LOOKS[stage.state]}
	{@const Icon = look.icon}
	{@const here = isCurrentState(stage.state)}
	<details class="group/stage">
		<summary
			class="flex cursor-pointer list-none items-start gap-2 rounded-sm py-1 focus-ring hover:bg-surface-muted [&::-webkit-details-marker]:hidden {here
				? ''
				: 'text-muted-foreground'}"
		>
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
		</summary>
		<div class="mb-2 ml-6 flex flex-col gap-2 text-xs" data-slot="stage-details">
			<p class="text-muted-foreground">Состояние: {look.label}</p>
			{#if stage.checklist.length === 0}
				<p class="text-muted-foreground">Чек-листа у стадии нет.</p>
			{:else}
				<ul class="flex flex-col gap-1.5">
					{#each stage.checklist as point, index (index)}
						<li class="flex flex-col gap-0.5">
							<span class="text-foreground">
								{point.label}{#if point.required}<span
										class="text-danger"
										title="Обязательный пункт">*</span
									>{/if}
							</span>
							<span class="text-muted-foreground">Закрывает: {point.how}</span>
							{#if point.help}
								<span class="text-muted-foreground">{point.help}</span>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
			{#if stage.result !== null}
				<p class="break-words whitespace-pre-line">
					<span class="text-muted-foreground">Результат прошлого прохода:</span>
					{stage.result}
				</p>
			{/if}
			{#each stage.moves as move (move.label)}
				<div class="flex flex-col items-start gap-0.5">
					<Button
						size="sm"
						variant="outline"
						disabled={!move.allowed}
						onclick={() => commands.open(move.command)}
					>
						{move.label}
					</Button>
					{#if move.reason}
						<span class="text-muted-foreground">{move.reason}</span>
					{/if}
				</div>
			{/each}
		</div>
	</details>
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
					<!-- Числом, а не диапазоном номеров: в пути бывают стадии,
						убранные из процесса, и «с 1-й по N-ю» тогда врёт. -->
					Пройдено стадий: {passed.length}
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
