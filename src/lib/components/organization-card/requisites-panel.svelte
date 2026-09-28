<script lang="ts">
	import { LinkPreview } from 'bits-ui';
	import CopyIcon from '@lucide/svelte/icons/copy';
	import InfoIcon from '@lucide/svelte/icons/info';
	import { MediaQuery } from 'svelte/reactivity';
	import CopyableValue from '$lib/components/copyable-value.svelte';
	import ContextSection from '$lib/components/interaction-card/context-section.svelte';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import { copyText } from '$lib/clipboard';
	import type { OrganizationView } from '$lib/contracts/directory';
	import type { FieldSource, PassportField, PassportVia } from '$lib/contracts/enrichment';
	import { formatDate, formatDateTime } from '$lib/format';
	import { PASSPORT_FIELD_LABELS, PASSPORT_SOURCE_LABELS } from './model';

	/**
	 * Реквизиты организации — полное наименование, ИНН, КПП, ОГРН — и откуда
	 * они взялись. Происхождение — из журнала: последняя приёмка полей из паспорта организации называет
	 * поля, источник и дату ответа источника. Как организация появилась —
	 * загрузкой каталога или вручную — сказано всегда, если это записано.
	 * Происхождение — служебная справка: с мышью она всплывает по наведению на
	 * «i» у заголовка, на сенсорном экране открывается окном по касанию.
	 */
	let {
		organization,
		passportApplied,
		origin
	}: {
		organization: OrganizationView;
		origin:
			| { kind: 'import'; at: Date }
			| { kind: 'manual'; at: Date; actorLabel: string }
			| { kind: 'individual'; at: Date }
			| null;
		passportApplied: {
			occurredAt: Date;
			actorLabel: string;
			provenance: {
				field: PassportField;
				source: FieldSource;
				fetchedAt: string;
				via: PassportVia;
			}[];
		} | null;
	} = $props();

	/** Принятые поля по источнику: «ЕГРЮЛ: ИНН, ОГРН — ответ от …». */
	const bySource = $derived.by(() => {
		const groups: {
			key: string;
			source: string;
			fields: string[];
			fetchedAt: string;
			via: PassportVia;
		}[] = [];

		for (const entry of passportApplied?.provenance ?? []) {
			const key = `${entry.source}/${entry.via}`;
			let group = groups.find((known) => known.key === key);

			if (group === undefined) {
				group = {
					key,
					source: PASSPORT_SOURCE_LABELS[entry.source],
					fields: [],
					fetchedAt: entry.fetchedAt,
					via: entry.via
				};
				groups.push(group);
			}

			group.fields.push(PASSPORT_FIELD_LABELS[entry.field]);
		}

		return groups;
	});

	const canHover = new MediaQuery('(hover: hover) and (pointer: fine)', true);
	let sourceOpen = $state(false);

	const codes = $derived([
		{ label: 'ИНН', value: organization.inn },
		{ label: 'КПП', value: organization.kpp },
		{ label: 'ОГРН', value: organization.ogrn }
	]);

	/** Все реквизиты одним текстом — для письма или договора, пустые поля пропускаются. */
	function copyAll() {
		const lines = [`Полное наименование: ${organization.legalName}`];

		for (const code of codes) {
			if (code.value !== null) lines.push(`${code.label}: ${code.value}`);
		}

		void copyText(lines.join('\n'), 'Реквизиты скопированы');
	}

	const iconButton =
		'inline-flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring';
</script>

{#snippet sourceDetails()}
	<div class="flex flex-col gap-2">
		{#if origin === null}
			<p class="text-sm text-muted-foreground">Как организация попала в справочник, не записано.</p>
		{:else if origin.kind === 'import'}
			<p class="text-sm">Импорт каталога от {formatDateTime(origin.at)}.</p>
		{:else if origin.kind === 'individual'}
			<p class="text-sm">Заведена вместе с карточкой человека {formatDateTime(origin.at)}.</p>
		{:else}
			<p class="text-sm">
				Введено вручную: {origin.actorLabel}, {formatDateTime(origin.at)}.
			</p>
		{/if}
		{#if passportApplied !== null}
			<ul class="flex flex-col gap-1.5 text-sm">
				{#each bySource as group (group.key)}
					<li class="break-words">
						<span class="font-medium">{group.source}</span>: {group.fields.join(', ')}
						<span class="block text-xs text-muted-foreground">
							ответ источника от {formatDateTime(group.fetchedAt)}{group.via === 'snapshot'
								? ', загружен снимком'
								: ''}
						</span>
					</li>
				{/each}
			</ul>
			<p class="text-xs text-faint">
				Приняты {formatDateTime(passportApplied.occurredAt)}, {passportApplied.actorLabel}.
			</p>
		{/if}
	</div>
{/snippet}

{#snippet titleAside()}
	{#if canHover.current}
		<LinkPreview.Root openDelay={150} closeDelay={150}>
			<LinkPreview.Trigger>
				{#snippet child({ props })}
					<button {...props} type="button" class={iconButton} aria-label="Источник реквизитов">
						<InfoIcon class="size-3.5" />
					</button>
				{/snippet}
			</LinkPreview.Trigger>
			<LinkPreview.Portal>
				<LinkPreview.Content
					side="bottom"
					align="start"
					sideOffset={4}
					class="z-50 flex w-80 flex-col gap-2 rounded-md bg-popover p-4 text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-hidden"
				>
					<p class="section-overline">Источник реквизитов</p>
					{@render sourceDetails()}
				</LinkPreview.Content>
			</LinkPreview.Portal>
		</LinkPreview.Root>
	{:else}
		<button
			type="button"
			class={iconButton}
			aria-label="Источник реквизитов"
			onclick={() => (sourceOpen = true)}
		>
			<InfoIcon class="size-3.5" />
		</button>
	{/if}
	<button
		type="button"
		class={iconButton}
		aria-label="Копировать все реквизиты"
		title="Копировать все реквизиты"
		onclick={copyAll}
	>
		<CopyIcon class="size-3.5" />
	</button>
{/snippet}

<ContextSection title="Реквизиты" {titleAside}>
	<dl class="flex flex-col gap-2 text-sm">
		<div class="min-w-0">
			<dt class="text-xs text-muted-foreground">Полное наименование</dt>
			<dd><CopyableValue value={organization.legalName} label="Полное наименование" /></dd>
		</div>
		<div class="flex flex-wrap gap-x-6 gap-y-2">
			{#each codes as code (code.label)}
				<div>
					<dt class="text-xs text-muted-foreground">{code.label}</dt>
					<dd class="tabular-nums"><CopyableValue value={code.value} label={code.label} /></dd>
				</div>
			{/each}
			<div>
				<dt class="text-xs text-muted-foreground">Обновлено</dt>
				<dd>{formatDate(organization.updatedAt)}</dd>
			</div>
		</div>
	</dl>
	{#if organization.notes}
		<p class="text-sm break-words whitespace-pre-line text-muted-foreground">
			{organization.notes}
		</p>
	{/if}
</ContextSection>

{#if !canHover.current}
	<Dialog.Root bind:open={sourceOpen}>
		<Dialog.Content>
			<Dialog.Header>
				<Dialog.Title>Источник реквизитов</Dialog.Title>
			</Dialog.Header>
			{@render sourceDetails()}
		</Dialog.Content>
	</Dialog.Root>
{/if}
