<script lang="ts">
	import { untrack } from 'svelte';
	import { superForm } from 'sveltekit-superforms';
	import { zod4Client } from 'sveltekit-superforms/adapters';
	import { toast } from 'svelte-sonner';
	import { renderSnippet, type ColumnDef } from '@tanstack/svelte-table';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import * as Alert from '$lib/components/ui/alert/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import ConfirmDialog from '$lib/components/confirm-dialog.svelte';
	import DataTable from '$lib/components/data-table/data-table.svelte';
	import type { DataTableFeatures } from '$lib/components/data-table/features';
	import FieldInput from '$lib/components/form/field-input.svelte';
	import FieldSelect from '$lib/components/form/field-select.svelte';
	import FormActions from '$lib/components/form/form-actions.svelte';
	import StatusBadge from '$lib/components/status-badge.svelte';
	import { formatDateTime, pluralize } from '$lib/format';
	import type { UserView } from '$lib/contracts/auth';
	import { createUserSchema } from './schema';
	import type { PageProps } from './$types';

	let { data, form: actionResult }: PageProps = $props();

	let createOpen = $state(false);
	let pending = $state<UserView | null>(null);
	let confirmOpen = $state(false);
	let deactivateForm = $state<HTMLFormElement | null>(null);

	const {
		form,
		errors,
		enhance,
		submitting,
		reset: resetForm
	} = superForm(
		untrack(() => data.form),
		{
			validators: zod4Client(createUserSchema),
			onUpdated: ({ form: updated }) => {
				if (updated.message) {
					toast.success(updated.message);
					createOpen = false;
					resetForm();
				}
			}
		}
	);

	/** Результат выключения приходит обычным `fail`, а не через superforms. */
	const deactivateMessage = $derived(
		actionResult !== null && 'message' in actionResult ? actionResult.message : null
	);
	const deactivateFailed = $derived(
		actionResult !== null && 'issues' in actionResult && (actionResult.issues?.length ?? 0) > 0
	);

	const policyHint = $derived(
		`Не короче ${pluralize(data.policy.minLength, ['символа', 'символов', 'символов'])}; ` +
			`минимум ${pluralize(data.policy.minClasses, ['вид', 'вида', 'видов'])} символов из четырёх`
	);

	const columns: ColumnDef<DataTableFeatures, UserView>[] = [
		{
			accessorKey: 'email',
			header: 'Почта',
			meta: { title: 'Почта' },
			enableSorting: false,
			enableHiding: false
		},
		{
			accessorKey: 'fullName',
			header: 'Имя',
			meta: { title: 'Имя' },
			enableSorting: false,
			enableHiding: false
		},
		{
			accessorKey: 'roleName',
			header: 'Роль',
			meta: { title: 'Роль' },
			enableSorting: false
		},
		{
			id: 'state',
			header: 'Состояние',
			meta: { title: 'Состояние' },
			enableSorting: false,
			cell: ({ row }) =>
				renderSnippet(stateCell, { active: row.original.isActive, demo: row.original.isDemo })
		},
		{
			accessorKey: 'lastLoginAt',
			header: 'Последний вход',
			meta: { title: 'Последний вход' },
			enableSorting: false,
			cell: ({ row }) =>
				row.original.lastLoginAt === null ? 'ни разу' : formatDateTime(row.original.lastLoginAt)
		},
		{
			id: 'actions',
			header: '',
			meta: { title: 'Действия' },
			enableSorting: false,
			cell: ({ row }) => renderSnippet(actionsCell, { user: row.original })
		}
	];

	function askDeactivate(user: UserView) {
		pending = user;
		confirmOpen = true;
	}
</script>

<svelte:head>
	<title>Пользователи — LCT CRM</title>
</svelte:head>

{#snippet stateCell({ active, demo }: { active: boolean; demo: boolean })}
	<span class="flex flex-wrap items-center gap-1">
		<StatusBadge tone={active ? 'success' : 'neutral'}>
			{active ? 'Работает' : 'Выключен'}
		</StatusBadge>
		{#if demo}
			<StatusBadge tone="warning" title="Учётная запись публичной демонстрации">Демо</StatusBadge>
		{/if}
	</span>
{/snippet}

{#snippet actionsCell({ user }: { user: UserView })}
	{#if user.isActive}
		<Button variant="outline" size="sm" onclick={() => askDeactivate(user)}>Выключить</Button>
	{/if}
{/snippet}

{#if deactivateMessage}
	<Alert.Root variant={deactivateFailed ? 'destructive' : 'default'}>
		<Alert.Description>{deactivateMessage}</Alert.Description>
	</Alert.Root>
{/if}

<Card.Root>
	<Card.Header>
		<Card.Title>Пользователи</Card.Title>
		<Card.Description>
			Учётные записи не удаляются, а выключаются: за каждой стоят записи журнала, и удаление стёрло
			бы историю. Выключение гасит сессии сразу.
		</Card.Description>
		<Card.Action>
			<Button size="sm" onclick={() => (createOpen = true)}>
				<PlusIcon aria-hidden="true" />
				Добавить пользователя
			</Button>
		</Card.Action>
	</Card.Header>
	<Card.Content>
		<DataTable
			{columns}
			rows={data.users.items}
			total={data.users.total}
			getRowId={(user) => user.id}
			emptyTitle="Пользователей пока нет"
		/>
	</Card.Content>
</Card.Root>

<Dialog.Root bind:open={createOpen}>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>Новый пользователь</Dialog.Title>
			<Dialog.Description>
				Пароль задаёте вы и передаёте его сотруднику лично: восстановить или посмотреть его потом
				нельзя — в базе лежит только хеш.
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
		<form method="POST" action="?/create" use:enhance novalidate class="flex flex-col gap-4">
			<FieldInput
				name="email"
				type="email"
				label="Рабочая почта"
				required
				placeholder="name@example.org"
				bind:value={$form.email}
				errors={$errors.email}
			/>
			<FieldInput
				name="fullName"
				label="Имя и фамилия"
				required
				bind:value={$form.fullName}
				errors={$errors.fullName}
			/>
			<FieldSelect
				name="roleId"
				label="Роль"
				required
				options={data.roles.map((role) => ({ value: role.id, label: role.name }))}
				placeholder="Выберите роль"
				bind:value={$form.roleId}
				errors={$errors.roleId}
			/>
			<FieldInput
				name="password"
				type="password"
				label="Пароль"
				description={policyHint}
				required
				bind:value={$form.password}
				errors={$errors.password}
			/>
			<FormActions
				submitting={$submitting}
				submitLabel="Завести пользователя"
				oncancel={() => (createOpen = false)}
			/>
		</form>
	</Dialog.Content>
</Dialog.Root>

<ConfirmDialog
	bind:open={confirmOpen}
	title="Выключить учётную запись?"
	description={pending === null
		? undefined
		: `${pending.fullName} (${pending.email}) потеряет доступ немедленно: все его сессии завершатся. Включить запись обратно из интерфейса пока нельзя.`}
	confirmLabel="Выключить"
	tone="danger"
	onconfirm={() => deactivateForm?.requestSubmit()}
/>

<!-- Диалог только подтверждает; отправляет обычная форма — так на сервер приходит
	то же самое, что от любой другой формы раздела, и действие одно на все пути. -->
<form method="POST" action="?/deactivate" bind:this={deactivateForm} class="hidden">
	<input type="hidden" name="userId" value={pending?.id ?? ''} />
</form>
