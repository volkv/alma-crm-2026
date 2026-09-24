<script lang="ts">
	import { page } from '$app/state';
	import { renderSnippet, type ColumnDef } from '@tanstack/svelte-table';
	import * as Alert from '$lib/components/ui/alert/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import ConfirmDialog from '$lib/components/confirm-dialog.svelte';
	import DataTable from '$lib/components/data-table/data-table.svelte';
	import type { DataTableFeatures } from '$lib/components/data-table/features';
	import { readTableQuery } from '$lib/components/data-table/query';
	import InlineHint from '$lib/components/inline-hint.svelte';
	import StatusBadge from '$lib/components/status-badge.svelte';
	import { formatDateTime } from '$lib/format';
	import type { UserView } from '$lib/contracts/auth';
	import ManagerSelect from './manager-select.svelte';
	import type { PageProps } from './$types';

	let { data, form: actionResult }: PageProps = $props();

	let pending = $state<UserView | null>(null);
	let confirmOpen = $state(false);
	let deactivateForm = $state<HTMLFormElement | null>(null);

	/** Результат любого действия раздела приходит обычным `fail`, а не через superforms. */
	const switchMessage = $derived(
		actionResult !== null && 'message' in actionResult ? actionResult.message : null
	);
	const switchFailed = $derived(
		actionResult !== null && 'issues' in actionResult && (actionResult.issues?.length ?? 0) > 0
	);

	/** Пустой список под поиском и пустой список вообще — разные вещи. */
	const search = $derived(readTableQuery(page.url).search);

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
			id: 'manager',
			header: 'Руководитель',
			meta: { title: 'Руководитель' },
			enableSorting: false,
			cell: ({ row }) => renderSnippet(managerCell, { user: row.original })
		},
		{
			id: 'state',
			header: 'Состояние',
			meta: { title: 'Состояние' },
			enableSorting: false,
			cell: ({ row }) => renderSnippet(stateCell, { user: row.original })
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

	/**
	 * Можно ли выключить эту запись. Демонстрационная при включённом демо-режиме
	 * не выключается: ею входят все, кто открыл стенд, а включить её обратно
	 * оттуда же будет некому — сервис отказывает, и кнопки тут быть не должно.
	 *
	 * Режим стенда приезжает из `(app)/+layout.server.ts` вместе с оболочкой:
	 * он один на всё приложение, и спрашивать его второй раз в этом загрузчике
	 * значило бы завести второй ответ на тот же вопрос.
	 */
	function canDeactivate(user: UserView): boolean {
		return user.isActive && !(user.isDemo && data.demoMode);
	}

	function askDeactivate(user: UserView) {
		pending = user;
		confirmOpen = true;
	}
</script>

<svelte:head>
	<title>Пользователи — Альма CRM</title>
</svelte:head>

{#snippet stateCell({ user }: { user: UserView })}
	<span class="flex flex-wrap items-center gap-1">
		<StatusBadge tone={user.isActive ? 'success' : 'neutral'}>
			{user.isActive ? 'Работает' : 'Выключен'}
		</StatusBadge>
		{#if user.isDemo}
			<StatusBadge tone="warning" title="Учётная запись публичной демонстрации">Демо</StatusBadge>
		{/if}
		{#if user.roleId === 'service'}
			<StatusBadge tone="neutral" title="Машинный субъект: от его имени работают ключи обмена">
				Внешняя система
			</StatusBadge>
		{:else if !user.isLinked}
			<StatusBadge tone="neutral" title="Запись ещё ни разу не входила через каталог">
				Не связан
			</StatusBadge>
		{/if}
	</span>
{/snippet}

{#snippet managerCell({ user }: { user: UserView })}
	<ManagerSelect
		userId={user.id}
		fullName={user.fullName}
		managerUserId={user.managerUserId}
		options={data.managerOptions.filter((option) => option.id !== user.id)}
		disabled={user.roleId === 'service'}
	/>
{/snippet}

{#snippet actionsCell({ user }: { user: UserView })}
	<!-- `data-tour` — метка подсказок по этому экрану (`$lib/onboarding/screens`);
		рамка встаёт вокруг команд первой строки списка. -->
	<span data-tour="users-actions" class="flex flex-wrap justify-end gap-2">
		{#if user.isLinked && user.roleId !== 'service'}
			<!-- Каталог перезавели — субъект у того же человека стал другим, и вход
			     его не узнаёт. Отвязка возвращает запись в состояние «свяжется при
			     первом входе по подтверждённой почте», не трогая портфель. -->
			<form method="POST" action="?/unlink">
				<input type="hidden" name="userId" value={user.id} />
				<Button type="submit" variant="outline" size="sm">Отвязать</Button>
			</form>
		{/if}
		{#if canDeactivate(user)}
			<Button variant="outline" size="sm" onclick={() => askDeactivate(user)}>Выключить</Button>
		{:else if !user.isActive}
			<!-- Включение обратно не спрашивает подтверждения: оно ничего не отнимает и
		     отменяется тем же выключением. Поэтому не диалог, а форма прямо в
		     строке — со своим идентификатором, без общего состояния страницы. -->
			<form method="POST" action="?/activate">
				<input type="hidden" name="userId" value={user.id} />
				<Button type="submit" variant="outline" size="sm">Включить</Button>
			</form>
		{/if}
	</span>
{/snippet}

{#if switchMessage}
	<Alert.Root variant={switchFailed ? 'destructive' : 'default'}>
		<Alert.Description>{switchMessage}</Alert.Description>
	</Alert.Root>
{/if}

<Card.Root>
	<Card.Header>
		<Card.Title>Пользователи</Card.Title>
		<Card.Description>
			Учётные записи не удаляются, а выключаются: за каждой стоят записи журнала, и удаление стёрло
			бы историю. Выключение гасит сессии сразу, включение открывает вход обратно.
		</Card.Description>
	</Card.Header>
	<Card.Content class="flex flex-col gap-4">
		<InlineHint>
			Роль и имя приходят из каталога учётных записей при каждом входе — отсюда они не меняются.
			Новый сотрудник появляется в этом списке сам, когда впервые войдёт; заводят его в каталоге.
			Здесь задаётся то, чего в каталоге нет: кому сотрудник подчиняется — от этого зависит, чью
			работу видит руководитель и кому уходит эскалация.
		</InlineHint>

		<!-- `data-tour` — метка подсказок по этому экрану (`$lib/onboarding/screens`).
			Обёртка без оформления: у списка своя разметка, а `min-w-0` оставляет ей
			право сжиматься в колонке. -->
		<div data-tour="users-list" class="min-w-0">
			<DataTable
				{columns}
				rows={data.users.items}
				total={data.users.total}
				getRowId={(user) => user.id}
				searchPlaceholder="Поиск по почте и имени"
				emptyTitle={search === '' ? 'Пользователей пока нет' : 'Ничего не найдено'}
				emptyDescription={search === ''
					? undefined
					: 'Поиск идёт по почте и имени — проверьте, что ищете именно их.'}
			/>
		</div>
	</Card.Content>
</Card.Root>

<ConfirmDialog
	bind:open={confirmOpen}
	title="Выключить учётную запись?"
	description={pending === null
		? undefined
		: `${pending.fullName} (${pending.email}) потеряет доступ немедленно: все его сессии завершатся. Включить запись обратно можно здесь же.`}
	confirmLabel="Выключить"
	tone="danger"
	onconfirm={() => deactivateForm?.requestSubmit()}
/>

<!-- Диалог только подтверждает; отправляет обычная форма — так на сервер приходит
	то же самое, что от любой другой формы раздела, и действие одно на все пути. -->
<form method="POST" action="?/deactivate" bind:this={deactivateForm} class="hidden">
	<input type="hidden" name="userId" value={pending?.id ?? ''} />
</form>
