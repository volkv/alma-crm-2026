<script lang="ts">
	import { untrack } from 'svelte';
	import { enhance } from '$app/forms';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { superForm } from 'sveltekit-superforms';
	import { zod4Client } from 'sveltekit-superforms/adapters';
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import ChevronUpIcon from '@lucide/svelte/icons/chevron-up';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import * as Alert from '$lib/components/ui/alert/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import * as Table from '$lib/components/ui/table/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import EmptyState from '$lib/components/empty-state.svelte';
	import FieldInput from '$lib/components/form/field-input.svelte';
	import FieldSelect from '$lib/components/form/field-select.svelte';
	import FieldTextarea from '$lib/components/form/field-textarea.svelte';
	import FormActions from '$lib/components/form/form-actions.svelte';
	import InlineHint from '$lib/components/inline-hint.svelte';
	import StatusBadge from '$lib/components/status-badge.svelte';
	import { formatNumber } from '$lib/format';
	import { ADDRESS_KEY_STYLE, keyFromName } from '$lib/key-from-name';
	import { createWorkspaceSchema } from '$lib/contracts/interactions';
	import type { PageProps } from './$types';

	let { data, form: actionResult }: PageProps = $props();

	/**
	 * Перестановка отвечает обычным ответом действия, а не через superforms.
	 * Успех помечен `ok`: отказ без претензий к полям — всё равно отказ, и
	 * выглядеть обязан так же.
	 */
	const rowMessage = $derived(
		actionResult !== null && 'message' in actionResult ? actionResult.message : null
	);
	const rowFailed = $derived(
		actionResult !== null && 'message' in actionResult && !('ok' in actionResult)
	);

	let createOpen = $state(false);

	// Успех заведения — переход на страницу нового пространства, а сообщение
	// о нём показывает уже она; здесь остаются только ошибки формы.
	const {
		form: createData,
		errors: createErrors,
		enhance: createEnhance,
		submitting: createSubmitting
	} = superForm(
		untrack(() => data.createForm),
		{ validators: zod4Client(createWorkspaceSchema) }
	);

	/** Ключ правили руками — название его больше не переписывает. */
	let keyEdited = $state(false);

	const takenKeys = $derived(new Set(data.workspaces.map((workspace) => workspace.key)));

	function rename(next: string) {
		$createData.name = next;

		if (!keyEdited) {
			$createData.key = keyFromName(next, ADDRESS_KEY_STYLE, takenKeys);
		}
	}

	/**
	 * Ключи в том порядке, в каком они встанут после перестановки строки.
	 * Команда принимает список целиком: позиции уникальны, и перестановка идёт
	 * сдвигом соседей одной транзакцией, а не записью одного значения.
	 */
	function reordered(index: number, delta: number): string[] {
		const keys = data.workspaces.map((workspace) => workspace.key);
		const target = index + delta;

		if (target < 0 || target >= keys.length) {
			return keys;
		}

		[keys[index], keys[target]] = [keys[target]!, keys[index]!];

		return keys;
	}

	function open(key: string) {
		return goto(resolve('/(app)/settings/workspaces/[key]', { key }));
	}

	/** Процессы списком выбора: в подписи — число стадий, иначе выбор вслепую. */
	const workflowOptions = $derived(
		data.workflows.map((workflow) => ({
			value: workflow.key,
			label: `${workflow.name} — стадий: ${formatNumber(workflow.stageCount)}`
		}))
	);
</script>

<svelte:head>
	<title>Пространства — Альма CRM</title>
</svelte:head>

