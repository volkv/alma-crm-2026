<script lang="ts">
	import { enhance } from '$app/forms';
	import * as Card from '$lib/components/ui/card/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import KeyValue from '$lib/components/key-value.svelte';
	import KeyValueRow from '$lib/components/key-value-row.svelte';
	import type { InteractionView } from '$lib/contracts/interactions';
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
</script>

<div class="grid gap-4 lg:grid-cols-2">
	<Card.Root size="sm">
		<Card.Header>
			<Card.Title>Стороны и состав</Card.Title>
		</Card.Header>
		<Card.Content class="flex flex-col gap-4">
			<KeyValue columns={1}>
				{#each interaction.parties as party (party.id)}
					<KeyValueRow
						label={party.partyRole === 'educational_institution'
							? 'Учебное заведение'
							: party.partyRole === 'customer'
								? 'Заказчик подготовки'
								: 'Оператор'}
					>
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

	<div class="flex flex-col gap-4">
		{#if canWrite}
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
								<Input
									id="agreementPeriodStart"
									name="agreementPeriodStart"
									type="date"
									value={interaction.agreementPeriodStart ?? ''}
								/>
							</div>
							<div class="flex flex-col gap-1.5">
								<Label for="agreementPeriodEnd">Соглашение: по</Label>
								<Input
									id="agreementPeriodEnd"
									name="agreementPeriodEnd"
									type="date"
									value={interaction.agreementPeriodEnd ?? ''}
								/>
							</div>
							<div class="flex flex-col gap-1.5">
								<Label for="academicPeriodStart">Учебный период: с</Label>
								<Input
									id="academicPeriodStart"
									name="academicPeriodStart"
									type="date"
									value={interaction.academicPeriodStart ?? ''}
								/>
							</div>
							<div class="flex flex-col gap-1.5">
								<Label for="academicPeriodEnd">Учебный период: по</Label>
								<Input
									id="academicPeriodEnd"
									name="academicPeriodEnd"
									type="date"
									value={interaction.academicPeriodEnd ?? ''}
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
						<div class="min-w-40 flex-1">
							<Label for="ownerUserId" class="text-xs">Назначить</Label>
							<select
								id="ownerUserId"
								name="userId"
								value={interaction.ownerUserId}
								class="h-control w-full rounded-md border border-input bg-background px-2 text-sm focus-ring"
							>
								{#each users as user (user.id)}
									<option value={user.id}>{user.name}</option>
								{/each}
							</select>
						</div>
						<Button type="submit" size="sm" variant="outline">Назначить</Button>
					</form>
				</Card.Content>
			</Card.Root>
		{/if}
	</div>
</div>
