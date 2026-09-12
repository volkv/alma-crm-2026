<script lang="ts">
	import type { ResolvedPathname } from '$app/types';
	import { STAGE_CATEGORIES, type StageCategory } from '$lib/contracts/interactions';
	import { formatNumber } from '$lib/format';
	import type { OverviewDistribution } from '$lib/server/interactions/overview';
	import { cn } from '$lib/utils';
	import { interactionsHref } from './links';

	/**
	 * Где стоит портфель: активные взаимодействия по смысловым группам стадий,
	 * одной полосой. Полоса отвечает на вопрос «мы ещё договариваемся или уже
	 * учим», поэтому группы нейтральны, а выделена ровно одна — та, в которой
	 * сейчас больше всего записей.
	 *
	 * Ни библиотеки, ни канвы: доли — это ширины, а ширины умеет flex.
	 */
	let {
		distribution,
		labels
	}: {
		distribution: OverviewDistribution;
		/** Подписи групп — те же, что в фильтре списка. */
		labels: Record<StageCategory, string>;
	} = $props();

	type Segment = {
		key: string;
		label: string;
		count: number;
		/** Доля в процентах — для подписи; ширину считает flex по `count`. */
		percent: number;
		leading: boolean;
		href: ResolvedPathname | null;
	};

	const segments = $derived<Segment[]>([
		...distribution.shares.map((share) => ({
			key: share.category,
			label: labels[share.category],
			count: share.count,
			percent: Math.round((share.count / distribution.total) * 100),
			leading: share.category === distribution.leading,
			href: interactionsHref({ status: 'active', stageCategory: share.category })
		})),
		...(distribution.stageless > 0
			? [
					{
						key: 'stageless',
						label: 'Без стадии',
						count: distribution.stageless,
						percent: Math.round((distribution.stageless / distribution.total) * 100),
						leading: false,
						href: null
					}
				]
			: [])
	]);

	const summary = $derived(
		segments
			.map((segment) => `${segment.label} — ${segment.count} из ${distribution.total}`)
			.join(', ')
	);

	const emptyGroups = $derived(STAGE_CATEGORIES.length - distribution.shares.length);
</script>

<div class="flex flex-col gap-3 px-4 py-4" data-slot="portfolio-bar">
	{#if distribution.total === 0}
		<p class="text-sm text-muted-foreground">
			Активных взаимодействий нет — распределять пока нечего.
		</p>
	{:else}
		<div
			class="flex h-2.5 w-full gap-0.5 overflow-hidden rounded-4xl"
			role="img"
			aria-label="Активные взаимодействия по группам стадий: {summary}"
		>
			{#each segments as segment (segment.key)}
				<span
					class={cn('basis-0 rounded-4xl', segment.leading ? 'bg-primary' : 'bg-border-strong')}
					style:flex-grow={segment.count}
				></span>
			{/each}
		</div>

		<ul class="flex flex-wrap gap-x-4 gap-y-2">
			{#each segments as segment (segment.key)}
				<li class="flex items-center gap-1.5 text-xs">
					<span
						class={cn(
							'size-2 shrink-0 rounded-full',
							segment.leading ? 'bg-primary' : 'bg-border-strong'
						)}
						aria-hidden="true"
					></span>
					{#if segment.href === null}
						<span class="text-muted-foreground">{segment.label}</span>
					{:else}
						<a
							href={segment.href}
							class="rounded-sm text-muted-foreground focus-ring hover:text-foreground hover:underline"
						>
							{segment.label}
						</a>
					{/if}
					<span class="font-medium">{formatNumber(segment.count)}</span>
					<span class="text-faint">{segment.percent}%</span>
				</li>
			{/each}
		</ul>

		{#if emptyGroups > 0}
			<p class="text-xs text-faint">
				Групп без активных взаимодействий: {formatNumber(emptyGroups)} — в полосе их нет.
			</p>
		{/if}
	{/if}
</div>
