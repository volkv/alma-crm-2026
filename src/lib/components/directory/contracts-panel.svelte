<script lang="ts">
	import PlusIcon from '@lucide/svelte/icons/plus';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Table from '$lib/components/ui/table/index.js';
	import EmptyState from '$lib/components/empty-state.svelte';
	import FieldDate from '$lib/components/form/field-date.svelte';
	import FieldInput from '$lib/components/form/field-input.svelte';
	import FieldSelect from '$lib/components/form/field-select.svelte';
	import InlineHint from '$lib/components/inline-hint.svelte';
	import StatusBadge from '$lib/components/status-badge.svelte';
	import { toLookupOptions } from '$lib/components/directory/labels';
	import type { ContractItemView, ContractView } from '$lib/contracts/directory';
	import { CONTRACT_STATUS_LABELS, CONTRACT_STATUSES } from '$lib/contracts/interactions';
	import { LICENSE_STATE_LABELS, licenseState } from '$lib/contracts/license';
	import { formatDate } from '$lib/format';

	/**
	 * Договоры контрагента на его карточке: номер, сроки, состояние и позиции с
	 * коммерческими условиями по каждому продукту.
	 *
	 * Договор ведут здесь, а не в карточке взаимодействия, потому что он
	 * принадлежит контрагенту: один договор обслуживает несколько записей
	 * процесса, и правка его сроков из одной записи меняла бы условия остальным
	 * молча. Взаимодействие договор только выбирает.
	 *
	 * Удаления нет и не будет: справочник не удаляет записи — на договор и его
	 * позиции ссылаются взаимодействия. Договор, по которому больше не работают,
	 * закрывают состоянием.
	 *
	 * У позиции, чья лицензия истекает в пределах окна продления или уже
	 * истекла, стоит отметка и кнопка «Запустить продление»: она заводит
	 * взаимодействие в пространстве контрагента с продуктом и договором позиции.
	 */
	let {
		contracts,
		products,
		canWrite,
		canStartRenewal,
		licenseWarningDays,
		today
	}: {
		contracts: readonly ContractView[];
		/** Каталог продуктов: из него выбирается продукт позиции. */
		products: readonly { id: string; label: string }[];
		canWrite: boolean;
		/** Право заводить взаимодействия: продление — это оно. */
		canStartRenewal: boolean;
		/** Окно продления из настроек — то же, по которому напоминает система. */
		licenseWarningDays: number;
		/** Сегодняшний день по Москве, `YYYY-MM-DD`. */
		today: string;
	} = $props();

	const LICENSE_TONES = { expiring: 'warning', expired: 'danger' } as const;

	const STATUS_TONES = {
		draft: 'warning',
		active: 'success',
		closed: 'neutral'
	} as const;

	const STATUS_OPTIONS = CONTRACT_STATUSES.map((status) => ({
		value: status,
		label: CONTRACT_STATUS_LABELS[status]
	}));

	const productOptions = $derived(toLookupOptions(products));

	/**
	 * Какая форма открыта. Одна на весь блок: у полей формы идентификаторы
	 * совпадают с именами, и две открытые формы дали бы на странице две подписи,
	 * ведущие в одно поле.
	 */
	type OpenForm =
		| { kind: 'contract'; contract: ContractView | null }
		| { kind: 'item'; contractId: string; item: ContractItemView | null };

	let open = $state<OpenForm | null>(null);

	// Значения открытой формы: пока правку не сохранили, поля показывают
	// введённое, а не то, что лежит в базе.
	let number = $state('');
	let signedOn = $state('');
	let validUntil = $state('');
	let status = $state<string>('draft');
	let productId = $state('');
	let licenseSignedAt = $state('');
	let licenseUntil = $state('');
	let transferStatus = $state('');

	function editContract(contract: ContractView | null) {
		number = contract?.number ?? '';
		signedOn = contract?.signedOn ?? '';
		validUntil = contract?.validUntil ?? '';
		status = contract?.status ?? 'draft';
		open = { kind: 'contract', contract };
	}

	function editItem(contractId: string, item: ContractItemView | null) {
		productId = item?.productId ?? products[0]?.id ?? '';
		licenseSignedAt = item?.licenseSignedAt ?? '';
		licenseUntil = item?.licenseUntil ?? '';
		transferStatus = item?.transferStatus ?? '';
		open = { kind: 'item', contractId, item };
	}

	const editingContract = $derived(open?.kind === 'contract' ? open : null);

	function editingItemOf(contractId: string) {
		return open?.kind === 'item' && open.contractId === contractId ? open : null;
	}

	function period(contract: ContractView): string {
		if (contract.signedOn === null && contract.validUntil === null) {
			return '—';
		}

		const from = contract.signedOn === null ? '…' : formatDate(contract.signedOn);
		const to = contract.validUntil === null ? '…' : formatDate(contract.validUntil);

		return `${from} — ${to}`;
	}
