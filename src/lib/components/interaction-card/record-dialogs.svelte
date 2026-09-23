<script lang="ts">
	import { untrack } from 'svelte';
	import { enhance } from '$app/forms';
	import * as Select from '$lib/components/ui/select/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Checkbox } from '$lib/components/ui/checkbox/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import DateField from '$lib/components/form/date-field.svelte';
	import FormDialog from '$lib/components/form-dialog.svelte';
	import InlineHint from '$lib/components/inline-hint.svelte';
	import { NO_OPTION } from '$lib/components/directory/labels';
	import { actionEnhance } from '$lib/components/interactions/action-enhance';
	import type { ContractView } from '$lib/contracts/directory';
	import {
		blockerReasonLabel,
		BLOCKER_REASONS,
		BLOCKER_REASON_LABELS,
		CONTRACT_STATUS_LABELS,
		type InteractionView
	} from '$lib/contracts/interactions';
	import { getCardCommands } from './commands.svelte';

	/**
	 * Диалоги команд по записи: помехи, ответственный, план и договор.
	 *
	 * Сдвиг сроков и смена договора — решения, поэтому у их форм есть поле
	 * причины: она попадёт в ленту рядом с правкой, а не только в журнал.
	 */
	let {
		interaction,
		users,
		contracts
	}: {
		interaction: InteractionView;
		/** Кого можно назначить ответственным. */
		users: readonly { id: string; name: string }[];
		/** Договоры основной стороны: из них выбирают договор записи. */
		contracts: readonly ContractView[];
	} = $props();

	const commands = getCardCommands();

	const opened = (kind: Parameters<typeof commands.is>[0]) => ({
		get: () => commands.is(kind),
		set: (next: boolean) => {
			if (!next) commands.close();
		}
	});

	const raiseOpen = opened('raise-blocker');
	const resolveOpen = opened('resolve-blocker');
	const assignOpen = opened('assign');
	const planOpen = opened('plan');
	const contractOpen = opened('contract');

	const resolving = $derived(
		commands.current?.kind === 'resolve-blocker' ? commands.current : null
	);

	/** Причина выбирается из справочника: по ней потом считают, на чём встаём. */
	let reasonCode = $state('');
	let blockerDescription = $state('');
	let resolution = $state('');
	let ownerUserId = $state(untrack(() => interaction.ownerUserId));
	let plan = $state(untrack(() => planOf(interaction)));
	let planReason = $state('');
	let contractId = $state(untrack(() => interaction.contract?.id ?? NO_OPTION));
	let selectedItemIds = $state<string[]>([]);
	let contractReason = $state('');

	function planOf(source: InteractionView) {
		return {
			title: source.title,
			agreementPeriodStart: source.agreementPeriodStart ?? '',
			agreementPeriodEnd: source.agreementPeriodEnd ?? '',
			academicPeriodStart: source.academicPeriodStart ?? '',
			academicPeriodEnd: source.academicPeriodEnd ?? ''
		};
	}

	// Форма открывается с тем, что лежит в записи сейчас, а не с тем, что
	// набрали в прошлый раз и не отправили.
	$effect(() => {
		const current = commands.current;

		untrack(() => {
			if (current === null) return;

			reasonCode = '';
			blockerDescription = '';
			resolution = '';
			ownerUserId = interaction.ownerUserId;
			plan = planOf(interaction);
			planReason = '';
			contractId = interaction.contract?.id ?? NO_OPTION;
			selectedItemIds = (interaction.contract?.items ?? []).map((item) => item.id);
			contractReason = '';
		});
	});

	const ownerName = $derived(users.find((user) => user.id === ownerUserId)?.name ?? 'Не выбран');

	const planDirty = $derived(
		JSON.stringify(plan) !== JSON.stringify(planOf(interaction)) || planReason.trim() !== ''
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

<FormDialog
	bind:open={raiseOpen.get, raiseOpen.set}
	title="Сообщить о помехе"
	description="Помеха с запретом не пустит запись на следующую стадию, пока её не снимут с объяснением."
	dirty={blockerDescription.trim() !== ''}
>
	<form
		id="card-raise-blocker-form"
		method="POST"
		action="?/raiseBlocker"
		use:enhance={actionEnhance({ onsuccess: () => commands.close() })}
		class="flex flex-col gap-3"
	>
		<div class="flex flex-col gap-1.5">
			<Label for="card-blocker-reason">Причина</Label>
			<Select.Root type="single" name="reasonCode" bind:value={reasonCode}>
				<Select.Trigger id="card-blocker-reason" class="w-full">
					{reasonCode === '' ? 'Выберите причину' : blockerReasonLabel(reasonCode)}
				</Select.Trigger>
				<Select.Content>
					{#each BLOCKER_REASONS as reason (reason)}
						<Select.Item value={reason} label={BLOCKER_REASON_LABELS[reason]} />
					{/each}
				</Select.Content>
			</Select.Root>
		</div>
		<div class="flex flex-col gap-1.5">
			<Label for="card-blocker-description">Что мешает</Label>
			<Textarea
				id="card-blocker-description"
				name="description"
				rows={3}
				required
				bind:value={blockerDescription}
			/>
		</div>
		<Label class="flex items-center gap-2 font-normal">
			<Checkbox name="blocksTransition" value="true" checked />
			Запрещает переход на следующую стадию
		</Label>
	</form>

	{#snippet footer({ close })}
		<div class="flex justify-end gap-2">
			<Button type="button" variant="outline" onclick={close}>Отмена</Button>
			<Button type="submit" form="card-raise-blocker-form" disabled={reasonCode === ''}>
				Сообщить
			</Button>
		</div>
	{/snippet}
</FormDialog>

<FormDialog
	bind:open={resolveOpen.get, resolveOpen.set}
	title="Снять помеху"
	description={resolving === null ? undefined : `«${resolving.description}»`}
	dirty={resolution.trim() !== ''}
>
	<form
		id="card-resolve-blocker-form"
		method="POST"
		action="?/resolveBlocker"
		use:enhance={actionEnhance({ onsuccess: () => commands.close() })}
		class="flex flex-col gap-1.5"
	>
		<input type="hidden" name="blockerId" value={resolving?.blockerId ?? ''} />
		<Label for="card-blocker-resolution">Как решено</Label>
		<Input id="card-blocker-resolution" name="resolution" required bind:value={resolution} />
	</form>

	{#snippet footer({ close })}
		<div class="flex justify-end gap-2">
			<Button type="button" variant="outline" onclick={close}>Отмена</Button>
			<Button type="submit" form="card-resolve-blocker-form">Снять помеху</Button>
		</div>
	{/snippet}
</FormDialog>

<FormDialog
	bind:open={assignOpen.get, assignOpen.set}
	title="Передать другому сотруднику"
	description="Сейчас отвечает: {interaction.ownerName}. Смена попадёт в ленту записи."
>
	<form
		id="card-assign-form"
		method="POST"
		action="?/assign"
		use:enhance={actionEnhance({ onsuccess: () => commands.close() })}
		class="flex flex-col gap-1.5"
	>
		<Label for="card-owner">Ответственный</Label>
		<Select.Root type="single" name="userId" bind:value={ownerUserId}>
			<Select.Trigger id="card-owner" class="w-full">{ownerName}</Select.Trigger>
			<Select.Content>
				{#each users as user (user.id)}
					<Select.Item value={user.id} label={user.name} />
				{/each}
			</Select.Content>
		</Select.Root>
	</form>

	{#snippet footer({ close })}
		<div class="flex justify-end gap-2">
			<Button type="button" variant="outline" onclick={close}>Отмена</Button>
			<Button
				type="submit"
				form="card-assign-form"
				disabled={ownerUserId === interaction.ownerUserId}
			>
				Назначить
			</Button>
		</div>
	{/snippet}
</FormDialog>

<FormDialog
	bind:open={planOpen.get, planOpen.set}
	title="Изменить план"
	description="Название и сроки. Правка попадёт в ленту вместе с причиной."
	dirty={planDirty}
	width="lg"
>
	<form
		id="card-plan-form"
		method="POST"
		action="?/update"
		use:enhance={actionEnhance({ onsuccess: () => commands.close() })}
		class="flex flex-col gap-3"
	>
		<div class="flex flex-col gap-1.5">
			<Label for="card-plan-title">Название</Label>
			<Input id="card-plan-title" name="title" required bind:value={plan.title} />
		</div>

		<div class="grid gap-3 sm:grid-cols-2">
			<div class="flex flex-col gap-1.5">
				<Label for="card-agreement-start">Соглашение: с</Label>
				<DateField
					id="card-agreement-start"
					name="agreementPeriodStart"
					max={plan.agreementPeriodEnd}
					bind:value={plan.agreementPeriodStart}
				/>
			</div>
			<div class="flex flex-col gap-1.5">
				<Label for="card-agreement-end">Соглашение: по</Label>
				<DateField
					id="card-agreement-end"
					name="agreementPeriodEnd"
					min={plan.agreementPeriodStart}
					bind:value={plan.agreementPeriodEnd}
				/>
			</div>
			<div class="flex flex-col gap-1.5">
				<Label for="card-academic-start">Учебный период: с</Label>
				<DateField
					id="card-academic-start"
					name="academicPeriodStart"
					max={plan.academicPeriodEnd}
					bind:value={plan.academicPeriodStart}
				/>
			</div>
			<div class="flex flex-col gap-1.5">
				<Label for="card-academic-end">Учебный период: по</Label>
				<DateField
					id="card-academic-end"
					name="academicPeriodEnd"
					min={plan.academicPeriodStart}
					bind:value={plan.academicPeriodEnd}
				/>
			</div>
		</div>

		<div class="flex flex-col gap-1.5">
			<Label for="card-plan-reason">Причина правки</Label>
			<Textarea
				id="card-plan-reason"
				name="reason"
				rows={2}
				placeholder="Например: вуз попросил сдвинуть сроки"
				bind:value={planReason}
			/>
		</div>
	</form>

	{#snippet footer({ close })}
		<div class="flex justify-end gap-2">
			<Button type="button" variant="outline" onclick={close}>Отмена</Button>
			<Button type="submit" form="card-plan-form">Сохранить план</Button>
		</div>
	{/snippet}
</FormDialog>

<FormDialog
	bind:open={contractOpen.get, contractOpen.set}
	title="Договор записи"
	description="Обязательство, по которому идёт работа, и его позиции. Сам договор ведут в карточке контрагента — здесь его выбирают."
	dirty={contractReason.trim() !== ''}
	width="lg"
>
	{#if contracts.length === 0}
		<InlineHint>
			У основной стороны нет договоров: заведите договор в её карточке, и он появится в этом списке.
		</InlineHint>
	{:else}
		<form
			id="card-contract-form"
			method="POST"
			action="?/contract"
			use:enhance={actionEnhance({ onsuccess: () => commands.close() })}
			class="flex flex-col gap-3"
		>
			<div class="flex flex-col gap-1.5">
				<Label for="card-contract">Договор контрагента</Label>
				<Select.Root type="single" name="contractId" bind:value={contractId}>
					<Select.Trigger id="card-contract" class="w-full">{contractLabel}</Select.Trigger>
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
					<legend class="mb-1 text-sm font-medium">Позиции договора</legend>
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
				<Label for="card-contract-reason">Причина правки</Label>
				<Textarea
					id="card-contract-reason"
					name="reason"
					rows={2}
					placeholder="Например: подписали новый договор на тот же продукт"
					bind:value={contractReason}
				/>
			</div>
		</form>
	{/if}

	{#snippet footer({ close })}
		<div class="flex justify-end gap-2">
			<Button type="button" variant="outline" onclick={close}>
				{contracts.length === 0 ? 'Закрыть' : 'Отмена'}
			</Button>
			{#if contracts.length > 0}
				<Button type="submit" form="card-contract-form">Сохранить договор записи</Button>
			{/if}
		</div>
	{/snippet}
</FormDialog>
