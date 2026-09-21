<script lang="ts">
	import SunIcon from '@lucide/svelte/icons/sun';
	import MoonIcon from '@lucide/svelte/icons/moon';
	import MonitorIcon from '@lucide/svelte/icons/monitor';
	import { cn } from '$lib/utils';
	import { theme, THEME_LABELS, THEME_PREFERENCES, type ThemePreference } from '$lib/theme.svelte';

	/**
	 * Светлая, тёмная или как в системе.
	 *
	 * Одна кнопка вместо трёх: в шапке место дороже полноты списка, а выбор тут
	 * из трёх положений по кругу — светлая, тёмная, как в системе. Значок
	 * показывает не следующее нажатие, а то, что выбрано сейчас: переключатель
	 * обязан прежде всего отвечать на вопрос «что стоит», а куда он поедет,
	 * говорят подпись и подсказка.
	 *
	 * Значки стоят все три, а видимым один делает CSS по `data-theme-preference`
	 * на <html> (`app.css`). Рисовать сразу выбранный нельзя: выбор лежит в
	 * `localStorage`, серверу он неизвестен, и разметка с сервера разошлась бы с
	 * разметкой после оживления — оживление правило бы чужой <svg> под себя, и от
	 * значка оставались куски. Атрибут ставит `static/theme.js` до первого кадра,
	 * поэтому после перезагрузки виден сразу выбранный значок.
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

	const next = $derived(
		THEME_PREFERENCES[(THEME_PREFERENCES.indexOf(theme.preference) + 1) % THEME_PREFERENCES.length]
	);
</script>

<button
	type="button"
	data-slot="theme-toggle"
	data-theme-option={theme.preference}
	aria-label={`Тема оформления: ${THEME_LABELS[theme.preference]}. Переключить на: ${THEME_LABELS[next]}`}
	title={`${THEME_LABELS[theme.preference]} — переключить на: ${THEME_LABELS[next]}`}
	class={cn(
		'flex size-8 shrink-0 items-center justify-center rounded-md border border-border text-muted-foreground focus-ring transition-colors hover:bg-surface-muted hover:text-foreground',
		className
	)}
	onclick={() => theme.select(next)}
>
	{#each THEME_PREFERENCES as preference (preference)}
		{@const Icon = icons[preference]}
		<Icon class="size-4" data-theme-icon={preference} aria-hidden="true" />
	{/each}
</button>
