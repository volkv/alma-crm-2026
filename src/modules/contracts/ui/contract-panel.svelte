<script lang="ts">
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import StatusBadge from '$lib/components/status-badge.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import { formatDate } from '$lib/format';
	import { ContextSection, getCardCommands } from '$lib/platform/card';
	import type { CardPanelProps } from '$lib/platform/card-ui';
	import type { ContractsCardData } from '../data';

	/**
	 * Договор, по которому идёт работа, и его позиции: продукт, лицензия и
	 * передача. Номер и состояние договора названы в шапке карточки — здесь
	 * срок договора и то, чего в шапке нет. Сам договор ведут в карточке
	 * контрагента, здесь его только выбирают. Договоров у стороны нет —
	 * выбирать не из чего, и панель ведёт создать договор в карточку
	 * организации с возвратом сюда.
	 *
	 * Физическое лицо учится по оферте и оплате, договора с позициями у него нет:
	 * процесс, который принимает и лиц, и компании, выбирает панель для обоих, а
	 * у лица она молчит.
	 */
	let { source, model, can, data }: CardPanelProps = $props();

	const commands = getCardCommands();
	const contract = $derived(source.interaction.contract);
	const own = $derived(data as ContractsCardData | undefined);
	/** Открыть выбор договора и позиций; `null` — права на правку нет. */
	const onEdit = $derived(can.edit ? () => commands.open({ kind: 'contract' }) : null);
	/**
	 * Создать договор в карточке организации, если выбирать не из чего. Адрес
	 * карточки дела едет параметром `return`: оттуда возвращаются сюда же.
	 */
	const createHref = $derived.by(() => {
		if (!can.edit || contract !== null || own?.contractCount !== 0 || own.organizationId === null) {
			return null;
		}

		const back = `${page.url.pathname}${page.url.search}`;

		return `${resolve('/(app)/organizations/[id=uuid]', { id: own.organizationId })}?return=${encodeURIComponent(back)}#contracts`;
	});

	/** «Передан» — дело сделано; всё остальное ещё ждёт действия. */
	const transferred = (status: string) =>
		status.trim().toLocaleLowerCase('ru').startsWith('передан');

	const day = (value: string | null) => (value === null ? '…' : formatDate(value));
</script>

{#if model.shape !== 'person'}
	<ContextSection title="Договор и позиции">
		{#snippet action()}
			{#if createHref !== null}
				<Button
					size="xs"
					variant="outline"
					href={createHref}
					title="Создать договор"
					aria-label="Создать договор"
				>
					<PlusIcon aria-hidden="true" />
					Создать
				</Button>
			{:else if onEdit !== null}
				<Button
					size="xs"
					variant="outline"
					onclick={onEdit}
					title={contract === null ? 'Выбрать договор' : 'Изменить договор и позиции'}
					aria-label={contract === null ? 'Выбрать договор' : 'Изменить договор и позиции'}
				>
					<PencilIcon aria-hidden="true" />
					{contract === null ? 'Выбрать' : 'Изменить'}
				</Button>
			{/if}
		{/snippet}

		{#if contract === null && createHref !== null}
			<p class="text-sm text-muted-foreground">
				У стороны ещё нет договоров. Создайте договор в карточке организации — оттуда вернётесь сюда
				и выберете его.
			</p>
		{:else if contract === null}
			<p class="text-sm text-muted-foreground">
				Договор не выбран: коммерческих условий у продуктов записи нет.
			</p>
		{:else}
			{#if contract.signedOn !== null || contract.validUntil !== null}
				<p class="text-xs text-muted-foreground tabular-nums">
					Договор № {contract.number}: {day(contract.signedOn)} — {day(contract.validUntil)}
				</p>
			{/if}
			{#if contract.items.length === 0}
				<p class="text-sm text-muted-foreground">Позиции договора для этой работы не выбраны.</p>
			{:else}
				<ul class="flex flex-col gap-2">
					{#each contract.items as item (item.id)}
						<li class="flex flex-col gap-0.5">
							<div class="flex flex-wrap items-center gap-x-2 gap-y-1">
								<span class="text-sm font-medium break-words">{item.code} — {item.name}</span>
								<StatusBadge tone={transferred(item.transferStatus) ? 'success' : 'warning'} wrap>
									{item.transferStatus}
								</StatusBadge>
							</div>
							<p class="text-xs text-muted-foreground">
								{#if item.licenseSignedAt === null && item.licenseUntil === null}
									Лицензия не оформлена
								{:else}
									Лицензия: {day(item.licenseSignedAt)} — {day(item.licenseUntil)}
								{/if}
							</p>
						</li>
					{/each}
				</ul>
			{/if}
		{/if}
	</ContextSection>
{/if}
