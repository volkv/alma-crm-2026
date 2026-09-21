<script lang="ts">
	import { resolve } from '$app/paths';
	import LifeBuoyIcon from '@lucide/svelte/icons/life-buoy';
	import PrinterIcon from '@lucide/svelte/icons/printer';
	import * as Card from '$lib/components/ui/card/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import Breadcrumbs from '$lib/components/breadcrumbs.svelte';
	import Header from '$lib/components/header.svelte';
	import { getOnboardingTour } from '$lib/onboarding/tour.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	/**
	 * Полный обход системы показывается один раз и на этом устройстве. Позвать
	 * его обратно человек должен там, где ищет объяснения, — то есть здесь.
	 */
	const tour = getOnboardingTour();
</script>

<svelte:head>
	<title>Справка — LCT CRM</title>
</svelte:head>

<Header
	title="Справка"
	description="Руководства пользователя и администратора: как устроена работа и как устроена система."
>
	{#snippet actions()}
		<!-- Кнопки, которая ничего не делает, здесь нет: роли без подсказок их не
			увидит и не нажмёт. -->
		{#if tour.fullLength > 0}
			<Button variant="outline" onclick={() => tour.startFull()}>
				<LifeBuoyIcon aria-hidden="true" />
				Полный тур по системе
			</Button>
		{/if}
		<Button variant="outline" href={resolve('/(app)/help/print')} data-tour="help-print">
			<PrinterIcon aria-hidden="true" />
			Версия для печати
		</Button>
	{/snippet}
</Header>

<Breadcrumbs items={[{ label: 'Главная', href: resolve('/') }, { label: 'Справка' }]} />

<!-- `data-tour` — метка для подсказок (`$lib/onboarding/screens`). -->
<div class="flex flex-col gap-4 p-4 sm:p-6" data-tour="help-sections">
	{#each data.sections as section (section.key)}
		<Card.Root>
			<Card.Header>
				<Card.Title>{section.title}</Card.Title>
				<Card.Description>{section.description}</Card.Description>
			</Card.Header>
			<Card.Content>
				<ol class="flex flex-col divide-y divide-border">
					{#each section.pages as page (page.slug)}
						<li>
							<a
								href={resolve('/(app)/help/[section]/[page]', {
									section: page.section,
									page: page.slug
								})}
								class="flex flex-col gap-0.5 rounded-md px-2 py-2.5 focus-ring hover:bg-surface-muted"
							>
								<span class="text-sm font-medium">{page.title}</span>
								<span class="text-xs text-muted-foreground">{page.summary}</span>
							</a>
						</li>
					{/each}
				</ol>
			</Card.Content>
		</Card.Root>
	{/each}
</div>
