<script lang="ts">
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import { resolve } from '$app/paths';
	import type { OrganizationView } from '$lib/contracts/directory';

	/**
	 * Реквизиты стороны: регион и ИНН — на виду, по ним стороны различают;
	 * полное юрнаименование, КПП, ОГРН и сайт — по раскрытию, их читают по
	 * случаю, а шесть строк юрнаименования отодвигали всё остальное. Правят их
	 * в справочнике — туда и ссылка.
	 */
	let { organization }: { organization: OrganizationView } = $props();

	const summary = $derived(
		[organization.region, organization.inn ? `ИНН ${organization.inn}` : null]
			.filter((part) => part !== null)
			.join(' · ')
	);

	const rows = $derived(
		[
			['Полное наименование', organization.legalName],
			['КПП', organization.kpp],
			['ОГРН', organization.ogrn],
			['Сайт', organization.website]
		].filter((row): row is [string, string] => row[1] !== null && row[1] !== '')
	);
</script>

{#if summary !== ''}
	<p class="text-xs text-muted-foreground tabular-nums">{summary}</p>
{/if}
<details class="group text-xs">
	<summary
		class="flex w-fit list-none items-center gap-1 rounded-sm text-link focus-ring hover:text-link-hover hover:underline [&::-webkit-details-marker]:hidden"
	>
		<ChevronRightIcon
			class="size-3.5 transition-transform group-open:rotate-90"
			aria-hidden="true"
		/>
		Реквизиты
	</summary>
	<dl class="mt-1.5 flex flex-col gap-1.5">
		{#each rows as [label, value] (label)}
			<div class="flex min-w-0 flex-col">
				<dt class="text-muted-foreground">{label}</dt>
				<dd class="break-words">{value}</dd>
			</div>
		{/each}
	</dl>
	<a
		class="mt-1.5 inline-block rounded-sm text-link focus-ring hover:text-link-hover hover:underline"
		href={resolve('/(app)/organizations/[id=uuid]/edit', { id: organization.id })}
		>Изменить реквизиты в справочнике</a
	>
</details>
