<script lang="ts" module>
	import type { ResolvedPathname } from '$app/types';

	/**
	 * One step of the trail. `href` is what `resolve()` returns, so a caller
	 * cannot accidentally hand over a path that does not exist.
	 */
	export type Breadcrumb = {
		label: string;
		href?: ResolvedPathname;
	};
</script>

<script lang="ts">
	import type { Snippet } from 'svelte';
	import * as BreadcrumbUi from '$lib/components/ui/breadcrumb/index.js';

	/**
	 * The top of a page: where the user is, what the page is, and what can be
	 * done to it. Every page inside the app shell starts with one — it owns the
	 * `<h1>`, so pages must not render a second one.
	 */
	let {
		title,
		description,
		breadcrumbs = [],
		actions
	}: {
		title: string;
		description?: string;
		/** Ancestors only; the current page is added as the last, unlinked step. */
		breadcrumbs?: readonly Breadcrumb[];
		/** Buttons for the page as a whole, aligned to the right of the title. */
		actions?: Snippet;
	} = $props();
</script>

<header class="flex flex-col gap-3 border-b border-border bg-surface px-4 py-4 sm:px-6">
	{#if breadcrumbs.length > 0}
		<BreadcrumbUi.Root>
			<BreadcrumbUi.List>
				{#each breadcrumbs as crumb (crumb.label)}
					<BreadcrumbUi.Item>
						{#if crumb.href}
							<BreadcrumbUi.Link href={crumb.href}>{crumb.label}</BreadcrumbUi.Link>
						{:else}
							<BreadcrumbUi.Page>{crumb.label}</BreadcrumbUi.Page>
						{/if}
					</BreadcrumbUi.Item>
					<BreadcrumbUi.Separator />
				{/each}
				<BreadcrumbUi.Item>
					<BreadcrumbUi.Page>{title}</BreadcrumbUi.Page>
				</BreadcrumbUi.Item>
			</BreadcrumbUi.List>
		</BreadcrumbUi.Root>
	{/if}

	<div class="flex flex-wrap items-start justify-between gap-3">
		<div class="min-w-0">
			<h1 class="truncate text-xl font-semibold tracking-tight">{title}</h1>
			{#if description}
				<p class="mt-1 text-sm text-muted-foreground">{description}</p>
			{/if}
		</div>
		{#if actions}
			<!-- No `shrink-0` here on purpose. With it the row keeps its full
			     one-line width even after wrapping under the title, so a card
			     that shows a status, a download and a next step pushes the whole
			     document sideways on a phone. Allowed to shrink, the row never
			     goes below the widest button — that is its automatic minimum
			     size — and the rest wrap onto further lines. -->
			<div class="flex flex-wrap items-center gap-2">
				{@render actions()}
			</div>
		{/if}
	</div>
</header>
