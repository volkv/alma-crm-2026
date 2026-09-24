<script lang="ts">
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';
	import StatusBadge from '$lib/components/status-badge.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import { MY_DAY_SECTIONS, type MyDayItem, type MyDaySection } from '$lib/contracts/my-day';
	import { formatNumber } from '$lib/format';
	import { interactionHref, interactionsHref, organizationHref } from './links';
	import { MY_DAY_KIND_VIEW, myDayAnchor } from './my-day-kinds';

	/**
	 * Карточка раздела «Моего дня»: заголовок со счётчиком, первые строки и
	 * ссылка на остальное.
	 *
	 * Подсказка «что сделать» у раздела одна и стоит под заголовком: у всех
	 * строк раздела она одинакова, и повтор её в каждой строке превращал список
	 * в стену одинакового текста. У строки остаётся своё — название, почему она
	 * здесь и срок (`detail` сервера) и одна кнопка.
	 *
	 * Кнопка строки — «Открыть», а не глагол раздела («Сдвинуть», «Снять»):
	 * она ведёт в карточку, где действие и выбирают, и глагол обещал бы то,
	 * чего нажатие не делает.
	 */
	let { section }: { section: MyDaySection } = $props();

	/** Сколько строк видно сразу: четыре карточки по три строки — один экран ноутбука. */
	const FOLDED = 3;

	const meta = $derived(MY_DAY_SECTIONS[section.kind]);
	const view = $derived(MY_DAY_KIND_VIEW[section.kind]);

	let expanded = $state(false);

	const shown = $derived(expanded ? section.items : section.items.slice(0, FOLDED));

	/**
	 * Полный набор есть в списке только у просрочки — у него фильтр
	 * `overdue`. У остальных разделов списка с таким отбором нет, поэтому
	 * карточка раскрывается на месте до всех строк, что прислал сервер
	 * (`MY_DAY_SECTION_LIMIT`), и честно говорит, сколько осталось за ними.
	 */
	const listHref = $derived(
		section.kind === 'overdue' ? interactionsHref({ status: 'active', overdue: true }) : null
	);
	const canExpand = $derived(section.items.length > FOLDED);
	/** Строки, которых сервер не прислал: их видно только в списке или не видно вовсе. */
	const beyond = $derived(section.total - section.items.length);

	/**
	 * Причина и срок строкой сервера, а за ними сторона — если её ещё не видно
	 * в названии. Название взаимодействия обычно и начинается с вуза, и
	 * «СПбПУ: …» с «· СПбПУ» в конце говорят одно и то же дважды.
	 */
	function reason(item: MyDayItem): string {
		const party = item.organizationName;

		return party === null || item.title.includes(party) ? item.detail : `${item.detail} · ${party}`;
	}

	function href(item: MyDayItem) {
		return item.target.type === 'interaction'
			? interactionHref(item.target.id)
			: organizationHref(item.target.id);
	}
</script>

<section
	id={myDayAnchor(section.kind)}
	tabindex="-1"
	class="flex min-w-0 scroll-mt-24 flex-col rounded-xl border border-border bg-surface outline-none target:border-link"
	aria-labelledby="{myDayAnchor(section.kind)}-title"
	data-slot="day-card"
	data-kind={section.kind}
>
	<header class="flex items-start gap-2 border-b border-border px-4 py-2.5">
		<div class="min-w-0 flex-1">
			<h3 id="{myDayAnchor(section.kind)}-title" class="section-title">{meta.title}</h3>
			<p class="mt-0.5 text-xs text-muted-foreground">{meta.action}</p>
		</div>
		<StatusBadge tone={view.tone} class="mt-0.5">{formatNumber(section.total)}</StatusBadge>
	</header>

	<ul class="divide-y divide-border">
		{#each shown as item (item.target.id + item.title)}
			<li class="flex items-center gap-3 px-4 py-2">
				<div class="flex min-w-0 flex-1 flex-col gap-0.5">
					<a
						href={href(item)}
						class="line-clamp-2 rounded-sm text-sm font-medium break-words focus-ring hover:text-link hover:underline"
					>
						{item.title}
					</a>
					<span class="line-clamp-2 text-xs break-words text-muted-foreground">
						{reason(item)}
					</span>
					{#if item.note !== null}
						<span class="line-clamp-1 text-xs break-words text-faint" title={item.note}>
							{item.note}
						</span>
					{/if}
				</div>
				<Button
					variant="outline"
					size="xs"
					href={href(item)}
					class="shrink-0"
					aria-label="Открыть: {item.title}"
				>
					Открыть
					<ArrowRightIcon data-icon="inline-end" aria-hidden="true" />
				</Button>
			</li>
		{/each}
	</ul>

	{#if (listHref !== null && section.total > shown.length) || canExpand || beyond > 0}
		<footer class="mt-auto flex items-center gap-3 border-t border-border px-4 py-2 text-xs">
			{#if listHref !== null}
				<a
					href={listHref}
					class="rounded-sm text-link focus-ring hover:text-link-hover hover:underline"
				>
					Все {formatNumber(section.total)} в списке
				</a>
			{:else}
				{#if canExpand}
					<button
						type="button"
						class="cursor-pointer rounded-sm text-link focus-ring hover:text-link-hover hover:underline"
						aria-expanded={expanded}
						onclick={() => (expanded = !expanded)}
					>
						{expanded ? 'Свернуть' : `Ещё ${formatNumber(section.items.length - FOLDED)}`}
					</button>
				{/if}
				{#if beyond > 0 && (expanded || !canExpand)}
					<span class="text-faint">
						Показаны первые {formatNumber(section.items.length)} из {formatNumber(section.total)}
					</span>
				{/if}
			{/if}
		</footer>
	{/if}
</section>
