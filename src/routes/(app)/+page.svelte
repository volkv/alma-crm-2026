<script lang="ts">
	import LayoutDashboardIcon from '@lucide/svelte/icons/layout-dashboard';
	import { resolve } from '$app/paths';
	import { Button } from '$lib/components/ui/button/index.js';
	import EmptyState from '$lib/components/empty-state.svelte';
	import PageHeader from '$lib/components/page-header.svelte';
</script>

<svelte:head>
	<title>LCT CRM</title>
</svelte:head>

<PageHeader title="LCT CRM" description="Система контроля взаимодействия с учебными заведениями" />

<div class="p-4 sm:p-6">
	<div class="rounded-lg border border-border bg-surface">
		<EmptyState
			icon={LayoutDashboardIcon}
			title="Разделы появятся по мере готовности"
			description="Слева — карта системы. Разделы открываются по мере того, как их вводят в работу."
		>
			{#snippet action()}
				<Button variant="outline" href={resolve('/ui-kit')}>Открыть UI-кит</Button>
			{/snippet}
		</EmptyState>
	</div>
</div>
