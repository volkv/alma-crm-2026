<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import Breadcrumbs from '$lib/components/breadcrumbs.svelte';
	import { filterHref } from '$lib/components/directory/query';
	import { buildCard } from '$lib/components/interaction-card/model';
	import VariantA from '$lib/components/interaction-card/variant-a.svelte';
	import VariantB from '$lib/components/interaction-card/variant-b.svelte';
	import type { PageProps } from './$types';

	/**
	 * Два макета карточки взаимодействия на одних и тех же записях. Вариант —
	 * в пути (`/ui-kit/card-a`, `/ui-kit/card-b`), образец — в адресе
	 * (`?sample=b2c`): так ссылкой можно переслать ровно то, что обсуждают.
	 */
	let { data }: PageProps = $props();

	const model = $derived(buildCard(data.source, new Date()));

	const VARIANTS = [
		{ key: 'a', label: 'A · одна колонка' },
		{ key: 'b', label: 'B · рабочее место' }
	] as const;

	const pill = (active: boolean) =>
		`inline-flex h-7 items-center rounded-4xl border px-2.5 text-xs font-medium focus-ring ${
			active
				? 'border-primary-soft-border bg-primary-soft text-primary'
				: 'border-border bg-surface text-muted-foreground hover:bg-surface-muted'
		}`;
</script>

<svelte:head>
	<title>Макет карточки {data.variant.toUpperCase()} — LCT CRM</title>
</svelte:head>

{#if data.variant === 'a'}
	<VariantA {model} source={data.source} />
{:else}
	<VariantB {model} source={data.source} />
{/if}

<Breadcrumbs
	items={[
		{ label: 'UI-кит', href: resolve('/(app)/ui-kit') },
		{ label: `Макет карточки ${data.variant.toUpperCase()}` }
	]}
/>

<!-- Переключатель макета — полоса витрины, а не часть карточки: он стоит под
	крошками и в настоящую карточку не переезжает. -->
<nav
	class="-order-1 flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border bg-surface-muted px-4 py-2 sm:px-9"
	aria-label="Макеты карточки"
	data-slot="card-variant-switcher"
>
	<div class="flex flex-wrap items-center gap-1.5">
		<span class="text-xs text-muted-foreground">Вариант</span>
		{#each VARIANTS as variant (variant.key)}
			<a
				class={pill(data.variant === variant.key)}
				aria-current={data.variant === variant.key ? 'page' : undefined}
				href="{resolve('/(app)/ui-kit/card-[variant]', { variant: variant.key })}{page.url.search}"
			>
				{variant.label}
			</a>
		{/each}
	</div>
	<div class="flex flex-wrap items-center gap-1.5">
		<span class="text-xs text-muted-foreground">Образец</span>
		{#each data.samples as sample (sample.key)}
			<a
				class={pill(data.sample === sample.key)}
				aria-current={data.sample === sample.key ? 'true' : undefined}
				href={filterHref(page.url, 'sample', sample.key === 'b2b' ? '' : sample.key)}
			>
				{sample.label}
			</a>
		{/each}
	</div>
</nav>