</script>

<!-- `data-tour` — метка подсказок: по ней тур находит блок договоров на
	карточке организации (`$lib/onboarding/screens`). -->
<section class="rounded-lg border border-border bg-surface" data-tour="organization-contracts">
	<header class="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
		<div>
			<h2 class="text-sm font-semibold">Договоры</h2>
			<p class="mt-1 text-xs text-muted-foreground">
				Обязательства с этим контрагентом и коммерческие условия по каждому продукту. Взаимодействие
				выбирает договор и нужные его позиции.
			</p>
		</div>
		{#if canWrite}
			<Button variant="outline" size="sm" onclick={() => editContract(null)}>
				<PlusIcon aria-hidden="true" />
				Добавить договор
			</Button>
		{/if}
	</header>

	{#if editingContract !== null}
		<form
			method="POST"
			action="?/saveContract"
			class="flex flex-col gap-3 border-b border-border px-4 py-3"
			data-testid="contract-form"
		>
			{#if editingContract.contract !== null}
				<input type="hidden" name="id" value={editingContract.contract.id} />
			{/if}

			<p class="text-xs font-medium">
				{editingContract.contract === null ? 'Новый договор' : 'Изменение договора'}
			</p>

			<div class="grid gap-3 sm:grid-cols-2">
				<FieldInput name="number" label="Номер договора" required bind:value={number} />
				<FieldSelect name="status" label="Состояние" options={STATUS_OPTIONS} bind:value={status} />
				<FieldDate name="signedOn" label="Подписан" max={validUntil} bind:value={signedOn} />
				<FieldDate name="validUntil" label="Действует до" min={signedOn} bind:value={validUntil} />
			</div>

			<div class="flex justify-end gap-2">
				<Button type="button" variant="ghost" size="sm" onclick={() => (open = null)}>
					Отмена
				</Button>
				<Button type="submit" size="sm">Сохранить договор</Button>
			</div>
		</form>
	{/if}

	{#if contracts.length === 0}
		<EmptyState
			title="Договоров пока нет"
			description="Договор нужен, чтобы взаимодействие знало, по какому обязательству оно идёт и на каких условиях передан продукт."
		/>
	{:else}
		<div class="flex flex-col divide-y divide-border">
			{#each contracts as contract (contract.id)}
				{@const itemForm = editingItemOf(contract.id)}
				<article class="flex flex-col gap-3 px-4 py-3" data-testid="contract">
					<div class="flex flex-wrap items-center justify-between gap-2">
						<div class="flex flex-wrap items-center gap-2">
							<span class="text-sm font-medium">№ {contract.number}</span>
							<StatusBadge tone={STATUS_TONES[contract.status]}>
								{CONTRACT_STATUS_LABELS[contract.status]}
							</StatusBadge>
							<span class="text-xs text-muted-foreground">{period(contract)}</span>
						</div>
						{#if canWrite}
							<div class="flex gap-2">
								<Button variant="ghost" size="sm" onclick={() => editContract(contract)}>
									Изменить
								</Button>
								<Button variant="outline" size="sm" onclick={() => editItem(contract.id, null)}>
									Добавить позицию
								</Button>
							</div>
						{/if}
					</div>

					{#if contract.items.length === 0}
						<p class="text-xs text-muted-foreground">
							Позиций нет: условия по продуктам этого договора не записаны.
						</p>
					{:else}
						<Table.Root>
							<Table.Header>
								<Table.Row class="hover:bg-transparent">
									<Table.Head>Продукт</Table.Head>
									<Table.Head>Лицензия подписана</Table.Head>
									<Table.Head>Лицензия до</Table.Head>
									<Table.Head>Статус по передаче</Table.Head>
									<Table.Head class="w-24"></Table.Head>
								</Table.Row>
							</Table.Header>
							<Table.Body>
								{#each contract.items as item (item.id)}
									<Table.Row class="h-row">
										<Table.Cell class="font-medium">
											{item.productCode} — {item.productName}
										</Table.Cell>
										<Table.Cell>
											{item.licenseSignedAt === null ? '—' : formatDate(item.licenseSignedAt)}
										</Table.Cell>
										{@const license = licenseState(item.licenseUntil, today, licenseWarningDays)}
										<Table.Cell>
											<div class="flex flex-wrap items-center gap-2">
												{item.licenseUntil === null ? '—' : formatDate(item.licenseUntil)}
												{#if license === 'expiring' || license === 'expired'}
													<StatusBadge tone={LICENSE_TONES[license]}>
														{LICENSE_STATE_LABELS[license]}
													</StatusBadge>
												{/if}
											</div>
										</Table.Cell>
										<Table.Cell>{item.transferStatus}</Table.Cell>
										<Table.Cell class="text-right">
											{#if canStartRenewal && (license === 'expiring' || license === 'expired')}
												<form method="POST" action="?/startRenewal" class="inline">
													<input type="hidden" name="contractItemId" value={item.id} />
													<Button
														type="submit"
														variant="outline"
														size="sm"
														data-testid="start-renewal"
													>
														Запустить продление
													</Button>
												</form>
											{/if}
											{#if canWrite}
												<Button
													variant="ghost"
													size="sm"
													onclick={() => editItem(contract.id, item)}
												>
													Изменить
												</Button>
											{/if}
										</Table.Cell>
									</Table.Row>
								{/each}
							</Table.Body>
						</Table.Root>
					{/if}

					{#if itemForm !== null}
						{@const current = itemForm.item}
						<form
							method="POST"
							action="?/saveContractItem"
							class="flex flex-col gap-3 rounded-md border border-border p-3"
							data-testid="contract-item-form"
						>
							<input type="hidden" name="contractId" value={contract.id} />
							{#if current !== null}
								<input type="hidden" name="id" value={current.id} />
								<!-- Продукт позиции не меняется: на пару «договор + продукт»
									ссылаются взаимодействия. Поле остаётся на экране, но выбора
									в нём нет, а значение уходит скрытым. -->
								<input type="hidden" name="productId" value={current.productId} />
							{/if}

							<p class="text-xs font-medium">
								{current === null ? 'Новая позиция договора' : 'Изменение позиции договора'}
							</p>

							{#if products.length === 0}
								<InlineHint tone="warning">
									Справочник продуктов пуст: позицию не на что завести.
								</InlineHint>
							{/if}

							<div class="grid gap-3 sm:grid-cols-2">
								{#if current === null}
									<FieldSelect
										name="productId"
										label="Продукт"
										required
										options={productOptions}
										bind:value={productId}
									/>
								{:else}
									<div class="flex flex-col gap-1.5">
										<span class="text-sm font-medium">Продукт</span>
										<p class="text-sm">{current.productCode} — {current.productName}</p>
									</div>
								{/if}
								<FieldInput
									name="transferStatus"
									label="Статус по передаче"
									required
									placeholder="Например: передан вузу"
									bind:value={transferStatus}
								/>
								<FieldDate
									name="licenseSignedAt"
									label="Лицензия подписана"
									max={licenseUntil}
									bind:value={licenseSignedAt}
								/>
								<FieldDate
									name="licenseUntil"
									label="Лицензия действует до"
									min={licenseSignedAt}
									bind:value={licenseUntil}
								/>
							</div>

							<div class="flex justify-end gap-2">
								<Button type="button" variant="ghost" size="sm" onclick={() => (open = null)}>
									Отмена
								</Button>
								<Button type="submit" size="sm">Сохранить позицию</Button>
							</div>
						</form>
					{/if}
				</article>
			{/each}
		</div>
	{/if}
</section>
