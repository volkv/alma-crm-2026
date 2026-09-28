<script lang="ts">
	import AppShell from '$lib/components/app-shell/app-shell.svelte';
	import { navLinks } from '$lib/components/app-shell/nav-links';
	import { visibleSections } from '$lib/nav';
	import OnboardingTour from '$lib/components/onboarding/onboarding-tour.svelte';
	import { createOnboardingTour, setOnboardingTour } from '$lib/onboarding/tour.svelte';
	import type { LayoutProps } from './$types';

	let { data, children }: LayoutProps = $props();

	/**
	 * Подсказки принадлежат оболочке, а не странице: знакомство само открывает
	 * раздел за разделом, и пережить переход между ними оно обязано. Отсюда же их
	 * берут компас и значок «?» в шапке, меню разделов, справка и профиль
	 * (`docs/onboarding.md`). Знакомство собирается из того же меню, что рисует
	 * оболочка: раздела, закрытого правами, в нём нет.
	 */
	const tour = setOnboardingTour(
		createOnboardingTour(
			() => data.user,
			() =>
				data.user === null ? [] : visibleSections(navLinks(data.workspaces), data.user.permissions)
		)
	);
</script>

<AppShell
	user={data.user}
	workspaces={data.workspaces}
	demoMode={data.demoMode}
	demoResetHour={data.demoResetHour}
>
	{@render children()}
</AppShell>

<OnboardingTour {tour} />
