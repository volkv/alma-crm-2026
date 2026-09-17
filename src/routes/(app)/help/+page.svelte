<script lang="ts">
	import { resolve } from '$app/paths';
	import PrinterIcon from '@lucide/svelte/icons/printer';
	import * as Card from '$lib/components/ui/card/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import PageHeader from '$lib/components/page-header.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<svelte:head>
	<title>Справка — LCT CRM</title>
</svelte:head>

<PageHeader
	title="Справка"
	description="Руководства пользователя и администратора: как устроена работа и как устроена система."
	breadcrumbs={[{ label: 'Главная', href: resolve('/') }]}
>
	{#snippet actions()}
		<Button variant="outline" href={resolve('/(app)/help/print')}>
			<PrinterIcon aria-hidden="true" />
			Версия для печати
		</Button>
	{/snippet}
</PageHeader>

<div class="flex flex-col gap-4 p-4 sm:p-6">
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
