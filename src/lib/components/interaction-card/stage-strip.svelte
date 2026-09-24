<script lang="ts">
	import type { StageDot } from './model';
	import { isCurrentState, STAGE_LOOKS } from './stage-look';

	/**
	 * Процесс одной полосой: отрезок на стадию, во всю ширину контейнера.
	 * Четырнадцать стадий помещаются и в 390 точек — прокрутки нет. Текущая и
	 * следующая стадии названы над полосой (`CardFacts`), все названия — в
	 * списке (`StageList`), который раскрывают по требованию.
	 */
	let { stages }: { stages: readonly StageDot[] } = $props();
</script>

<ol class="flex items-center gap-0.5" aria-label="Стадии процесса" data-slot="stage-strip">
	{#each stages as stage (stage.id)}
		{@const current = isCurrentState(stage.state)}
		<li
			class="min-w-0 flex-1 rounded-full {STAGE_LOOKS[stage.state].barClass} {current
				? 'h-2.5 ring-2 ring-selection'
				: 'h-1.5'}"
			title="{stage.position}. {stage.name} — {STAGE_LOOKS[stage.state].label}"
			aria-current={current ? 'step' : undefined}
		>
			<span class="sr-only">{stage.position}. {stage.name} — {STAGE_LOOKS[stage.state].label}</span>
		</li>
	{/each}
</ol>
