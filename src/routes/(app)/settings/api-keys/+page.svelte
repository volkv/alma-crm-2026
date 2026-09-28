<script lang="ts">
	import { untrack } from 'svelte';
	import { superForm } from 'sveltekit-superforms';
	import { zod4Client } from 'sveltekit-superforms/adapters';
	import { toast } from 'svelte-sonner';
	import { renderSnippet, type ColumnDef } from '@tanstack/svelte-table';
	import CopyIcon from '@lucide/svelte/icons/copy';
	import KeyRoundIcon from '@lucide/svelte/icons/key-round';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import * as Alert from '$lib/components/ui/alert/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import ConfirmDialog from '$lib/components/confirm-dialog.svelte';
	import DataTable from '$lib/components/data-table/data-table.svelte';
	import type { DataTableFeatures } from '$lib/components/data-table/features';
	import FieldInput from '$lib/components/form/field-input.svelte';
	import FieldSelect from '$lib/components/form/field-select.svelte';
	import FormActions from '$lib/components/form/form-actions.svelte';
	import InlineHint from '$lib/components/inline-hint.svelte';
	import StatusBadge from '$lib/components/status-badge.svelte';
	import { formatDateTime } from '$lib/format';
	import {
		createApiKeySchema,
		API_KEY_EXCHANGE_SYSTEMS,
		API_KEY_EXCHANGE_SYSTEM_LABELS,
		type ApiKeyExchangeSystem,
		type ApiKeyView,
		type CreateApiKeyInput
	} from '$lib/contracts/api';
	import type { IssuedApiKey } from './notice';
	import type { PageProps } from './$types';

	let { data, form: actionResult }: PageProps = $props();

	let createOpen = $state(false);
	let issued = $state<IssuedApiKey | null>(null);
	let pending = $state<ApiKeyView | null>(null);
	let confirmOpen = $state(false);
	let revokeForm = $state<HTMLFormElement | null>(null);

	const {
		form,
		errors,
		enhance,
		submitting,
		reset: resetForm
	} = superForm<CreateApiKeyInput, IssuedApiKey>(
		untrack(() => data.form),
		{
			validators: zod4Client(createApiKeySchema),
			onUpdated: ({ form: updated }) => {
				if (updated.message) {
					// Ключ показывается сразу после выпуска и больше нигде: список
					// знает только его хеш.
					issued = updated.message;
					createOpen = false;
					resetForm();
				}
			}
		}
	);

	/** Результат отзыва приходит обычным `fail`, а не через superforms. */
	const revokeMessage = $derived(
		actionResult !== null && 'message' in actionResult ? actionResult.message : null
	);
	const revokeFailed = $derived(
		actionResult !== null && 'issues' in actionResult && (actionResult.issues?.length ?? 0) > 0
	);

	const ownerNames = $derived(new Map(data.owners.map((owner) => [owner.id, owner.fullName])));

	/**
	 * Подключение спрашивается только у ключа машинного субъекта: у ключа на
	 * человека его нет и быть не может — маршруты обмена ему закрыты.
	 */
	const ownerIsService = $derived(
		data.owners.find((owner) => owner.id === $form.ownerUserId)?.isService ?? false
	);

	const columns: ColumnDef<DataTableFeatures, ApiKeyView>[] = [
		{
			accessorKey: 'name',
			header: 'Название',
			meta: { title: 'Название' },
			enableSorting: false,
			enableHiding: false
		},
		{
			id: 'owner',
			header: 'Владелец',
			meta: { title: 'Владелец' },
			enableSorting: false,
			cell: ({ row }) => ownerNames.get(row.original.ownerUserId) ?? row.original.ownerUserId
		},
		{
			id: 'exchange',
			header: 'Подключение обмена',
			meta: { title: 'Подключение обмена' },
			enableSorting: false,
			cell: ({ row }) =>
				row.original.exchangeSystem === null
					? '—'
					: `${API_KEY_EXCHANGE_SYSTEM_LABELS[row.original.exchangeSystem]} · ${row.original.exchangeInstance}`
		},
		{
			accessorKey: 'createdAt',
			header: 'Выпущен',
			meta: { title: 'Выпущен' },
			enableSorting: false,
			cell: ({ row }) => formatDateTime(row.original.createdAt)
		},
		{
			accessorKey: 'lastUsedAt',
			header: 'Последнее обращение',
			meta: { title: 'Последнее обращение' },
			enableSorting: false,
			cell: ({ row }) =>
				row.original.lastUsedAt === null ? 'не было' : formatDateTime(row.original.lastUsedAt)
		},
		{
			id: 'state',
			header: 'Состояние',
			meta: { title: 'Состояние' },
			enableSorting: false,
			cell: ({ row }) => renderSnippet(stateCell, { revokedAt: row.original.revokedAt })
		},
		{
			id: 'actions',
			header: '',
			meta: { title: 'Действия' },
			enableSorting: false,
			cell: ({ row }) => renderSnippet(actionsCell, { key: row.original })
		}
	];

	function askRevoke(key: ApiKeyView) {
		pending = key;
		confirmOpen = true;
	}

	async function copyKey(key: string) {
		try {
			await navigator.clipboard.writeText(key);
			toast.success('Ключ скопирован');
		} catch {
			// Буфер обмена бывает закрыт настройками браузера: честнее сказать об
			// этом, чем делать вид, что ключ скопирован.
			toast.error('Скопировать не удалось — выделите ключ и скопируйте вручную');
		}
	}
