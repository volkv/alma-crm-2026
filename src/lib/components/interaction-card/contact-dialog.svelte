<script lang="ts">
	import { untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import * as Select from '$lib/components/ui/select/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import FormDialog from '$lib/components/form-dialog.svelte';
	import InlineHint from '$lib/components/inline-hint.svelte';
	import StaleNotice from '$lib/components/interactions/stale-notice.svelte';
	import { NO_OPTION } from '$lib/components/directory/labels';
	import type { InteractionPartyView, InteractionView } from '$lib/contracts/interactions';

	/**
	 * Смена контактного лица стороны: человек из действующих ролей её
	 * организации или «Не выбрано».
	 *
	 * Список — те же подсказки, что у формы заведения записи, и читается он при
	 * каждом открытии: роль могли завести в карточке вуза минуту назад. Нужного
	 * человека в списке нет — его заводят в карточке вуза, ссылка ведёт туда.
	 *
	 * Как у плана, диалог несёт версию записи, с которой его открыли, и причину
	 * правки для ленты: отказ 409 оставляет выбор в диалоге.
	 */
	let {
		open = $bindable(false),
		interaction,
		party
	}: {
		open?: boolean;
		interaction: InteractionView;
		party: InteractionPartyView;
	} = $props();

	type Option = { id: string; label: string };

	let options = $state<Option[]>([]);
	let loading = $state(false);
	let loadFailed = $state(false);
	let saving = $state(false);
	let contactId = $state(untrack(() => party.contactAffiliationId ?? NO_OPTION));
	let reason = $state('');
	let editVersion = $state(untrack(() => interaction.editVersion));
	let conflict = $state<string | null>(null);

	const initialId = $derived(party.contactAffiliationId ?? NO_OPTION);
	const lookupUrl = $derived(
		`${resolve('/(app)/w/[workspace]/interactions/lookup', { workspace: page.params.workspace ?? '' })}?kind=contacts&organizationId=${encodeURIComponent(party.organizationId)}`
	);
	const saveUrl = $derived(
		resolve('/(app)/w/[workspace]/interactions/[id=uuid]/contact', {
			workspace: page.params.workspace ?? '',
			id: interaction.id
		})
	);

	/**
	 * Нынешний контакт стоит в списке, даже если его роль уже закончилась:
	 * иначе поле показывало бы пустоту вместо того, что записано.
	 */
	const choices = $derived.by(() => {
		const current = party.contactAffiliationId;

		if (
			current === null ||
			party.contact === null ||
			options.some((option) => option.id === current)
		) {
			return options;
		}

		const name = [party.contact.lastName, party.contact.firstName].filter(Boolean).join(' ');

		return [
			{
				id: current,
				label: party.contactPosition ? `${name} — ${party.contactPosition}` : name
			},
			...options
		];
	});

	const chosenLabel = $derived(
		contactId === NO_OPTION
			? 'Не выбрано'
			: (choices.find((option) => option.id === contactId)?.label ?? 'Не выбрано')
	);
	const dirty = $derived(contactId !== initialId || reason.trim() !== '');

	async function loadOptions() {
		loading = true;
		loadFailed = false;

		try {
			const response = await fetch(lookupUrl);

			if (!response.ok) {
				loadFailed = true;
				options = [];
				return;
			}

			const body: { items?: Option[] } = await response.json();

			options = body.items ?? [];
		} catch {
			loadFailed = true;
			options = [];
		} finally {
			loading = false;
		}
	}

	// Форма открывается с тем, что записано сейчас, а не с прошлым черновиком.
	$effect(() => {
		if (!open) return;

		untrack(() => {
			contactId = party.contactAffiliationId ?? NO_OPTION;
			reason = '';
			editVersion = interaction.editVersion;
			conflict = null;
			void loadOptions();
		});
	});

	/** Карточка перечитана после отказа: форма встаёт на свежую версию, выбор остаётся. */
	function rebase() {
		editVersion = interaction.editVersion;
		conflict = null;
	}

	async function save(event: SubmitEvent) {
		event.preventDefault();
		saving = true;

		try {
			const response = await fetch(saveUrl, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					partyId: party.id,
					contactAffiliationId: contactId === NO_OPTION ? null : contactId,
					editVersion,
					reason
				})
			});

			if (response.ok) {
				open = false;
				await invalidateAll();
				return;
			}

			const body: { error?: string; issues?: string[] } = await response.json().catch(() => ({}));
			const message = body.error ?? 'Контактное лицо не сохранено';

			if (response.status === 409) {
				conflict = message;
				return;
			}

			toast.error(message, {
				description: body.issues && body.issues.length > 0 ? body.issues.join('; ') : undefined
			});
		} finally {
			saving = false;
		}
	}
</script>

<FormDialog
	bind:open
	title="Контактное лицо"
	description="Человек вуза, с которым ведётся работа. Смена попадёт в ленту вместе с причиной."
	{dirty}
>
	<form id="card-contact-form" class="flex flex-col gap-3" onsubmit={save}>
		{#if conflict !== null}
			<StaleNotice message={conflict} onrefreshed={rebase} />
		{/if}
		<div class="flex flex-col gap-1.5">
			<Label for="card-contact">Контактное лицо</Label>
			<Select.Root type="single" bind:value={contactId} disabled={loading}>
				<Select.Trigger id="card-contact" class="w-full">
					{loading ? 'Загружаем список…' : chosenLabel}
				</Select.Trigger>
				<Select.Content>
					<Select.Item value={NO_OPTION} label="Не выбрано" />
					{#each choices as option (option.id)}
						<Select.Item value={option.id} label={option.label} />
					{/each}
				</Select.Content>
			</Select.Root>
			{#if loadFailed}
				<InlineHint tone="warning"
					>Список людей не загрузился: закройте диалог и откройте снова.</InlineHint
				>
			{/if}
			<p class="text-xs text-muted-foreground">
				Нет нужного человека?
				<a
					class="rounded-sm text-foreground underline underline-offset-2 focus-ring"
					href={resolve('/(app)/organizations/[id=uuid]', { id: party.organizationId })}
				>
					Добавьте его в карточке вуза
				</a>
			</p>
		</div>

		<div class="flex flex-col gap-1.5">
			<Label for="card-contact-reason">Причина правки</Label>
			<Textarea
				id="card-contact-reason"
				rows={2}
				placeholder="Например: прежний контакт перешёл на другую должность"
				bind:value={reason}
			/>
		</div>
	</form>

	{#snippet footer({ close })}
		<div class="flex justify-end gap-2">
			<Button type="button" variant="outline" onclick={close}>Отмена</Button>
			<Button
				type="submit"
				form="card-contact-form"
				disabled={saving || loading || contactId === initialId}
			>
				Сохранить
			</Button>
		</div>
	{/snippet}
</FormDialog>
