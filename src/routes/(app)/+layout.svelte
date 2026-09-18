<script lang="ts">
	import AppShell from '$lib/components/app-shell/app-shell.svelte';
	import OnboardingTour from '$lib/components/onboarding/onboarding-tour.svelte';
	import { createOnboardingTour, setOnboardingTour } from '$lib/onboarding/tour.svelte';
	import type { LayoutProps } from './$types';

	let { data, children }: LayoutProps = $props();

	/**
	 * Подсказки первого входа принадлежат оболочке, а не странице: шаг, чей блок
	 * живёт в другом разделе, ведёт туда ссылкой, и тур обязан пережить переход.
	 * Отсюда же их берут страницы, которые показывают подсказки повторно
	 * (справка и профиль).
	 */
	const tour = setOnboardingTour(createOnboardingTour(() => data.user));
</script>

<AppShell user={data.user} demoMode={data.demoMode} demoResetHour={data.demoResetHour}>
	{@render children()}
</AppShell>

<OnboardingTour {tour} />
