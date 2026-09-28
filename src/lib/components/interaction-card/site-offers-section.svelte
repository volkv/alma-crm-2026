<script lang="ts">
	import type { Snippet } from 'svelte';
	import GlobeIcon from '@lucide/svelte/icons/globe';
	import LoaderIcon from '@lucide/svelte/icons/loader-2';
	import type { SiteSourceView } from '$lib/contracts/organization-card';
	import { formatDate } from '$lib/format';
	import { siteSourceMessage, type SiteOfferKind } from './site-offers';

	/**
	 * Блок «С сайта вуза» под списком того, что уже есть в справочнике.
	 *
	 * Отделён от справочника рамкой и заголовком: сотрудник должен видеть, где
	 * наши данные, а где — прочитанные с сайта и ещё не занесённые, которые
	 * появятся в справочнике только по кнопке «Импортировать». Пока сайт
	 * читается, сайт пуст или его нет, блок говорит об этом одной строкой, а
	 * список не показывает.
	 */
	let {
		source,
		kind,
		total,
		shown,
		exhausted,
		hint,
		error = null,
		children
	}: {
		source: SiteSourceView;
		kind: SiteOfferKind;
		/** Сколько записей такого вида на сайте всего, вместе с уже заведёнными. */
		total: number;
		/** Сколько осталось предложить. */
		shown: number;
		/** Повторные вопросы кончились, а сайт всё ещё читается. */
		exhausted: boolean;
		/** Что будет по «Импортировать» — одной фразой. */
		hint: string;
		error?: string | null;
		children: Snippet;
	} = $props();

	const message = $derived(siteSourceMessage(source, kind, { total, shown, exhausted }));
</script>

<section
	class="flex flex-col rounded-md border border-dashed border-border"
	aria-label="С сайта вуза"
	data-slot="site-offers"
>
	<div class="flex flex-col gap-0.5 rounded-t-md bg-surface-muted px-3 py-2">
		<p class="flex items-center gap-1.5 text-xs font-medium">
			<GlobeIcon class="size-3.5" aria-hidden="true" />
			С сайта вуза
			{#if source.fetchedAt !== null}
				<span class="font-normal text-muted-foreground"
					>· прочитан {formatDate(source.fetchedAt)}</span
				>
			{/if}
		</p>
		<p class="text-xs text-muted-foreground">{hint}</p>
	</div>

	{#if error !== null}
		<p class="px-3 py-2 text-xs text-destructive" role="alert">{error}</p>
	{/if}

	{#if message !== null}
		<p class="flex items-center gap-1.5 px-3 py-2 text-xs text-muted-foreground" aria-live="polite">
			{#if source.state === 'warming' && !exhausted}
				<LoaderIcon class="size-3.5 animate-spin" aria-hidden="true" />
			{/if}
			{message}
		</p>
	{:else}
		{@render children()}
	{/if}
</section>
