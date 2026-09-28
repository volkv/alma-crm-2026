<script lang="ts">
	import { untrack } from 'svelte';
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
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
	import { CONTRACT_STATUS_LABELS, type InteractionView } from '$lib/contracts/interactions';
	import { getCardCommands } from './commands.svelte';
	import { cardLiveUrl, LiveActivity } from './live.svelte';
	import { rebaseDraft } from '$lib/components/interactions/rebase-draft';
	import type { CounterpartyShape } from './model';
	import StaleNotice from '$lib/components/interactions/stale-notice.svelte';

	/**
	 * Диалоги команд по записи: снятие помехи, ответственный, план и договор.
	 *
	 * Сдвиг сроков и смена договора — решения, поэтому у их форм есть поле
	 * причины: она попадёт в ленту рядом с правкой, а не только в журнал.
	 *
	 * План и договор несут версию записи, с которой диалог открыли, — вместе с
	 * полями, а не из живого `interaction`: карточка может перечитаться, пока
	 * человек пишет, и свежая версия под старым черновиком молча затёрла бы
	 * чужую правку. Отказ 409 оставляет введённое в диалоге.
	 *
	 * Пока открыт диалог плана или договора, коллеги в карточке видят у
	 * аватарки пометку «редактирует» — чтобы не начинать ту же правку вдвоём.
	 */
	let {
		interaction,
		users,
		contracts,
		shape
	}: {
		interaction: InteractionView;
		/**
		 * Вид контрагента: срок соглашения бывает только у вуза. У лица поля
		 * соглашения в форме нет, а записанное значение едет как есть.
		 */
		shape: CounterpartyShape;
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

	const resolveOpen = opened('resolve-blocker');
	const assignOpen = opened('assign');
	const planOpen = opened('plan');
	const contractOpen = opened('contract');

	const liveUrl = $derived(cardLiveUrl(page.params));
	const editingFields = $derived(commands.is('plan') || commands.is('contract'));
	/** Сигнал открытой формы правки; `null` — форма закрыта. */
	let editing: LiveActivity | null = null;

	$effect(() => {
		if (!editingFields) {
			return;
		}

		const activity = new LiveActivity(liveUrl, 'editing');

		editing = activity;
		activity.hold();

		return () => {
			activity.stop();
			editing = null;
		};
	});

	const resolving = $derived(
		commands.current?.kind === 'resolve-blocker' ? commands.current : null
	);

	let resolution = $state('');
	// Пустая строка — ответственный ещё не выбран: у дела его может не быть.
	let ownerUserId = $state(untrack(() => interaction.ownerUserId ?? ''));
	let plan = $state(untrack(() => planOf(interaction)));
	/** План, каким он был при открытии диалога: от него считается, что тронуто. */
	let planBase = $state(untrack(() => planOf(interaction)));
	let planReason = $state('');
	let contractId = $state(untrack(() => interaction.contract?.id ?? NO_OPTION));
	let selectedItemIds = $state<string[]>([]);
	let contractBase = $state(untrack(() => contractOf(interaction)));
	let contractReason = $state('');
	/** Версия записи, с которой открыт диалог плана или договора. */
	let editVersion = $state(untrack(() => interaction.editVersion));
	/** Отказ «запись изменил другой»: показывается в диалоге, ввод остаётся. */
	let conflict = $state<string | null>(null);

	function planOf(source: InteractionView) {
		return {
			title: source.title,
			agreementPeriodStart: source.agreementPeriodStart ?? '',
			agreementPeriodEnd: source.agreementPeriodEnd ?? '',
			academicPeriodStart: source.academicPeriodStart ?? '',
			academicPeriodEnd: source.academicPeriodEnd ?? ''
		};
	}

	/** Договор записи в виде полей диалога. */
	function contractOf(source: InteractionView) {
		return {
			contractId: source.contract?.id ?? NO_OPTION,
			itemIds: (source.contract?.items ?? []).map((item) => item.id).sort()
		};
	}

	// Форма открывается с тем, что лежит в записи сейчас, а не с тем, что
	// набрали в прошлый раз и не отправили.
	$effect(() => {
		const current = commands.current;

		untrack(() => {
			if (current === null) return;

			resolution = '';
			ownerUserId = interaction.ownerUserId ?? '';
			planBase = planOf(interaction);
			plan = { ...planBase };
			planReason = '';
			contractBase = contractOf(interaction);
			contractId = contractBase.contractId;
			selectedItemIds = [...contractBase.itemIds];
			contractReason = '';
			editVersion = interaction.editVersion;
			conflict = null;
		});
	});

	/**
	 * Карточка перечитана после отказа: форма встаёт на свежую версию, поля,
	 * которых человек не трогал, берут свежие значения, тронутые остаются его.
	 * Сохранять — снова его решение.
	 */
	function rebase() {
		const freshPlan = planOf(interaction);
		const freshContract = contractOf(interaction);
		const draftContract = rebaseDraft(
			contractBase,
			{ contractId, itemIds: [...selectedItemIds].sort() },
			freshContract
		);

		plan = rebaseDraft(planBase, plan, freshPlan);
		planBase = freshPlan;
		contractId = draftContract.contractId;
		selectedItemIds = draftContract.itemIds;
		contractBase = freshContract;
		editVersion = interaction.editVersion;
		conflict = null;
	}

	const recordCommand = actionEnhance({
		onsuccess: () => commands.close(),
		onconflict: (message) => (conflict = message)
	});

	const ownerName = $derived(users.find((user) => user.id === ownerUserId)?.name ?? 'Не выбран');

	const planDirty = $derived(
		JSON.stringify(plan) !== JSON.stringify(planBase) || planReason.trim() !== ''
	);

	/** Основная сторона: в её карточке создают договор, если выбирать не из чего. */
	const contractOrganizationId = $derived(
		interaction.parties.find((party) => party.isPrimary)?.organizationId ?? null
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

<svelte:window onpagehide={() => editing?.stop()} />

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
	title={interaction.ownerName === null
		? 'Назначить ответственного'
		: 'Передать другому сотруднику'}
	description={interaction.ownerName === null
		? 'Ответственный ещё не назначен. Назначение попадёт в ленту записи.'
		: `Сейчас отвечает: ${interaction.ownerName}. Смена попадёт в ленту записи.`}
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
				disabled={ownerUserId === '' || ownerUserId === interaction.ownerUserId}
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
		use:enhance={recordCommand}
		class="flex flex-col gap-3"
	>
		<input type="hidden" name="editVersion" value={editVersion} />
		{#if conflict !== null}
			<StaleNotice message={conflict} onrefreshed={rebase} />
		{/if}
		<div class="flex flex-col gap-1.5">
			<Label for="card-plan-title">Название</Label>
			<Input id="card-plan-title" name="title" required bind:value={plan.title} />
		</div>

		<div class="grid gap-3 sm:grid-cols-2">
			{#if shape === 'institution'}
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
			{:else}
				<input type="hidden" name="agreementPeriodStart" value={plan.agreementPeriodStart} />
				<input type="hidden" name="agreementPeriodEnd" value={plan.agreementPeriodEnd} />
			{/if}
			<div class="flex flex-col gap-1.5">
				<Label for="card-academic-start">
					{shape === 'institution' ? 'Учебный период' : 'Период обучения'}: с
				</Label>
				<DateField
					id="card-academic-start"
					name="academicPeriodStart"
					max={plan.academicPeriodEnd}
					bind:value={plan.academicPeriodStart}
				/>
			</div>
			<div class="flex flex-col gap-1.5">
				<Label for="card-academic-end">
					{shape === 'institution' ? 'Учебный период' : 'Период обучения'}: по
				</Label>
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
				placeholder={shape === 'institution'
					? 'Например: вуз попросил сдвинуть сроки'
					: shape === 'company'
						? 'Например: компания попросила сдвинуть сроки'
						: 'Например: слушатель попросил перенести начало'}
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
			У основной стороны нет договоров: создайте договор в её карточке — оттуда вернётесь сюда и
			выберете его.
		</InlineHint>
		{#if contractOrganizationId !== null}
			<Button
				size="sm"
				variant="outline"
				class="self-start"
				href={`${resolve('/(app)/organizations/[id=uuid]', { id: contractOrganizationId })}?return=${encodeURIComponent(`${page.url.pathname}${page.url.search}`)}#contracts`}
			>
				Создать договор
			</Button>
		{/if}
	{:else}
		<form
			id="card-contract-form"
			method="POST"
			action="?/contract"
			use:enhance={recordCommand}
			class="flex flex-col gap-3"
		>
			<input type="hidden" name="editVersion" value={editVersion} />
			{#if conflict !== null}
				<StaleNotice message={conflict} onrefreshed={rebase} />
			{/if}
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
