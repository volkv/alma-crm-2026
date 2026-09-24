<script lang="ts">
	import StatusBadge from '$lib/components/status-badge.svelte';
	import {
		EDUCATION_LEVEL_LABELS,
		ORGANIZATION_KIND_LABELS,
		ORGANIZATION_KIND_TONES
	} from '$lib/components/directory/labels';
	import type { OrganizationView } from '$lib/contracts/directory';
	import type { PartnerStatus } from './model';

	/**
	 * Верх карточки организации: пять фактов, по которым вуз узнают и решают,
	 * что с ним делать, — кто это, как его найти в реестре, где он, кто его ведёт
	 * и партнёр ли он. Остальные реквизиты — в колонке контекста.
	 */
	let {
		organization,
		responsibles,
		partner
	}: {
		organization: OrganizationView;
		/** Действующие назначения: сотрудник и направление (`null` — весь вуз). */
		responsibles: readonly { id: string; userFullName: string; directionName: string | null }[];
		partner: PartnerStatus;
	} = $props();
</script>

<!-- `data-tour` — метка подсказок: по ней тур находит ключевые факты. -->
<section
	class="flex min-w-0 flex-col gap-4 rounded-xl border border-border bg-surface p-4"
	aria-label="Ключевые факты"
	data-tour="organization-facts"
>
	<dl class="grid gap-x-6 gap-y-3 sm:grid-cols-2 xl:grid-cols-5">
		<div class="min-w-0">
			<dt class="text-xs text-muted-foreground">Вид</dt>
			<dd class="mt-0.5 flex flex-wrap items-center gap-1.5 text-sm">
				<StatusBadge tone={ORGANIZATION_KIND_TONES[organization.kind]}>
					{ORGANIZATION_KIND_LABELS[organization.kind]}
				</StatusBadge>
				{#if !organization.isActive}
					<StatusBadge tone="neutral" dot>В архиве</StatusBadge>
				{/if}
				{#if organization.educationLevel !== null}
					<span class="block w-full text-xs text-faint">
						{EDUCATION_LEVEL_LABELS[organization.educationLevel]}
					</span>
				{/if}
			</dd>
		</div>
		<div class="min-w-0">
			<dt class="text-xs text-muted-foreground">ИНН / ОГРН</dt>
			<dd class="mt-0.5 text-sm break-words tabular-nums">
				{#if organization.inn === null && organization.ogrn === null}
					<span class="text-faint">не указаны</span>
				{:else}
					<span class="font-medium">{organization.inn ?? '—'}</span>
					<span class="block text-xs text-muted-foreground">ОГРН {organization.ogrn ?? '—'}</span>
				{/if}
			</dd>
		</div>
		<div class="min-w-0">
			<dt class="text-xs text-muted-foreground">Регион</dt>
			<dd class="mt-0.5 text-sm break-words">
				{#if organization.region}
					<span class="font-medium">{organization.region}</span>
				{:else}
					<span class="text-faint">не указан</span>
				{/if}
				{#if organization.website}
					<a
						class="block truncate text-xs text-primary underline-offset-2 focus-ring hover:underline"
						href={organization.website}
						rel="external noreferrer noopener"
						target="_blank">{organization.website}</a
					>
				{/if}
			</dd>
		</div>
		<div class="min-w-0">
			<dt class="text-xs text-muted-foreground">Ответственные</dt>
			<dd class="mt-0.5 text-sm">
				{#if responsibles.length === 0}
					<StatusBadge tone="warning" dot>Никто не ведёт</StatusBadge>
				{:else}
					<ul class="flex flex-col gap-0.5">
						{#each responsibles as row (row.id)}
							<li class="break-words">
								<span class="font-medium">{row.userFullName}</span>
								<span class="text-xs text-muted-foreground">
									— {row.directionName ?? 'весь вуз'}
								</span>
							</li>
						{/each}
					</ul>
				{/if}
			</dd>
		</div>
		<div class="min-w-0">
			<dt class="text-xs text-muted-foreground">Статус партнёра</dt>
			<dd class="mt-0.5 flex flex-col gap-0.5 text-sm">
				<StatusBadge tone={partner.tone} dot>{partner.label}</StatusBadge>
				{#if partner.detail}
					<span class="text-xs break-words text-muted-foreground">{partner.detail}</span>
				{/if}
			</dd>
		</div>
	</dl>
</section>
