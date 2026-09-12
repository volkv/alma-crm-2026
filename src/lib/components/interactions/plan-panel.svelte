<script lang="ts">
	import { untrack } from 'svelte';
	import { enhance } from '$app/forms';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Select from '$lib/components/ui/select/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import DateField from '$lib/components/form/date-field.svelte';
	import KeyValue from '$lib/components/key-value.svelte';
	import KeyValueRow from '$lib/components/key-value-row.svelte';
	import { PARTY_ROLE_LABELS, type InteractionView } from '$lib/contracts/interactions';
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
		canWrite
	}: {
		interaction: InteractionView;
		/** Кого можно назначить ответственным. */
		users: readonly { id: string; name: string }[];
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
</script>

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
						: interaction.programs.map((program) => `${program.code} — ${program.name}`).join('; ')}
				/>
				<KeyValueRow
					label="Продукты"
					value={interaction.products.length === 0
						? null
						: interaction.products.map((product) => product.name).join('; ')}
				/>
				<KeyValueRow label="Маршрут" value={interaction.routeName} />
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
