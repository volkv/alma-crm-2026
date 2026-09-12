<script lang="ts" module>
	/** Шаги мастера загрузки; каждый живёт на своей странице. */
	export const WIZARD_STEPS = [
		{ number: 1, label: 'Файл и период' },
		{ number: 2, label: 'Сопоставление колонок' },
		{ number: 3, label: 'Проверка и подтверждение' }
	] as const;

	export type WizardStep = (typeof WIZARD_STEPS)[number]['number'];
</script>

<script lang="ts">
	import CheckIcon from '@lucide/svelte/icons/check';

	/**
	 * Где человек находится в загрузке данных и что будет дальше.
	 *
	 * Шаги — это отдельные страницы, а не вкладки: у каждого свой адрес, и на
	 * второй шаг можно вернуться из списка снимков через неделю. Полоска только
	 * показывает место; переходами распоряжаются сами страницы.
	 */
	let { current }: { current: WizardStep } = $props();
</script>

<ol class="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm" data-slot="wizard-steps">
	{#each WIZARD_STEPS as step (step.number)}
		{@const done = step.number < current}
		{@const active = step.number === current}
		<li class="flex items-center gap-2" aria-current={active ? 'step' : undefined}>
			<span
				class="flex size-5 shrink-0 items-center justify-center rounded-full text-xs font-medium
					{done ? 'bg-success-soft text-success-soft-foreground' : ''}
					{active ? 'bg-primary text-primary-foreground' : ''}
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
		{#if step.number < WIZARD_STEPS.length}
			<li aria-hidden="true" class="h-px w-6 bg-border"></li>
		{/if}
	{/each}
</ol>
