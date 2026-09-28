<script lang="ts">
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import { resolve } from '$app/paths';
	import CopyableValue from '$lib/components/copyable-value.svelte';
	import ExternalLink from '$lib/components/external-link.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import type { OrganizationView } from '$lib/contracts/directory';

	/**
	 * Реквизиты стороны: регион, ИНН и сайт — на виду, по ним стороны различают
	 * и открывают; полное юрнаименование, КПП и ОГРН — по раскрытию, их читают
	 * по случаю, а шесть строк юрнаименования отодвигали всё остальное. Реквизиты
	 * копируются по одному — для письма или договора. Правят их в справочнике —
	 * туда и кнопка.
	 */
	let { organization }: { organization: OrganizationView } = $props();

	const website = $derived(organization.website || null);

	const codes = $derived(
		[
			['КПП', organization.kpp],
			['ОГРН', organization.ogrn]
		].filter((row): row is [string, string] => row[1] !== null && row[1] !== '')
	);
</script>

{#if organization.region || organization.inn || website}
	<p
		class="flex flex-wrap items-center gap-x-1 text-xs text-muted-foreground tabular-nums [&>*+*]:before:mr-1 [&>*+*]:before:content-['·']"
	>
		{#if organization.region}
			<span>{organization.region}</span>
		{/if}
		{#if organization.inn}
			<span>ИНН <CopyableValue value={organization.inn} label="ИНН" floating /></span>
		{/if}
		{#if website}
			<span class="min-w-0 break-all"><ExternalLink href={website} /></span>
		{/if}
	</p>
{/if}
<details class="group mt-1 text-xs">
	<summary
		class="flex w-fit list-none items-center gap-1 rounded-sm text-link focus-ring hover:text-link-hover hover:underline [&::-webkit-details-marker]:hidden"
	>
		<ChevronRightIcon
			class="size-3.5 transition-transform group-open:rotate-90"
			aria-hidden="true"
		/>
		Реквизиты
	</summary>
	<dl class="mt-2 flex flex-col gap-2.5">
		<div class="flex min-w-0 flex-col gap-0.5">
			<dt class="text-muted-foreground">Полное наименование</dt>
			<dd class="break-words">
				<CopyableValue value={organization.legalName} label="Полное наименование" />
			</dd>
		</div>
		{#if codes.length > 0}
			<div class="flex flex-wrap gap-x-8 gap-y-2.5">
				{#each codes as [label, value] (label)}
					<div class="flex min-w-0 flex-col gap-0.5">
						<dt class="text-muted-foreground">{label}</dt>
						<dd class="tabular-nums">
							<CopyableValue {value} {label} />
						</dd>
					</div>
				{/each}
			</div>
		{/if}
	</dl>
	<Button
		size="xs"
		variant="outline"
		class="mt-2.5"
		href={resolve('/(app)/organizations/[id=uuid]/edit', { id: organization.id })}
		title="Изменить реквизиты в справочнике"
	>
		<PencilIcon />
		Изменить
	</Button>
</details>
