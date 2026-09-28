<script lang="ts">
	import { page } from '$app/state';
	import CompassIcon from '@lucide/svelte/icons/compass';
	import { Button } from '$lib/components/ui/button/index.js';
	import { pluralize } from '$lib/format';
	import { screenForPath } from '$lib/onboarding/screens';
	import { getOnboardingTour } from '$lib/onboarding/tour.svelte';

	/**
	 * Кнопка тура по открытому экрану: вступление и его элементы, без
	 * приветствия и без переходов. Полный тур — это те же туры экранов подряд,
	 * а здесь человек берёт ровно тот кусок, который ему нужен сейчас.
	 *
	 * Пока тур этого экрана на этом устройстве не прошли и не пропустили, от
	 * кнопки расходятся волны цвета главного действия. Пройденный до конца или
	 * закрытый тур (в том числе внутри полного) их гасит. Экрана вне реестра
	 * или без шагов при текущих правах кнопка не показывает: звать некуда.
	 */

	const tour = getOnboardingTour();

	const screen = $derived(screenForPath(page.url.pathname));
	const steps = $derived(screen === null ? 0 : tour.screenLength(screen));
	const unseen = $derived(screen !== null && !tour.screenSeen(screen.id));
	const label = $derived(
		screen === null
			? ''
			: `Тур по экрану «${screen.title}»: ${pluralize(steps, ['шаг', 'шага', 'шагов'])}`
	);
</script>

{#if screen !== null && steps > 0}
	{@const current = screen}
	<Button
		variant="ghost"
		size="icon-sm"
		class="relative {unseen ? 'text-primary' : 'text-muted-foreground'}"
		aria-label={label}
		title={label}
		data-tour="screen-tour"
		data-unseen={unseen ? '' : undefined}
		onclick={() => tour.startScreen(current, page.url.pathname)}
	>
		{#if unseen}
			<span class="waves" aria-hidden="true"><span></span><span></span></span>
		{/if}
		<CompassIcon aria-hidden="true" />
	</Button>
{/if}

<style>
	.waves,
	.waves > span {
		position: absolute;
		inset: 0;
		border-radius: 9999px;
		pointer-events: none;
	}

	.waves > span {
		border: 2px solid var(--color-primary);
		animation: screen-tour-wave 2.4s cubic-bezier(0.2, 0.6, 0.4, 1) infinite;
	}

	.waves > span:last-child {
		animation-delay: 1.2s;
	}

	@keyframes screen-tour-wave {
		from {
			opacity: 0.7;
			transform: scale(0.9);
		}
		to {
			opacity: 0;
			transform: scale(1.9);
		}
	}

	/* Без движения — одно неподвижное кольцо: приглашение остаётся, мельтешения нет. */
	@media (prefers-reduced-motion: reduce) {
		.waves > span {
			animation: none;
			opacity: 0.6;
		}

		.waves > span:last-child {
			display: none;
		}
	}
</style>
