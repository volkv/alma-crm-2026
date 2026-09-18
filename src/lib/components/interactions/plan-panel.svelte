<script lang="ts">
	import { untrack } from 'svelte';
	import { enhance } from '$app/forms';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Select from '$lib/components/ui/select/index.js';
	import * as Table from '$lib/components/ui/table/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import DateField from '$lib/components/form/date-field.svelte';
	import KeyValue from '$lib/components/key-value.svelte';
	import KeyValueRow from '$lib/components/key-value-row.svelte';
	import { Checkbox } from '$lib/components/ui/checkbox/index.js';
	import EmptyState from '$lib/components/empty-state.svelte';
	import InlineHint from '$lib/components/inline-hint.svelte';
	import StatusBadge from '$lib/components/status-badge.svelte';
	import { NO_OPTION } from '$lib/components/directory/labels';
	import type { ContractView } from '$lib/contracts/directory';
	import {
		CONTRACT_STATUS_LABELS,
		PARTY_ROLE_LABELS,
		type InteractionView
	} from '$lib/contracts/interactions';
	import { formatDate } from '$lib/format';
	import { actionEnhance } from './action-enhance';

	/**
	 * План взаимодействия: название, сроки и ответственный. Сдвиг сроков — это
	 * решение, поэтому у формы есть поле причины: она попадёт в историю рядом с
	 * полем, а не только в журнал действий.
	 */
	let {
		interaction,
		users,
		contracts,
		canWrite
	}: {
		interaction: InteractionView;
		/** Кого можно назначить ответственным. */
		users: readonly { id: string; name: string }[];
		/** Договоры основной стороны: из них выбирают договор записи. */
		contracts: readonly ContractView[];
		canWrite: boolean;
	} = $props();

	// Значения формы держатся отдельно от записи: пока правку не сохранили, поля
	// показывают введённое, а не то, что лежит в базе. Запись читается один раз —
	// вкладка «План» собирается заново при каждом открытии, и свежие значения
	// приезжают с ней, а не поверх набранного.
	let plan = $state(
		untrack(() => ({
			agreementPeriodStart: interaction.agreementPeriodStart ?? '',
			agreementPeriodEnd: interaction.agreementPeriodEnd ?? '',
			academicPeriodStart: interaction.academicPeriodStart ?? '',
			academicPeriodEnd: interaction.academicPeriodEnd ?? ''
		}))
	);
	let ownerUserId = $state(untrack(() => interaction.ownerUserId));

	const ownerName = $derived(users.find((user) => user.id === ownerUserId)?.name ?? 'Не выбран');

	// Выбор договора держится отдельно от записи по той же причине, что и сроки:
	// пока форму не отправили, на экране стоит набранное.
	let contractId = $state(untrack(() => interaction.contract?.id ?? NO_OPTION));
	let selectedItemIds = $state(
		untrack(() => (interaction.contract?.items ?? []).map((item) => item.id))
	);

	const chosenContract = $derived(contracts.find((contract) => contract.id === contractId) ?? null);
	const contractLabel = $derived(
		chosenContract === null
			? 'Без договора'
			: `№ ${chosenContract.number} — ${CONTRACT_STATUS_LABELS[chosenContract.status]}`
	);

	/**
	 * Позиции по продуктам вне состава: сервер такую пару отвергнет, потому что
	 * состав продуктов задаёт взаимодействие, а не договор.
	 */
	const itemsOutsideProducts = $derived(
		(chosenContract?.items ?? []).filter(
			(item) =>
				selectedItemIds.includes(item.id) &&
				!interaction.products.some((product) => product.productId === item.productId)
		)
	);

	function toggleItem(id: string, checked: boolean) {
		selectedItemIds = checked
			? [...new Set([...selectedItemIds, id])]
			: selectedItemIds.filter((item) => item !== id);
	}
</script>

