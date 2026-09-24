<script lang="ts">
	import { resolve } from '$app/paths';
	import type { ResolvedPathname } from '$app/types';
	import StatusBadge from '$lib/components/status-badge.svelte';
	import type { InteractionListItem } from '$lib/contracts/interactions';
	import { formatDate, formatNumber } from '$lib/format';

	/**
	 * Работа с организацией по пространствам сотрудника: в каждом — последние
	 * взаимодействия и ссылка на весь список. Пространства, куда сотрудник не
	 * включён, сюда не попадают: их работа ему не видна и в списке.
	 */
	let {
		organizationId,
		work
	}: {
		organizationId: string;
		/** `null` — нет права видеть взаимодействия. */
		work:
			readonly { key: string; name: string; total: number; items: InteractionListItem[] }[] | null;
	} = $props();

	const total = $derived(work?.reduce((sum, workspace) => sum + workspace.total, 0) ?? 0);

	/**
	 * Список пространства с фильтром «основная сторона — эта организация»: там
	 * не окажется записей, где организация — только плательщик. Путь
	 * известен, к нему добавлен только фильтр — так же собирает ссылки сам список.
	 */
	function listHref(workspace: string): ResolvedPathname {
		return `${resolve('/(app)/w/[workspace]/interactions', { workspace })}?org=${organizationId}` as ResolvedPathname;
	}
</script>

<!-- `data-tour` — метка подсказок: по ней тур находит работу с организацией. -->
<section
	class="flex min-w-0 flex-col gap-3"
	aria-labelledby="org-work-title"
	data-tour="organization-work"
>
	<div class="flex flex-wrap items-baseline justify-between gap-2">
		<h2 id="org-work-title" class="text-sm font-semibold">Взаимодействия</h2>
		{#if work !== null}
			<span class="text-xs text-muted-foreground">всего {formatNumber(total)}</span>
		{/if}
	</div>

	{#if work === null}
		<p class="text-sm text-muted-foreground">
			Взаимодействия закрыты правами: нужно право «Просмотр взаимодействий».
		</p>
	{:else if work.length === 0}
		<p class="text-sm text-muted-foreground">
			Вы не включены ни в одно пространство — работа с организацией здесь не показывается.
		</p>
	{:else}
		{#each work as workspace (workspace.key)}
			<div class="flex min-w-0 flex-col gap-1.5">
				<div class="flex flex-wrap items-center justify-between gap-2">
					<h3 class="text-xs font-semibold tracking-wide text-faint uppercase">
						{workspace.name}
					</h3>
					{#if workspace.total > 0}
						<a
							class="text-xs text-primary focus-ring hover:underline"
							href={listHref(workspace.key)}
						>
							{workspace.total > workspace.items.length
								? `Ещё ${formatNumber(workspace.total - workspace.items.length)} — в списке`
								: 'Открыть в списке'}
						</a>
					{/if}
				</div>
				{#if workspace.items.length === 0}
					<p class="text-sm text-faint">Записей нет</p>
				{:else}
					<ul class="flex flex-col divide-y divide-border">
						{#each workspace.items as item (item.id)}
							<li class="flex flex-wrap items-start justify-between gap-x-3 gap-y-1 py-2">
								<div class="min-w-0 flex-1 basis-56">
									<a
										class="text-sm font-medium break-words focus-ring hover:underline"
										href={resolve('/(app)/w/[workspace]/interactions/[id=uuid]', {
											workspace: workspace.key,
											id: item.id
										})}>{item.title}</a
									>
									<p class="text-xs text-muted-foreground">
										{item.stage?.name ?? 'без стадии'} · {item.ownerName}
									</p>
								</div>
								<div class="flex shrink-0 flex-wrap items-center gap-1.5">
									{#if item.status === 'completed'}
										<StatusBadge tone="success">Завершено</StatusBadge>
									{:else if item.status === 'cancelled'}
										<StatusBadge tone="neutral">Отменено</StatusBadge>
									{:else if item.isOverdue}
										<StatusBadge tone="danger" dot>Просрочено</StatusBadge>
									{:else if item.isPaused}
										<StatusBadge tone="neutral">На паузе</StatusBadge>
									{/if}
									<span class="text-xs text-faint tabular-nums">
										{formatDate(item.lastActivityAt)}
									</span>
								</div>
							</li>
						{/each}
					</ul>
				{/if}
			</div>
		{/each}
	{/if}
</section>
