<script lang="ts">
	import PlusIcon from '@lucide/svelte/icons/plus';
	import { resolve } from '$app/paths';
	import { Button } from '$lib/components/ui/button/index.js';
	import InlineHint from '$lib/components/inline-hint.svelte';
	import StatusBadge from '$lib/components/status-badge.svelte';
	import ContextSection from '$lib/components/interaction-card/context-section.svelte';
	import { AFFILIATION_ROLE_LABELS } from '$lib/components/directory/labels';
	import type { AffiliationView } from '$lib/contracts/directory';
	import { formatDate } from '$lib/format';

	/**
	 * Контакты организации в колонке контекста: кто, кем работает, как с ним
	 * связаться. Действующие — сверху списком, закрытые полномочия — свёрнуты:
	 * они нужны истории, а не сегодняшней переписке.
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

	const current = $derived(affiliations.filter((row) => row.validTo === null));
	const past = $derived(affiliations.filter((row) => row.validTo !== null));
	const masked = $derived(affiliations.some((row) => row.person.contactsMasked));

	function fullName(row: AffiliationView) {
		return [row.person.lastName, row.person.firstName, row.person.middleName]
			.filter((part) => part !== null && part !== '')
			.join(' ');
	}
</script>

{#snippet person(row: AffiliationView)}
	<li class="flex flex-col gap-0.5 py-2 text-sm">
		<div class="flex flex-wrap items-center gap-1.5">
			<a
				class="font-medium break-words underline-offset-2 focus-ring hover:underline"
				href={resolve('/(app)/people/[id=uuid]', { id: row.person.id })}>{fullName(row)}</a
			>
			{#if row.isPrimary}
				<StatusBadge tone="accent">основной</StatusBadge>
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
		{#if canWrite && row.validTo === null}
			<Button variant="ghost" size="sm" class="-ml-2 w-fit" onclick={() => onclose(row)}>
				Закрыть полномочия
			</Button>
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
					{#each current as row (row.id)}
						{@render person(row)}
					{/each}
				</ul>
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
