<script lang="ts">
	import AppShell from '$lib/components/app-shell/app-shell.svelte';
	import OnboardingTour from '$lib/components/onboarding/onboarding-tour.svelte';
	import { createOnboardingTour, setOnboardingTour } from '$lib/onboarding/tour.svelte';
	import type { LayoutProps } from './$types';

	let { data, children }: LayoutProps = $props();

	/**
	 * Подсказки принадлежат оболочке, а не странице: полный тур сам открывает
	 * экран за экраном, и пережить переход между ними он обязан. Отсюда же их
	 * берут значок «?» в шапке, меню учётной записи, справка и профиль
	 * (`docs/onboarding.md`).
	 */
	const tour = setOnboardingTour(createOnboardingTour(() => data.user));
</script>

<AppShell user={data.user} demoMode={data.demoMode} demoResetHour={data.demoResetHour}>
	{@render children()}
</AppShell>

<OnboardingTour {tour} />