<div class="flex flex-col gap-4">
	<!-- Без права на правку остаётся одна карточка, и растягивать её на половину
	ширины незачем: пустая вторая колонка читается как потерянное содержимое. -->
	<div class="grid items-start gap-4 {canWrite ? 'lg:grid-cols-2' : ''}">
		<Card.Root size="sm">
			<Card.Header>
				<Card.Title>Стороны и состав</Card.Title>
			</Card.Header>
			<Card.Content class="flex flex-col gap-4">
				<KeyValue columns={1}>
					{#each interaction.parties as party (party.id)}
						<KeyValueRow label={PARTY_ROLE_LABELS[party.partyRole]}>
							<span class="flex flex-col gap-0.5">
								<span>{party.organizationName}</span>
								{#if party.contact !== null}
									<span class="text-xs text-muted-foreground">
										{party.contact.lastName}
										{party.contact.firstName}
										{party.contactPosition ? `— ${party.contactPosition}` : ''}
										{party.contact.email ? `· ${party.contact.email}` : ''}
									</span>
								{/if}
								{#if party.sites.length > 0}
									<span class="text-xs text-faint">
										Площадки: {party.sites.map((site) => site.name).join(', ')}
									</span>
								{/if}
							</span>
						</KeyValueRow>
					{/each}

					<KeyValueRow
						label="Программы"
						value={interaction.programs.length === 0
							? null
							: interaction.programs
									.map((program) => `${program.code} — ${program.name}`)
									.join('; ')}
					/>
					<KeyValueRow
						label="Продукты"
						value={interaction.products.length === 0
							? null
							: interaction.products.map((product) => product.name).join('; ')}
					/>
					<KeyValueRow label="Процесс" value={interaction.processGroupName} />
					<KeyValueRow label="Договор">
						{#if interaction.contract === null}
							<span class="text-faint">не выбран</span>
						{:else}
							<span class="flex flex-wrap items-center gap-2">
								<span>№ {interaction.contract.number}</span>
								<StatusBadge
									tone={interaction.contract.status === 'active'
										? 'success'
										: interaction.contract.status === 'draft'
											? 'warning'
											: 'neutral'}
								>
									{CONTRACT_STATUS_LABELS[interaction.contract.status]}
								</StatusBadge>
								{#if interaction.contract.validUntil !== null}
									<span class="text-xs text-muted-foreground">
										действует до {formatDate(interaction.contract.validUntil)}
									</span>
								{/if}
							</span>
						{/if}
					</KeyValueRow>
					<KeyValueRow
						label="Учебный период"
						value={interaction.academicPeriodStart === null
							? null
							: `${formatDate(interaction.academicPeriodStart)} — ${
									interaction.academicPeriodEnd === null
										? '…'
										: formatDate(interaction.academicPeriodEnd)
								}`}
					/>
				</KeyValue>
			</Card.Content>
		</Card.Root>

		{#if canWrite}
			<div class="flex flex-col gap-4">
				<Card.Root size="sm">
					<Card.Header>
						<Card.Title>Изменить план</Card.Title>
					</Card.Header>
					<Card.Content>
						<form
							method="POST"
							action="?/update"
							use:enhance={actionEnhance()}
							class="flex flex-col gap-3"
						>
							<div class="flex flex-col gap-1.5">
								<Label for="planTitle">Название</Label>
								<Input id="planTitle" name="title" value={interaction.title} required />
							</div>

							<div class="grid gap-3 sm:grid-cols-2">
								<div class="flex flex-col gap-1.5">
									<Label for="agreementPeriodStart">Соглашение: с</Label>
									<DateField
										id="agreementPeriodStart"
										name="agreementPeriodStart"
										max={plan.agreementPeriodEnd}
										bind:value={plan.agreementPeriodStart}
									/>
								</div>
								<div class="flex flex-col gap-1.5">
									<Label for="agreementPeriodEnd">Соглашение: по</Label>
									<DateField
										id="agreementPeriodEnd"
										name="agreementPeriodEnd"
										min={plan.agreementPeriodStart}
										bind:value={plan.agreementPeriodEnd}
									/>
								</div>
								<div class="flex flex-col gap-1.5">
									<Label for="academicPeriodStart">Учебный период: с</Label>
									<DateField
										id="academicPeriodStart"
										name="academicPeriodStart"
										max={plan.academicPeriodEnd}
										bind:value={plan.academicPeriodStart}
									/>
								</div>
								<div class="flex flex-col gap-1.5">
									<Label for="academicPeriodEnd">Учебный период: по</Label>
									<DateField
										id="academicPeriodEnd"
										name="academicPeriodEnd"
										min={plan.academicPeriodStart}
										bind:value={plan.academicPeriodEnd}
									/>
								</div>
							</div>

							<div class="flex flex-col gap-1.5">
								<Label for="planReason">Причина правки</Label>
								<Textarea
									id="planReason"
									name="reason"
									rows={2}
									placeholder="Например: вуз попросил сдвинуть сроки"
								/>
							</div>

							<div class="flex justify-end">
								<Button type="submit" size="sm">Сохранить план</Button>
							</div>
						</form>
					</Card.Content>
				</Card.Root>

				<Card.Root size="sm">
					<Card.Header>
						<Card.Title>Ответственный</Card.Title>
						<Card.Description>Сейчас: {interaction.ownerName}</Card.Description>
					</Card.Header>
					<Card.Content>
						<form
							method="POST"
							action="?/assign"
							use:enhance={actionEnhance()}
							class="flex flex-wrap items-end gap-2"
						>
							<div class="flex min-w-40 flex-1 flex-col gap-1.5">
								<Label for="ownerUserId" class="text-xs">Назначить</Label>
								<Select.Root type="single" name="userId" bind:value={ownerUserId}>
									<Select.Trigger id="ownerUserId" class="w-full">{ownerName}</Select.Trigger>
									<Select.Content>
										{#each users as user (user.id)}
											<Select.Item value={user.id} label={user.name} />
										{/each}
									</Select.Content>
								</Select.Root>
							</div>
							<Button type="submit" size="sm" variant="outline">Назначить</Button>
						</form>
					</Card.Content>
				</Card.Root>
			</div>
		{/if}
	</div>

	<Card.Root size="sm" data-testid="contract-panel">
		<Card.Header>
			<Card.Title>Договор</Card.Title>
			<Card.Description>
				Обязательство, по которому идёт работа, и его позиции: сроки лицензии и статус по передаче
				продукта. Сам договор ведут в карточке контрагента — здесь его выбирают.
			</Card.Description>
		</Card.Header>
		<Card.Content class="flex flex-col gap-4">
			{#if interaction.contract === null}
				<EmptyState
					title="Договор не выбран"
					description="Пока запись не сослалась на договор, коммерческих условий у её продуктов нет."
				/>
			{:else}
				<KeyValue columns={1}>
					<KeyValueRow label="Номер" value={`№ ${interaction.contract.number}`} />
					<KeyValueRow
						label="Состояние"
						value={CONTRACT_STATUS_LABELS[interaction.contract.status]}
					/>
					<KeyValueRow
						label="Срок"
						value={interaction.contract.signedOn === null &&
						interaction.contract.validUntil === null
							? null
							: `${
									interaction.contract.signedOn === null
										? '…'
										: formatDate(interaction.contract.signedOn)
								} — ${
									interaction.contract.validUntil === null
										? '…'
										: formatDate(interaction.contract.validUntil)
								}`}
					/>
				</KeyValue>

				{#if interaction.contract.items.length === 0}
					<p class="text-xs text-muted-foreground">
						Позиции из договора не выбраны: коммерческих условий по продуктам записи нет.
					</p>
				{:else}
					<Table.Root>
						<Table.Header>
							<Table.Row class="hover:bg-transparent">
								<Table.Head>Продукт</Table.Head>
								<Table.Head>Лицензия подписана</Table.Head>
								<Table.Head>Лицензия до</Table.Head>
								<Table.Head>Статус по передаче</Table.Head>
							</Table.Row>
						</Table.Header>
						<Table.Body>
							{#each interaction.contract.items as item (item.id)}
								<Table.Row class="h-row">
									<Table.Cell class="font-medium">{item.code} — {item.name}</Table.Cell>
									<Table.Cell>
										{item.licenseSignedAt === null ? '—' : formatDate(item.licenseSignedAt)}
									</Table.Cell>
									<Table.Cell>
										{item.licenseUntil === null ? '—' : formatDate(item.licenseUntil)}
									</Table.Cell>
									<Table.Cell>{item.transferStatus}</Table.Cell>
								</Table.Row>
							{/each}
						</Table.Body>
					</Table.Root>
				{/if}
			{/if}

			{#if canWrite}
				{#if contracts.length === 0}
					<InlineHint>
						У основной стороны нет договоров: заведите договор в её карточке, и он появится в этом
						списке.
					</InlineHint>
				{:else}
					<form
						method="POST"
						action="?/contract"
						use:enhance={actionEnhance()}
						class="flex flex-col gap-3 border-t border-border pt-4"
					>
						<div class="flex flex-col gap-1.5">
							<Label for="contractId">Договор контрагента</Label>
							<Select.Root type="single" name="contractId" bind:value={contractId}>
								<Select.Trigger id="contractId" class="w-full">{contractLabel}</Select.Trigger>
								<Select.Content>
									<Select.Item value={NO_OPTION} label="Без договора" />
									{#each contracts as contract (contract.id)}
										<Select.Item
											value={contract.id}
											label={`№ ${contract.number} — ${CONTRACT_STATUS_LABELS[contract.status]}`}
										/>
									{/each}
								</Select.Content>
							</Select.Root>
						</div>

						{#if chosenContract !== null}
							<fieldset class="flex flex-col gap-2">
								<legend class="text-sm font-medium">Позиции договора</legend>
								{#if chosenContract.items.length === 0}
									<p class="text-xs text-muted-foreground">
										В договоре нет позиций: их заводят в карточке контрагента.
									</p>
								{/if}
								{#each chosenContract.items as item (item.id)}
									<Label class="flex items-start gap-2 font-normal">
										<Checkbox
											name="contractItemIds"
											value={item.id}
											checked={selectedItemIds.includes(item.id)}
											onCheckedChange={(checked) => toggleItem(item.id, checked === true)}
										/>
										<span class="flex flex-col gap-0.5">
											<span>{item.productCode} — {item.productName}</span>
											<span class="text-xs text-muted-foreground">
												Статус по передаче: {item.transferStatus}
											</span>
										</span>
									</Label>
								{/each}
							</fieldset>

							{#if itemsOutsideProducts.length > 0}
								<InlineHint tone="warning">
									Позиция описывает продукт вне состава записи: отметьте {itemsOutsideProducts
										.map((item) => `«${item.productName}»`)
										.join(', ')} среди продуктов взаимодействия или снимите позицию.
								</InlineHint>
							{/if}
						{/if}

						<div class="flex flex-col gap-1.5">
							<Label for="contractReason">Причина правки</Label>
							<Textarea
								id="contractReason"
								name="reason"
								rows={2}
								placeholder="Например: подписали новый договор на тот же продукт"
							/>
						</div>

						<div class="flex justify-end">
							<Button type="submit" size="sm">Сохранить договор записи</Button>
						</div>
					</form>
				{/if}
			{/if}
		</Card.Content>
	</Card.Root>
</div>