{#if rowMessage}
	<Alert.Root variant={rowFailed ? 'destructive' : 'default'}>
		<Alert.Description>{rowMessage}</Alert.Description>
	</Alert.Root>
{/if}

<!-- Перестановка — обычная форма со списком ключей: она работает и без
	JavaScript, и `enhance` нужен ей только ради ответа без перезагрузки. -->
{#snippet moveButton(index: number, delta: number, label: string)}
	<form method="POST" action="?/reorder" use:enhance>
		{#each reordered(index, delta) as key (key)}
			<input type="hidden" name="keys" value={key} />
		{/each}
		<Button
			type="submit"
			variant="outline"
			size="icon"
			aria-label={label}
			title={label}
			disabled={delta < 0 ? index === 0 : index === data.workspaces.length - 1}
		>
			{#if delta < 0}
				<ChevronUpIcon aria-hidden="true" />
			{:else}
				<ChevronDownIcon aria-hidden="true" />
			{/if}
		</Button>
	</form>
{/snippet}

<Card.Root>
	<Card.Header>
		<Card.Title>Пространства</Card.Title>
		<Card.Description>
			Пространство — рабочее место направления: своя секция в меню, свои взаимодействия и
			назначенный процесс. Порядок строк — это порядок секций в боковом меню. Название, процесс,
			модули и сотрудники пространства настраиваются на его странице — откройте её по названию.
		</Card.Description>
		<Card.Action>
			<!-- `data-tour` — метка подсказок по этому экрану (`$lib/onboarding/screens`). -->
			<Button data-tour="workspaces-create" size="sm" onclick={() => (createOpen = true)}>
				<PlusIcon aria-hidden="true" />
				Создать пространство
			</Button>
		</Card.Action>
	</Card.Header>
	<Card.Content class="flex flex-col gap-4">
		<InlineHint>
			Пространство без назначенного процесса — законное состояние: секция в меню у него есть, а
			создать в нём взаимодействие нельзя, потому что стадии, на которую его ставить, ещё не
			существует. Назначьте процесс на странице пространства — и доска заработает.
		</InlineHint>

		{#if data.workspaces.length === 0}
			<EmptyState
				title="Пространств нет"
				description="Создайте первое направление работы: у него появится своя секция в меню и своя доска взаимодействий."
			/>
		{:else}
			<!-- `data-tour` — метка подсказок по этому экрану (`$lib/onboarding/screens`);
				метка `workspaces` уже занята карточкой раздела «Процесс». -->
			<div data-tour="settings-workspaces" class="overflow-x-auto">
				<Table.Root>
					<Table.Header>
						<Table.Row class="hover:bg-transparent">
							<Table.Head>Пространство</Table.Head>
							<Table.Head class="w-32">Ключ</Table.Head>
							<Table.Head class="w-56">Процесс</Table.Head>
							<Table.Head class="w-32 text-right">Незавершённых</Table.Head>
							{#if data.memberCounts !== null}
								<Table.Head class="w-32 text-right">Сотрудников</Table.Head>
							{/if}
							<Table.Head class="w-64">Модули</Table.Head>
							<Table.Head class="w-24">Порядок</Table.Head>
							<Table.Head class="w-32"><span class="sr-only">Действия</span></Table.Head>
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{#each data.workspaces as workspace, index (workspace.id)}
							{@const modules = data.activeModules[workspace.key] ?? []}
							<Table.Row class="cursor-pointer align-top" onclick={() => void open(workspace.key)}>
								<Table.Cell
									class="font-medium whitespace-normal"
									onclick={(event) => event.stopPropagation()}
								>
									<a
										class="rounded-sm text-link underline-offset-4 focus-ring hover:text-link-hover hover:underline"
										href={resolve('/(app)/settings/workspaces/[key]', { key: workspace.key })}
									>
										{workspace.name}
									</a>
									{#if workspace.description}
										<span class="mt-0.5 block text-xs font-normal text-muted-foreground">
											{workspace.description}
										</span>
									{/if}
								</Table.Cell>
								<Table.Cell>
									<!-- Ключ моноширинным: его сверяют с адресом в строке браузера. -->
									<code class="text-xs">{workspace.key}</code>
								</Table.Cell>
								<Table.Cell class="whitespace-normal">
									{#if workspace.workflow === null}
										<StatusBadge tone="warning">Не назначен</StatusBadge>
									{:else}
										{workspace.workflow.name}
										<span class="block text-xs text-muted-foreground">
											Стадий: {formatNumber(workspace.stageCount)}
										</span>
									{/if}
								</Table.Cell>
								<Table.Cell class="text-right">
									{formatNumber(workspace.activeInteractions)}
								</Table.Cell>
								{#if data.memberCounts !== null}
									<Table.Cell class="text-right">
										{formatNumber(data.memberCounts[workspace.key] ?? 0)}
									</Table.Cell>
								{/if}
								<Table.Cell class="whitespace-normal">
									{#if modules.length === 0}
										<span class="text-muted-foreground">—</span>
									{:else}
										<span class="flex flex-wrap gap-1">
											{#each modules as label (label)}
												<StatusBadge tone="neutral">{label}</StatusBadge>
											{/each}
										</span>
									{/if}
								</Table.Cell>
								<Table.Cell onclick={(event) => event.stopPropagation()}>
									<div class="flex items-center gap-1">
										{@render moveButton(index, -1, `Поднять выше: ${workspace.name}`)}
										{@render moveButton(index, 1, `Опустить ниже: ${workspace.name}`)}
									</div>
								</Table.Cell>
								<Table.Cell class="text-right" onclick={(event) => event.stopPropagation()}>
									<!-- Ссылка, а не кнопка: открывает адрес, и открывать его
										должны уметь и средняя кнопка мыши, и клавиатура. -->
									<Button
										variant="outline"
										size="sm"
										href={resolve('/(app)/settings/workspaces/[key]', { key: workspace.key })}
										aria-label="Настроить пространство: {workspace.name}"
									>
										Настроить
										<ArrowRightIcon aria-hidden="true" />
									</Button>
								</Table.Cell>
							</Table.Row>
						{/each}
					</Table.Body>
				</Table.Root>
			</div>
		{/if}
	</Card.Content>
</Card.Root>

<Dialog.Root bind:open={createOpen}>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>Создать пространство</Dialog.Title>
			<Dialog.Description>
				Направление работы со своей доской и своей секцией в меню. Процесс можно назначить сразу, а
				можно позже — пространство без него заводится и живёт, только взаимодействий в нём ещё нет.
				После заведения откроется страница пространства: там подключают модули и включают
				сотрудников.
			</Dialog.Description>
		</Dialog.Header>

		{#if $createErrors._errors}
			<Alert.Root variant="destructive" class="mb-4">
				<Alert.Description>
					<ul class="list-inside list-disc">
						{#each $createErrors._errors as issue (issue)}
							<li>{issue}</li>
						{/each}
					</ul>
				</Alert.Description>
			</Alert.Root>
		{/if}

		<!-- novalidate: проверяет схема и говорит по-русски, а не браузер на своём языке. -->
		<form
			method="POST"
			action="?/create"
			use:createEnhance
			novalidate
			class="flex flex-col gap-form"
		>
			<FieldInput
				name="name"
				label="Название"
				required
				placeholder="Корпоративное обучение"
				bind:value={() => $createData.name, rename}
				errors={$createErrors.name}
			/>
			<FieldInput
				name="key"
				label="Ключ"
				required
				description="Собирается из названия; поправьте, если хотите. Строчные латинские буквы, цифры и дефис — ключ встанет в адрес доски навсегда: переименование его не меняет."
				placeholder="korporativnoe-obuchenie"
				bind:value={
					() => $createData.key,
					(next) => {
						keyEdited = true;
						$createData.key = next;
					}
				}
				errors={$createErrors.key}
			/>
			<FieldTextarea
				name="description"
				label="Кого ведём"
				description="Одна строка о том, чем это направление отличается от соседних. Можно оставить пустым."
				rows={2}
				bind:value={
					() => $createData.description ?? '',
					(next) => ($createData.description = next === '' ? null : next)
				}
				errors={$createErrors.description}
			/>
			<FieldSelect
				name="workflowKey"
				label="Процесс"
				description="Один процесс можно назначить нескольким пространствам — тогда правка процесса меняет работу во всех. Своя работа — свой процесс: создайте его в «Процессах», пустым или копией."
				options={workflowOptions}
				placeholder="Назначить позже"
				bind:value={
					() => $createData.workflowKey ?? '',
					(next) => ($createData.workflowKey = next === '' ? null : next)
				}
				errors={$createErrors.workflowKey}
			/>
			<FormActions
				submitting={$createSubmitting}
				submitLabel="Создать пространство"
				oncancel={() => (createOpen = false)}
			/>
		</form>
	</Dialog.Content>
</Dialog.Root>
