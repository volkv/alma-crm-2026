<script lang="ts">
	import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
	import EmptyState from '$lib/components/empty-state.svelte';
	import StatusBadge, { type StatusTone } from '$lib/components/status-badge.svelte';
	import {
		MY_DAY_SECTIONS,
		type MyDayItem,
		type MyDayKind,
		type MyDaySection
	} from '$lib/contracts/my-day';
	import { interactionHref, interactionsHref, organizationHref } from './links';

	/**
	 * «Мой день»: что требует внимания сегодня, по разделам. Порядок разделов и
	 * строк считает сервер (`getMyDay`), и тот же список уходит утренней
	 * сводкой: письмо и экран обязаны говорить одно и то же.
	 *
	 * У каждой строки — ссылка и одна подсказка, что сделать. Помеха и «кого
	 * ждём» стоят здесь, а в письмо не уходят: это свободный текст сотрудников.
	 */
	let { sections }: { sections: readonly MyDaySection[] } = $props();

	const TONES: Record<MyDayKind, StatusTone> = {
		overdue: 'danger',
		due_soon: 'warning',
		blocker: 'warning',
		stuck: 'warning',
		waiting: 'neutral',
		application: 'accent',
		license: 'info'
	};

	function href(item: MyDayItem) {
		return item.target.type === 'interaction'
			? interactionHref(item.target.id)
			: organizationHref(item.target.id);
	}
</script>

{#if sections.length === 0}
	<EmptyState
		icon={CircleCheckIcon}
		title="Всё в порядке"
		description="Ни просрочки, ни сроков на сегодня и завтра, ни помех, ни долгого ожидания, ни новых заявок, ни лицензий к продлению."
	/>
{:else}
	<div class="divide-y divide-border">
		{#each sections as section (section.kind)}
			{@const meta = MY_DAY_SECTIONS[section.kind]}
			<section class="flex flex-col gap-2 px-4 py-3" aria-label={meta.title}>
				<div class="flex flex-wrap items-center gap-2">
					<StatusBadge tone={TONES[section.kind]}>{section.total}</StatusBadge>
					<h3 class="text-sm font-medium">{meta.title}</h3>
				</div>
				<ul class="flex flex-col gap-2">
					{#each section.items as item (item.target.id + item.title)}
						<li class="flex min-w-0 flex-col gap-0.5">
							<a
								href={href(item)}
								class="min-w-0 truncate rounded-sm text-sm focus-ring hover:underline"
							>
								{item.title}
							</a>
							<span class="text-xs text-muted-foreground">
								{#if item.organizationName !== null}{item.organizationName} ·
								{/if}{item.detail}
							</span>
							{#if item.note !== null}
								<span class="text-xs break-words text-muted-foreground">{item.note}</span>
							{/if}
							<span class="text-xs text-faint">→ {meta.action}</span>
						</li>
					{/each}
				</ul>
				{#if section.total > section.items.length}
					{#if section.kind === 'overdue'}
						<a
							href={interactionsHref({ status: 'active', overdue: true })}
							class="w-fit rounded-sm text-xs text-muted-foreground focus-ring hover:text-foreground hover:underline"
						>
							и ещё {section.total - section.items.length} — весь список просроченных
						</a>
					{:else}
						<span class="text-xs text-faint">и ещё {section.total - section.items.length}</span>
					{/if}
				{/if}
			</section>
		{/each}
	</div>
{/if}