</script>

<svelte:head>
	<title>Ключи доступа — Альма CRM</title>
</svelte:head>

{#snippet stateCell({ revokedAt }: { revokedAt: Date | null })}
	{#if revokedAt === null}
		<StatusBadge tone="success">Действует</StatusBadge>
	{:else}
		<StatusBadge tone="neutral" title={`Отозван ${formatDateTime(revokedAt)}`}>Отозван</StatusBadge>
	{/if}
{/snippet}

{#snippet actionsCell({ key }: { key: ApiKeyView })}
	{#if key.revokedAt === null}
		<!-- `data-tour` — метка подсказок по этому экрану (`$lib/onboarding/screens`);
			рамка встаёт вокруг отзыва первого действующего ключа. -->
		<Button data-tour="api-keys-revoke" variant="outline" size="sm" onclick={() => askRevoke(key)}>
			Отозвать
		</Button>
	{/if}
{/snippet}

{#if revokeMessage}
	<Alert.Root variant={revokeFailed ? 'destructive' : 'default'}>
		<Alert.Description>{revokeMessage}</Alert.Description>
	</Alert.Root>
{/if}

<Card.Root>
	<Card.Header>
		<Card.Title>Ключи доступа</Card.Title>
		<Card.Description>
			Ключ ходит в API правами своего владельца: у машины не может быть прав больше, чем у человека,
			от имени которого она обращается.
		</Card.Description>
		<Card.Action>
			<!-- `data-tour` — метка подсказок по этому экрану (`$lib/onboarding/screens`). -->
			<Button data-tour="api-keys-issue" size="sm" onclick={() => (createOpen = true)}>
				<PlusIcon aria-hidden="true" />
				Выпустить ключ
			</Button>
		</Card.Action>
	</Card.Header>
	<!-- `data-tour` — метка подсказок по этому экрану (`$lib/onboarding/screens`). -->
	<Card.Content data-tour="api-keys-list">
		<DataTable
			{columns}
			rows={data.keys}
			total={data.keys.length}
			getRowId={(key) => key.id}
			emptyTitle="Ключей ещё нет"
			emptyDescription="Выпустите ключ, когда внешней системе понадобится читать данные через API."
		/>
	</Card.Content>
</Card.Root>

<Dialog.Root bind:open={createOpen}>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>Создать ключ доступа</Dialog.Title>
			<Dialog.Description>
				Назовите ключ так, чтобы через полгода было понятно, кто им ходит: «Выгрузка в 1С», а не
				«ключ 2».
			</Dialog.Description>
		</Dialog.Header>

		{#if $errors._errors}
			<Alert.Root variant="destructive">
				<Alert.Description>
					<ul class="list-inside list-disc">
						{#each $errors._errors as issue (issue)}
							<li>{issue}</li>
						{/each}
					</ul>
				</Alert.Description>
			</Alert.Root>
		{/if}

		<!-- novalidate: проверяет схема и говорит по-русски, а не браузер на своём языке. -->
		<form method="POST" action="?/create" use:enhance novalidate class="flex flex-col gap-form">
			<FieldInput
				name="name"
				label="Название"
				required
				placeholder="Выгрузка в 1С"
				bind:value={$form.name}
				errors={$errors.name}
			/>
			<FieldSelect
				name="ownerUserId"
				label="Владелец"
				description="Ключ работает правами и областью владельца. Ключи обмена с сайтом и системой обучения выпускаются на «Внешние системы (обмен)»: такой ключ не пускают никуда, кроме эндпоинтов обмена."
				required
				options={data.owners.map((owner) => ({ value: owner.id, label: owner.fullName }))}
				placeholder="Выберите владельца"
				bind:value={
					() => $form.ownerUserId,
					(next) => {
						$form.ownerUserId = next;

						// Смена владельца на человека уносит подключение: ключ на
						// сотрудника никакую внешнюю систему не представляет.
						if (data.owners.find((owner) => owner.id === next)?.isService !== true) {
							$form.exchangeSystem = null;
						}
					}
				}
				errors={$errors.ownerUserId}
			/>
			{#if ownerIsService}
				<FieldSelect
					name="exchangeSystem"
					label="Подключение обмена"
					description="Направление, на котором работает ключ. Права у ключей обмена одинаковы, и только это поле не даёт ключу сайта подать результат учебной группы. Экземпляр подключения берётся из настроек интеграций."
					required
					options={API_KEY_EXCHANGE_SYSTEMS.map((system) => ({
						value: system,
						label: API_KEY_EXCHANGE_SYSTEM_LABELS[system]
					}))}
					placeholder="Выберите подключение"
					bind:value={
						() => $form.exchangeSystem ?? '',
						(next) => ($form.exchangeSystem = next === '' ? null : (next as ApiKeyExchangeSystem))
					}
					errors={$errors.exchangeSystem}
				/>
			{/if}
			<FormActions
				submitting={$submitting}
				submitLabel="Выпустить ключ"
				oncancel={() => (createOpen = false)}
			/>
		</form>
	</Dialog.Content>
</Dialog.Root>

<Dialog.Root
	open={issued !== null}
	onOpenChange={(open) => {
		if (!open) issued = null;
	}}
>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>Ключ «{issued?.name}» выпущен</Dialog.Title>
			<Dialog.Description>
				Заберите его сейчас: в базе остаётся только хеш, и второй раз показать ключ будет неоткуда.
				Потерянный ключ отзывают и выпускают заново.
			</Dialog.Description>
		</Dialog.Header>

		<div class="flex items-center gap-2">
			<Input
				readonly
				value={issued?.key ?? ''}
				aria-label="Ключ доступа"
				class="font-mono"
				onfocus={(event) => event.currentTarget.select()}
			/>
			<Button
				variant="outline"
				size="icon"
				aria-label="Скопировать ключ"
				onclick={() => copyKey(issued?.key ?? '')}
			>
				<CopyIcon aria-hidden="true" />
			</Button>
		</div>

		<InlineHint tone="warning" icon={KeyRoundIcon}>
			Ключ даёт доступ к данным от имени владельца. Передавайте его только тем, кому он нужен, и
			отзывайте, как только он перестал быть нужен.
		</InlineHint>

		<Dialog.Footer>
			<Button onclick={() => (issued = null)}>Готово</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<ConfirmDialog
	bind:open={confirmOpen}
	title="Отозвать ключ?"
	description={pending === null
		? undefined
		: `Обращения с ключом «${pending.name}» перестанут проходить сразу. Вернуть его нельзя — только выпустить новый.`}
	confirmLabel="Отозвать"
	tone="danger"
	onconfirm={() => revokeForm?.requestSubmit()}
/>

<!-- Диалог только подтверждает; отправляет обычная форма — так на сервер приходит
	то же самое, что от любой другой формы раздела, и действие одно на все пути. -->
<form method="POST" action="?/revoke" bind:this={revokeForm} class="hidden">
	<input type="hidden" name="apiKeyId" value={pending?.id ?? ''} />
</form>
