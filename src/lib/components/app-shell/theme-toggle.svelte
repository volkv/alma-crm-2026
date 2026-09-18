<script lang="ts">
	import SunIcon from '@lucide/svelte/icons/sun';
	import MoonIcon from '@lucide/svelte/icons/moon';
	import MonitorIcon from '@lucide/svelte/icons/monitor';
	import { cn } from '$lib/utils';
	import { theme, THEME_LABELS, THEME_PREFERENCES, type ThemePreference } from '$lib/theme.svelte';

	/**
	 * Светлая, тёмная или как в системе.
	 *
	 * Три кнопки, а не одна переключающая: у «как в системе» нет положения на
	 * тумблере — она не третье состояние света, а отказ выбирать за браузер.
	 * Нажатое положение говорит `aria-pressed`, а не цвет: цвет тут как раз тот,
	 * которым человек, возможно, и не пользуется.
	 *
	 * Выбор запоминается на устройстве (`$lib/theme.svelte.ts`), поэтому переключатель
	 * может стоять в нескольких местах сразу — все они показывают один выбор.
	 */
	let { class: className }: { class?: string } = $props();

	const icons: Record<ThemePreference, typeof SunIcon> = {
		light: SunIcon,
		dark: MoonIcon,
		system: MonitorIcon
	};
</script>

<div
	role="group"
	aria-label="Тема оформления"
	data-slot="theme-toggle"
	class={cn(
		'inline-flex shrink-0 items-center gap-0.5 rounded-md border border-border p-0.5',
		className
	)}
>
	{#each THEME_PREFERENCES as preference (preference)}
		{@const Icon = icons[preference]}
		<button
			type="button"
			aria-pressed={theme.preference === preference}
			aria-label={THEME_LABELS[preference]}
			title={THEME_LABELS[preference]}
			data-theme-option={preference}
			class="flex size-7 items-center justify-center rounded-sm text-muted-foreground focus-ring transition-colors hover:bg-surface-muted hover:text-foreground aria-pressed:bg-primary-soft aria-pressed:text-primary"
			onclick={() => theme.select(preference)}
		>
			<Icon class="size-4" aria-hidden="true" />
		</button>
	{/each}
</div>
