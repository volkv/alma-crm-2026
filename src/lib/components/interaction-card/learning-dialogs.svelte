<script lang="ts">
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { untrack } from 'svelte';
	import { enhance } from '$app/forms';
	import * as Alert from '$lib/components/ui/alert/index.js';
	import * as Select from '$lib/components/ui/select/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Checkbox } from '$lib/components/ui/checkbox/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import DateField from '$lib/components/form/date-field.svelte';
	import FormDialog from '$lib/components/form-dialog.svelte';
	import InlineHint from '$lib/components/inline-hint.svelte';
	import { actionEnhance } from '$lib/components/interactions/action-enhance';
	import {
		LEARNING_PURPOSE_LABELS,
		LEARNING_PURPOSES,
		type LearningPurpose
	} from '$lib/contracts/exchange';
	import { getCardCommands } from './commands.svelte';
	import type { CardExchange, CardOffering } from './model';

	/**
	 * Диалоги системы обучения: заявка на поток и отметка «обучение завершено».
	 *
	 * Заявку подаёт сотрудник, а не переход по стадии: число мест и даты
	 * подтверждает человек, и ошибочный переход не должен превращаться в группу
	 * в чужой системе. Отметка нужна там, где итога из системы обучения нет, а
	 * обучение закончилось, — поэтому без объяснения её не поставить.
	 */
	let { exchange }: { exchange: CardExchange } = $props();

	const commands = getCardCommands();

	const opened = (kind: Parameters<typeof commands.is>[0]) => ({
		get: () => commands.is(kind),
		set: (next: boolean) => {
			if (!next) commands.close();
		}
	});

	const sendOpen = opened('send-group');
	const completeOpen = opened('complete-group');

	const offeringLabel = (offering: CardOffering) => `${offering.code} — ${offering.name}`;

	/** Потоки, которые ещё можно отметить завершёнными. */
	const unfinished = $derived(
		exchange.groups.filter((group) => group.trainingState !== 'completed')
	);

	let streamNumber = $state(0);
	let plannedSeats = $state(30);
	let startsOn = $state('');
	let endsOn = $state('');
	let programId = $state('');
	let purpose = $state('');
	let chosenProducts = $state<string[]>([]);
	let completeGroupId = $state('');
	let completeComment = $state('');
	/**
	 * Отказ по заявке — у самой формы, а не тостом: тост всплывает в углу поверх
	 * полей и гаснет вместе с причиной, закрывая ровно то, что надо исправить.
	 */
	let sendRefusal = $state<{ message: string; description?: string } | null>(null);

	$effect(() => {
		const current = commands.current;

		untrack(() => {
			if (current === null) return;

			streamNumber = exchange.nextStreamNumber;
			plannedSeats = 30;
			startsOn = '';
			endsOn = '';
			programId = '';
			purpose = '';
			chosenProducts = [];
			sendRefusal = null;
			completeComment = '';
			completeGroupId =
				current.kind === 'complete-group'
					? (current.groupId ?? (unfinished.length === 1 ? unfinished[0].id : ''))
					: '';
		});
	});

	/**
	 * Программа, которую форма отправит: единственная подставляется сама, из
	 * нескольких выбирает сотрудник — первая попавшаяся вместо выбора учила бы
	 * не тому, о чём договаривались.
	 */
	const effectiveProgramId = $derived(
		exchange.programs.length === 1 ? exchange.programs[0].id : programId
	);
	const effectiveProducts = $derived(
		exchange.products.length === 1 ? [exchange.products[0].id] : chosenProducts
	);
	const programTitle = $derived(
		exchange.programs.find((program) => program.id === programId) ?? null
	);
	const completing = $derived(
		exchange.groups.find((group) => group.id === completeGroupId) ?? null
	);

	function toggleProduct(id: string, checked: boolean) {
		chosenProducts = checked
			? [...chosenProducts.filter((item) => item !== id), id]
			: chosenProducts.filter((item) => item !== id);
	}
</script>

<FormDialog
	bind:open={sendOpen.get, sendOpen.set}
	title="Заявить поток в систему обучения"
	description="Поток закрепляет программу, продукты и то, для кого обучение. Стадию подтвердит его итог: завершившие и дата окончания."
	dirty={purpose !== '' || startsOn !== '' || endsOn !== ''}
	width="lg"
