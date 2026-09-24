<script lang="ts">
	import { resolve } from '$app/paths';
	import type { Pathname } from '$app/types';
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';
	import BookOpenIcon from '@lucide/svelte/icons/book-open';
	import Breadcrumbs from '$lib/components/breadcrumbs.svelte';
	import Header from '$lib/components/header.svelte';
	import StatusBadge, { type StatusTone } from '$lib/components/status-badge.svelte';
	import {
		AUTOMATION_KINDS,
		AUTOMATION_KIND_DESCRIPTIONS,
		AUTOMATION_KIND_LABELS,
		type AutomationKind
	} from '$lib/automation-map';
	import { formatNumber } from '$lib/format';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	/** Тон метки — по тому, кто делает работу, а не по цвету, который хочется. */
	const KIND_TONES: Record<AutomationKind, StatusTone> = {
		system: 'success',
		assist: 'info',
		control: 'warning'
	};

	type Action = (typeof data.crossCutting)[number];
</script>

<svelte:head>
	<title>Карта автоматизации — Альма CRM</title>
</svelte:head>

<Header
	title="Карта автоматизации"
	description={`Что система берёт на себя на каждом из ${data.steps.length} шагов процесса «${data.processName}» и где это увидеть.`}
/>

<Breadcrumbs items={[{ label: 'Главное', href: resolve('/') }, { label: 'Карта автоматизации' }]} />

{#snippet action(item: Action)}
	<li class="flex min-w-0 flex-col gap-1.5 py-3 first:pt-0 last:pb-0">
		<div class="flex flex-wrap items-center gap-1.5">
			<StatusBadge tone={KIND_TONES[item.kind]} dot>{AUTOMATION_KIND_LABELS[item.kind]}</StatusBadge
			>
			{#if item.status === 'in_progress'}
				<StatusBadge tone="neutral">В работе</StatusBadge>
			{/if}
		</div>
		<p class="text-sm font-medium break-words">{item.title}</p>
		<p class="text-sm break-words text-muted-foreground">
			<span class="sr-only">Как проверить: </span>{item.result}
		</p>
		<div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
			{#if item.where.href !== null}
				<a
					href={resolve(item.where.href as Pathname & '/')}
					class="inline-flex items-center gap-1 rounded-sm text-link focus-ring hover:text-link-hover hover:underline"
				>
					Где это: {item.where.label}
					<ArrowRightIcon class="size-3.5" aria-hidden="true" />
				</a>
			{:else}
				<span class="text-muted-foreground">Где это: {item.where.label} — закрыто вашей роли</span>
			{/if}
			{#if item.help !== null}
				<a
					href={resolve('/(app)/help/[section]/[page]', {
						section: item.help.section,
						page: item.help.page
					})}
					class="inline-flex items-center gap-1 rounded-sm text-muted-foreground focus-ring hover:underline"
				>
					<BookOpenIcon class="size-3.5" aria-hidden="true" />
					{item.help.title}
				</a>
			{/if}
			{#if item.count !== null}
				<span class="tabular-nums">
					<span class="font-medium">{formatNumber(item.count.value)}</span>
					{item.count.label}
				</span>
			{/if}
		</div>
	</li>
{/snippet}

<div class="flex flex-col gap-6 p-4 sm:px-9 sm:py-6">
	<!-- `data-tour` — метка для подсказок (`$lib/onboarding/screens`). -->
	<section
		aria-labelledby="automation-legend"
		class="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4"
		data-tour="automation-legend"
	>
		<h2 id="automation-legend" class="section-title">Три вида автоматизации</h2>
		<ul class="grid gap-3 sm:grid-cols-3">
			{#each AUTOMATION_KINDS as kind (kind)}
				<li class="flex flex-col gap-1">
					<StatusBadge tone={KIND_TONES[kind]} dot>{AUTOMATION_KIND_LABELS[kind]}</StatusBadge>
					<span class="text-sm text-muted-foreground">{AUTOMATION_KIND_DESCRIPTIONS[kind]}</span>
				</li>
			{/each}
		</ul>
		<p class="text-xs text-muted-foreground">
			«В работе» — то, что ещё не выпущено: описано честно и за сделанное не выдаётся.
			{#if data.countersShown}
				Числа — всего по журналу обмена.
			{/if}
		</p>
	</section>

	<ol class="flex flex-col gap-3" data-tour="automation-steps">
		{#each data.steps as step (step.key)}
			<li class="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4 sm:flex-row">
				<div class="flex shrink-0 items-baseline gap-2 sm:w-64">
					<span
						class="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-surface-muted text-sm font-medium text-foreground tabular-nums"
						aria-hidden="true">{step.number}</span
					>
					<h2 class="section-title break-words">
						<span class="sr-only">Шаг {step.number}. </span>{step.name}
					</h2>
				</div>
				<ul class="flex min-w-0 flex-1 flex-col divide-y divide-border">
					{#each step.actions as item (item.title)}
						{@render action(item)}
					{/each}
				</ul>
			</li>
		{/each}
	</ol>

	<section
		aria-labelledby="automation-cross"
		class="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4"
		data-tour="automation-cross"
	>
		<h2 id="automation-cross" class="section-title">На всём процессе</h2>
		<ul class="flex flex-col divide-y divide-border">
			{#each data.crossCutting as item (item.title)}
				{@render action(item)}
			{/each}
		</ul>
	</section>
</div>
