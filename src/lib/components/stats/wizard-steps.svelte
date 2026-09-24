<script lang="ts" module>
	/** Один шаг мастера: номер по порядку и то, как он называется. */
	export type WizardStepDefinition = { number: number; label: string };

	/** Шаги мастера загрузки данных об обучении; каждый живёт на своей странице. */
	export const WIZARD_STEPS: readonly WizardStepDefinition[] = [
		{ number: 1, label: 'Файл и период' },
		{ number: 2, label: 'Сопоставление колонок' },
		{ number: 3, label: 'Проверка и подтверждение' }
	];
</script>

<script lang="ts">
	import CheckIcon from '@lucide/svelte/icons/check';

	/**
	 * Где человек находится в мастере загрузки и что будет дальше.
	 *
	 * Шаги — это отдельные страницы, а не вкладки: у каждого свой адрес, и на
	 * второй шаг можно вернуться из списка через неделю. Полоска только
	 * показывает место; переходами распоряжаются сами страницы.
	 *
	 * Сам набор шагов приходит снаружи: мастеров в продукте два — загрузка
	 * данных об обучении и импорт каталога, — и они отличаются только
	 * названиями шагов. Второй такой же компонент рядом разошёлся бы с первым на
	 * первой же правке разметки.
	 */
	let {
		current,
		steps = WIZARD_STEPS
	}: { current: number; steps?: readonly WizardStepDefinition[] } = $props();
</script>

<!-- `data-tour` — метка подсказок: полоску шагов показывают оба мастера
	(`$lib/onboarding/screens`). -->
<ol
	class="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm"
	data-slot="wizard-steps"
	data-tour="wizard-steps"
>
	{#each steps as step (step.number)}
		{@const done = step.number < current}
		{@const active = step.number === current}
		<li class="flex items-center gap-2" aria-current={active ? 'step' : undefined}>
			<span
				class="flex size-5 shrink-0 items-center justify-center rounded-full text-xs font-medium
					{done ? 'bg-success-soft text-success-soft-foreground' : ''}
					{active ? 'bg-link text-link-foreground' : ''}
					{!done && !active ? 'bg-surface-muted text-muted-foreground' : ''}"
			>
				{#if done}
					<CheckIcon class="size-3" aria-hidden="true" />
				{:else}
					{step.number}
				{/if}
			</span>
			<span class={active ? 'font-medium' : 'text-muted-foreground'}>{step.label}</span>
		</li>
		{#if step.number < steps.length}
			<li aria-hidden="true" class="h-px w-6 bg-border"></li>
		{/if}
	{/each}
</ol>
