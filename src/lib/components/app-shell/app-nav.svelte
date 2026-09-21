<script lang="ts">
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import SparklesIcon from '@lucide/svelte/icons/sparkles';
	import { groupedSections } from '$lib/nav';
	import { getOnboardingTour } from '$lib/onboarding/tour.svelte';
	import { cn } from '$lib/utils';
	import type { NavLink } from './nav-links';

	/**
	 * The list of sections under their group headings. Shared by the desktop
	 * sidebar and the sheet on a phone, so a section is described once and looks
	 * the same in both.
	 */
	let {
		links,
		collapsed = false,
		onnavigate
	}: {
		/** Sections this user may open; the shell filters them by permission. */
		links: readonly NavLink[];
		/** Icons only; the label moves into the tooltip, the headings into rules. */
		collapsed?: boolean;
		/** Called on every link click — the sheet uses it to close itself. */
		onnavigate?: () => void;
	} = $props();

	// Заголовок группы подписывает её список через `aria-labelledby`, а меню
	// стоит на странице дважды — в боковой панели и в выдвижной на телефоне, —
	// поэтому идентификатор у каждого экземпляра свой.
	const uid = $props.id();

	const groups = $derived(groupedSections(links));

	/**
	 * Полный обход системы — не адрес, а действие, поэтому в списке
	 * разделов (`$lib/nav`) его нет: он встаёт в разметке сразу под «Журналом»,
	 * в той же группе, что и справка: сюда ходят по поводу, а не каждый день.
	 * Роли без тура пункта не видят: меню не предлагает действие, которое
	 * ничего не делает. Журнал закрыт правом, и тому, кому он не
	 * открыт, пункт встаёт после «Справки» — концом той же группы.
	 */
	const tour = getOnboardingTour();

	const auditHref = resolve('/(app)/audit');
	const helpHref = resolve('/(app)/help');
	/** Пункт, после которого встаёт тур; `null` — показывать его нечего. */
	const tourAfter = $derived.by(() => {
		if (tour.fullLength === 0) {
			return null;
		}

		const others = links.filter((link) => link.href === auditHref || link.href === helpHref);

		return others[0]?.href ?? null;
	});
</script>

<nav class="flex flex-col p-2" aria-label="Разделы">
	{#each groups as group, index (group.id)}
		{@const headingId = `${uid}-${group.id}`}
		<!-- В свёрнутом меню подписи негде стоять: группы делит тонкая линия, а
			название группы остаётся только для читалки. Первая группа идёт сразу
			под шапкой — линия над ней удвоила бы границу шапки. -->
		{#if index > 0}
			<div
				class={cn('my-2 border-t border-border', collapsed ? 'mx-2' : 'mx-2.5')}
				aria-hidden="true"
			></div>
		{/if}
		<div role="group" aria-labelledby={headingId} class="flex flex-col gap-0.5">
			<!-- Заголовок группы набран не так, как её пункты, а во всём сразу:
				мельче, жирнее и контрастнее. Мельче и жирнее — чтобы не читался
				как ещё один пункт, который почему-то нельзя нажать; контрастнее —
				потому что бледный он тонул в списке, особенно в тёмной теме.
				`foreground` — самый сильный текстовый токен, и он сам держит обе
				темы: в светлой почти чёрный, в тёмной почти белый. -->
			<p
				id={headingId}
				class={collapsed
					? 'sr-only'
					: 'px-2.5 pt-1 pb-1.5 text-xs font-semibold tracking-wide text-foreground'}
			>
				{group.label}
			</p>
			{#each group.sections as link (link.href)}
				{@const Icon = link.icon}
				{@const active =
					page.url.pathname === link.href || page.url.pathname.startsWith(`${link.href}/`)}
				<a
					href={link.href}
					title={collapsed ? link.label : undefined}
					aria-current={active ? 'page' : undefined}
					onclick={onnavigate}
					class={cn(
						'flex h-control items-center gap-2.5 rounded-md px-2.5 text-sm focus-ring transition-colors',
						collapsed && 'justify-center px-0',
						active
							? 'bg-primary-soft font-medium text-primary'
							: 'text-muted-foreground hover:bg-surface-muted hover:text-foreground'
					)}
				>
					<Icon class="size-4 shrink-0" aria-hidden="true" />
					{#if !collapsed}
						<span class="truncate">{link.label}</span>
					{/if}
				</a>
				{#if link.href === tourAfter}
					<button
						type="button"
						title={collapsed ? 'Тур по системе' : undefined}
						onclick={() => {
							tour.startFull();
							onnavigate?.();
						}}
						class={cn(
							'flex h-control items-center gap-2.5 rounded-md px-2.5 text-sm text-muted-foreground focus-ring transition-colors hover:bg-surface-muted hover:text-foreground',
							collapsed && 'justify-center px-0'
						)}
					>
						<SparklesIcon class="size-4 shrink-0" aria-hidden="true" />
						{#if !collapsed}
							<span class="truncate">Тур по системе</span>
						{/if}
					</button>
				{/if}
			{/each}
		</div>
	{/each}
</nav>
