<script lang="ts">
	import EllipsisIcon from '@lucide/svelte/icons/ellipsis';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import { resolve } from '$app/paths';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
	import InlineHint from '$lib/components/inline-hint.svelte';
	import StatusBadge from '$lib/components/status-badge.svelte';
	import ContextSection from '$lib/components/interaction-card/context-section.svelte';
	import { AFFILIATION_ROLE_LABELS } from '$lib/components/directory/labels';
	import type { AffiliationRoleKind, AffiliationView } from '$lib/contracts/directory';
	import { formatDate } from '$lib/format';
	import { personFullName } from './model';

	/**
	 * Контакты организации в колонке контекста: кто, кем работает, как с ним
	 * связаться. Действующие — сверху списком, закрытые полномочия — свёрнуты:
	 * они нужны истории, а не сегодняшней переписке.
	 *
	 * Сразу видны первые пять действующих: основной, затем те, кто решает, затем
	 * рабочие контакты. У крупного вуза их десятки, и полный список в колонке
	 * контекста на телефоне отодвигал площадки на несколько экранов.
	 */
	let {
		organizationId,
		affiliations,
		siteNames,
		canRead,
		canWrite,
		onclose
	}: {
		organizationId: string;
		affiliations: readonly AffiliationView[];
		siteNames: ReadonlyMap<string, string>;
		canRead: boolean;
		canWrite: boolean;
		/** Закрыть полномочия: подтверждение и форма — у страницы. */
		onclose: (row: AffiliationView) => void;
	} = $props();

	/** Сколько действующих контактов видно без раскрытия. */
	const FOLDED = 5;

	/** Порядок ролей в списке: ЛПР выше рабочих контактов, «другое» — в конце. */
	const ROLE_RANK: Record<AffiliationRoleKind, number> = {
		rector: 0,
		vice_rector: 0,
		dean: 0,
		head_of_department: 0,
		coordinator: 1,
		teacher: 1,
		vendor_contact: 1,
		other: 2
	};

	const current = $derived(
		affiliations
			.filter((row) => row.validTo === null)
			.toSorted(
				(left, right) =>
					Number(right.isPrimary) - Number(left.isPrimary) ||
					ROLE_RANK[left.roleKind] - ROLE_RANK[right.roleKind]
			)
	);
	let expanded = $state(false);
	const shown = $derived(expanded ? current : current.slice(0, FOLDED));
	const past = $derived(affiliations.filter((row) => row.validTo !== null));
	const masked = $derived(affiliations.some((row) => row.person.contactsMasked));
</script>

{#snippet person(row: AffiliationView)}
	<li class="flex flex-col gap-0.5 py-2 text-sm">
		<div class="flex items-start gap-1.5">
			<div class="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
				<a
					class="font-medium break-words underline-offset-2 focus-ring hover:underline"
					href={resolve('/(app)/people/[id=uuid]', { id: row.person.id })}>{personFullName(row)}</a
				>
				{#if row.isPrimary}
					<StatusBadge tone="accent">основной</StatusBadge>
				{/if}
			</div>
			<!-- Закрытие полномочий — редкое действие с подтверждением: в меню
				строки, а не кнопкой под каждым контактом. -->
			{#if canWrite && row.validTo === null}
				<DropdownMenu.Root>
					<DropdownMenu.Trigger>
						{#snippet child({ props })}
							<Button
								{...props}
								variant="ghost"
								size="icon-sm"
								class="-my-1 shrink-0"
								aria-label="Действия с контактом {personFullName(row)}"
							>
								<EllipsisIcon aria-hidden="true" />
							</Button>
						{/snippet}
					</DropdownMenu.Trigger>
					<DropdownMenu.Content align="end" class="w-52">
						<DropdownMenu.Item onSelect={() => onclose(row)}>Закрыть полномочия</DropdownMenu.Item>
					</DropdownMenu.Content>
				</DropdownMenu.Root>
			{/if}
		</div>
		<p class="break-words">{row.position}</p>
		<p class="text-xs text-muted-foreground">
			{AFFILIATION_ROLE_LABELS[row.roleKind]}{row.siteId !== null && siteNames.has(row.siteId)
				? ` · ${siteNames.get(row.siteId)}`
				: ''} · с {formatDate(row.validFrom)}{row.validTo === null
				? ''
				: ` по ${formatDate(row.validTo)}`}
		</p>
		{#if row.person.email || row.person.phone}
			<p class="text-xs break-all text-muted-foreground">
				{[row.person.email, row.person.phone].filter(Boolean).join(' · ')}
			</p>
		{/if}
	</li>
{/snippet}

<!-- `data-tour` — метка подсказок: по ней тур находит контакты вуза. -->
<div data-tour="organization-contacts">
	<ContextSection title="Контакты">
		{#snippet action()}
			{#if canWrite}
				<Button
					variant="ghost"
					size="sm"
					href={resolve('/(app)/organizations/[id=uuid]/affiliations/new', { id: organizationId })}
				>
					<PlusIcon aria-hidden="true" />
					Добавить
				</Button>
			{/if}
		{/snippet}

		{#if !canRead}
			<p class="text-sm text-muted-foreground">
				Контакты закрыты правами: нужно право «Просмотр людей и их ролей в организациях».
			</p>
		{:else if current.length === 0 && past.length === 0}
			<p class="text-sm text-muted-foreground">
				Контактов пока нет. Добавьте человека, с которым идёт переписка, — или возьмите его из
				«Сведений» с сайта вуза.
			</p>
		{:else}
			{#if masked}
				<InlineHint tone="info">
					Почта и телефон закрыты: полные контакты видны с правом «Просмотр контактов людей без
					маскирования».
				</InlineHint>
			{/if}
			{#if current.length === 0}
				<p class="text-sm text-muted-foreground">Действующих контактов нет.</p>
			{:else}
				<ul class="flex flex-col divide-y divide-border">
					{#each shown as row (row.id)}
						{@render person(row)}
					{/each}
				</ul>
				{#if current.length > FOLDED}
					<button
						type="button"
						class="w-fit cursor-pointer rounded-sm text-xs text-link focus-ring hover:text-link-hover hover:underline"
						aria-expanded={expanded}
						onclick={() => (expanded = !expanded)}
					>
						{expanded ? 'Свернуть' : `Все контакты — ${current.length}`}
					</button>
				{/if}
			{/if}
			{#if past.length > 0}
				<details>
					<summary class="cursor-pointer text-xs text-link hover:text-link-hover">
						Закрытые полномочия ({past.length})
					</summary>
					<ul class="flex flex-col divide-y divide-border">
						{#each past as row (row.id)}
							{@render person(row)}
						{/each}
					</ul>
				</details>
			{/if}
		{/if}
	</ContextSection>
</div>