>
	<div class="flex flex-col gap-3">
		{#if exchange.issue !== null}
			<InlineHint tone="warning">{exchange.issue}</InlineHint>
		{/if}

		{#if sendRefusal !== null}
			<Alert.Root variant="destructive">
				<TriangleAlertIcon aria-hidden="true" />
				<Alert.Title>{sendRefusal.message}</Alert.Title>
				{#if sendRefusal.description}
					<Alert.Description>{sendRefusal.description}</Alert.Description>
				{/if}
			</Alert.Root>
		{/if}

		<form
			id="card-send-group-form"
			method="POST"
			action="?/sendGroup"
			onsubmit={() => (sendRefusal = null)}
			use:enhance={actionEnhance({
				onfailure: (refusal) => (sendRefusal = refusal),
				onsuccess: () => commands.close()
			})}
			class="grid items-end gap-3 sm:grid-cols-2"
		>
			<div class="flex flex-col gap-1.5">
				<Label for="card-program">Программа</Label>
				{#if exchange.programs.length === 1}
					<p id="card-program" class="text-sm">{offeringLabel(exchange.programs[0])}</p>
				{:else if exchange.programs.length === 0}
					<p id="card-program" class="text-sm text-muted-foreground">
						У взаимодействия нет программ
					</p>
				{:else}
					<Select.Root type="single" bind:value={programId}>
						<Select.Trigger id="card-program" class="w-full">
							<span class="truncate">
								{programTitle === null ? 'Выберите программу' : offeringLabel(programTitle)}
							</span>
						</Select.Trigger>
						<Select.Content>
							{#each exchange.programs as program (program.id)}
								<Select.Item value={program.id} label={offeringLabel(program)} />
							{/each}
						</Select.Content>
					</Select.Root>
				{/if}
				<input type="hidden" name="programId" value={effectiveProgramId} />
			</div>
			<div class="flex flex-col gap-1.5">
				<Label for="card-purpose">Для кого обучение</Label>
				<Select.Root type="single" bind:value={purpose}>
					<Select.Trigger id="card-purpose" class="w-full">
						{purpose === '' ? 'Выберите' : LEARNING_PURPOSE_LABELS[purpose as LearningPurpose]}
					</Select.Trigger>
					<Select.Content>
						{#each LEARNING_PURPOSES as value (value)}
							<Select.Item {value} label={LEARNING_PURPOSE_LABELS[value]} />
						{/each}
					</Select.Content>
				</Select.Root>
				<input type="hidden" name="purpose" value={purpose} />
			</div>
			{#if exchange.products.length > 0}
				<fieldset class="flex flex-col gap-1.5 sm:col-span-2">
					<legend class="mb-1.5 text-sm font-medium">Продукты</legend>
					{#if exchange.products.length === 1}
						<p class="text-sm">{offeringLabel(exchange.products[0])}</p>
					{:else}
						<div class="flex flex-wrap gap-x-4 gap-y-2">
							{#each exchange.products as product (product.id)}
								<Label class="flex items-center gap-2 font-normal">
									<Checkbox
										checked={chosenProducts.includes(product.id)}
										onCheckedChange={(checked) => toggleProduct(product.id, checked === true)}
									/>
									{offeringLabel(product)}
								</Label>
							{/each}
						</div>
					{/if}
					{#each effectiveProducts as id (id)}
						<input type="hidden" name="productIds" value={id} />
					{/each}
				</fieldset>
			{/if}
			<div class="flex flex-col gap-1.5">
				<Label for="card-stream-number">Поток</Label>
				<Input
					id="card-stream-number"
					name="streamNumber"
					type="number"
					min="1"
					bind:value={streamNumber}
				/>
			</div>
			<div class="flex flex-col gap-1.5">
				<Label for="card-planned-seats">Мест в потоке</Label>
				<Input
					id="card-planned-seats"
					name="plannedSeats"
					type="number"
					min="1"
					bind:value={plannedSeats}
				/>
			</div>
			<div class="flex flex-col gap-1.5">
				<Label for="card-starts-on">Начало занятий</Label>
				<DateField id="card-starts-on" name="startsOn" max={endsOn} bind:value={startsOn} />
			</div>
			<div class="flex flex-col gap-1.5">
				<Label for="card-ends-on">Окончание</Label>
				<DateField id="card-ends-on" name="endsOn" min={startsOn} bind:value={endsOn} />
			</div>
		</form>
	</div>

	{#snippet footer({ close })}
		<div class="flex justify-end gap-2">
			<Button type="button" variant="outline" onclick={close}>Отмена</Button>
			<Button
				type="submit"
				form="card-send-group-form"
				disabled={!exchange.canSend || exchange.issue !== null}
			>
				Отправить в LMS
			</Button>
		</div>
	{/snippet}
</FormDialog>

<FormDialog
	bind:open={completeOpen.get, completeOpen.set}
	title="Обучение завершено"
	description="Итога из системы обучения нет, а обучение закончилось. Объяснение обязательно: оно останется на потоке и в ленте."
	dirty={completeComment.trim() !== ''}
>
	<form
		id="card-complete-group-form"
		method="POST"
		action="?/completeGroup"
		use:enhance={actionEnhance({ onsuccess: () => commands.close() })}
		class="flex flex-col gap-3"
	>
		<div class="flex flex-col gap-1.5">
			<Label for="card-complete-group">Поток</Label>
			<Select.Root type="single" bind:value={completeGroupId}>
				<Select.Trigger id="card-complete-group" class="w-full">
					{completing === null
						? 'Выберите поток'
						: `Поток ${completing.streamNumber}${completing.groupExternalId ? ` · группа ${completing.groupExternalId}` : ''}`}
				</Select.Trigger>
				<Select.Content>
					{#each unfinished as group (group.id)}
						<Select.Item
							value={group.id}
							label={`Поток ${group.streamNumber}${group.groupExternalId ? ` · группа ${group.groupExternalId}` : ''}`}
						/>
					{/each}
				</Select.Content>
			</Select.Root>
			<input type="hidden" name="learningGroupId" value={completeGroupId} />
		</div>
		<div class="flex flex-col gap-1.5">
			<Label for="card-complete-comment">Почему обучение завершено без итога</Label>
			<Textarea
				id="card-complete-comment"
				name="comment"
				rows={3}
				placeholder="Например: итоговая ведомость получена бумагой, 24 из 25 завершили"
				bind:value={completeComment}
			/>
		</div>
	</form>

	{#snippet footer({ close })}
		<div class="flex justify-end gap-2">
			<Button type="button" variant="outline" onclick={close}>Отмена</Button>
			<Button type="submit" form="card-complete-group-form" disabled={completing === null}>
				Отметить обучение завершённым
			</Button>
		</div>
	{/snippet}
</FormDialog>
