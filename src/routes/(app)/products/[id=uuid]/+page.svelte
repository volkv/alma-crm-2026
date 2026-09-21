<script lang="ts">
	import { resolve } from '$app/paths';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import { Button } from '$lib/components/ui/button/index.js';
	import Flash from '$lib/components/directory/flash.svelte';
	import {
		LIFECYCLE_STATUS_LABELS,
		LIFECYCLE_STATUS_TONES
	} from '$lib/components/directory/labels';
	import KeyValue from '$lib/components/key-value.svelte';
	import KeyValueRow from '$lib/components/key-value-row.svelte';
	import Breadcrumbs from '$lib/components/breadcrumbs.svelte';
	import Header from '$lib/components/header.svelte';
	import StatusBadge from '$lib/components/status-badge.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<svelte:head><title>{data.product.code} — LCT CRM</title></svelte:head>

<Flash messages={{ created: 'Продукт создан', updated: 'Изменения сохранены' }} />

<Header title={data.product.name} description={data.product.code}>
	{#snippet actions()}
		{#if data.canWrite}
			<Button
				variant="outline"
				href={resolve('/(app)/products/[id=uuid]/edit', { id: data.product.id })}
			>
				<PencilIcon aria-hidden="true" />
				Изменить
			</Button>
		{/if}
	{/snippet}
</Header>

<Breadcrumbs
	items={[{ label: 'Продукты', href: resolve('/(app)/products') }, { label: data.product.name }]}
/>

<div class="flex flex-col gap-4 p-4 sm:p-6">
	<section
		class="rounded-lg border border-border bg-surface p-4 sm:p-6"
		data-tour="product-summary"
	>
		<h2 class="mb-4 text-sm font-semibold">Продукт</h2>
		<KeyValue>
			<KeyValueRow label="Код" value={data.product.code} />
			<KeyValueRow label="Состояние">
				<StatusBadge tone={LIFECYCLE_STATUS_TONES[data.product.status]} dot>
					{LIFECYCLE_STATUS_LABELS[data.product.status]}
				</StatusBadge>
			</KeyValueRow>
			<KeyValueRow label="Правообладатель">
				{#if data.vendor}
					<a
						class="underline underline-offset-2 focus-ring"
						href={resolve('/(app)/organizations/[id=uuid]', { id: data.vendor.id })}
						>{data.vendor.label}</a
					>
				{:else}
					<span class="text-faint">—</span>
				{/if}
			</KeyValueRow>
		</KeyValue>

		{#if data.product.description}
			<p class="mt-4 text-sm whitespace-pre-line">{data.product.description}</p>
		{/if}
	</section>
</div>
