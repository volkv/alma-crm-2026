<script lang="ts">
	import { tick, untrack } from 'svelte';
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import type { SubmitFunction } from '@sveltejs/kit';
	import { superForm } from 'sveltekit-superforms';
	import { zod4Client } from 'sveltekit-superforms/adapters';
	import { toast } from 'svelte-sonner';
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import * as Alert from '$lib/components/ui/alert/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Select from '$lib/components/ui/select/index.js';
	import * as Table from '$lib/components/ui/table/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import ConfirmDialog from '$lib/components/confirm-dialog.svelte';
	import Flash from '$lib/components/directory/flash.svelte';
	import FieldInput from '$lib/components/form/field-input.svelte';
	import FieldTextarea from '$lib/components/form/field-textarea.svelte';
	import FormActions from '$lib/components/form/form-actions.svelte';
	import KeyValue from '$lib/components/key-value.svelte';
	import KeyValueRow from '$lib/components/key-value-row.svelte';
	import StatusBadge from '$lib/components/status-badge.svelte';
	import WorkspaceModules from '$lib/components/workspace-settings/workspace-modules.svelte';
	import { formatDate, formatNumber } from '$lib/format';
	import { renameWorkspaceSchema, type WorkspaceMemberView } from '$lib/contracts/interactions';
	import type { PageProps } from './$types';

	let { data, form: actionResult }: PageProps = $props();

	const workspace = $derived(data.workspace);

	/**
	 * Значение пункта «процесс не назначен». Пустая строка тут не годится: для
	 * списка она означает «ничего не выбрано», и пункт стал бы неотличим от
	 * пустоты, — а в форму всё равно уходит пустая строка.
	 */
	const NONE = '__none';

	/**
	 * Назначение, модули и состав приходят обычным ответом действия, а не через
	 * superforms. Успех помечен `ok`: отказ без претензий к полям (например,
	 * «сотрудник уже в пространстве») — всё равно отказ, и выглядеть обязан так же.
	 */
	const rowMessage = $derived(
		actionResult !== null && 'message' in actionResult ? actionResult.message : null
	);
	const rowFailed = $derived(
		actionResult !== null && 'message' in actionResult && !('ok' in actionResult)
	);

	// Форма не сбрасывается после сохранения: в полях остаётся записанное, а
	// не то, что было при открытии страницы.
	const {
		form: renameData,
		errors: renameErrors,
		enhance: renameEnhance,
		submitting: renameSubmitting
	} = superForm(
		untrack(() => data.renameForm),
		{
			validators: zod4Client(renameWorkspaceSchema),
			resetForm: false,
			onUpdated: ({ form }) => {
				if (typeof form.message === 'string') {
					toast.success(form.message);
				}
			}
		}
	);

	/**
	 * Можно ли предложить смену процесса. Назначить первый процесс можно всегда;
	 * сменить назначенный — только пока в пространстве нет взаимодействий: ключи
	 * стадий нового процесса ничего не значат для записей старого. Правило одно,
	 * и живёт оно в команде; форма лишь не предлагает того, что заведомо
	 * невозможно.
	 */
	const canAssign = $derived(workspace.workflow === null || workspace.interactions === 0);

	/**
	 * Выбор процесса рисуем мы, и отправить себя он может только из
	 * обработчика — поэтому рядом стоит скрытая форма, которую он заполняет и
	 * отправляет.
	 */
	let assignForm = $state<HTMLFormElement | null>(null);
	let assignWorkflowKey = $state('');

	async function assign(workflowKey: string) {
		assignWorkflowKey = workflowKey === NONE ? '' : workflowKey;

		// Отправка ждёт `tick()`, иначе запрос уйдёт с прежним значением скрытого
		// поля, которое Svelte ещё не успел записать в разметку.
		await tick();
		assignForm?.requestSubmit();
	}

	/** Процессы списком выбора: в подписи — число стадий, иначе выбор вслепую. */
	const workflowOptions = $derived(
		data.workflows.map((workflow) => ({
			value: workflow.key,
			label: `${workflow.name} — стадий: ${formatNumber(workflow.stageCount)}`
		}))
	);

	/**
	 * Исключение идёт одной скрытой формой на весь блок состава — тем же
	 * приёмом, что и назначение процесса. Если за сотрудником числятся
	 * незавершённые записи пространства, сначала спрашивается подтверждение:
	 * исключённый перестаёт их видеть, и это должно быть решением, а не
	 * случайностью. Команда без подтверждения откажет и сама.
	 */
	let removeForm = $state<HTMLFormElement | null>(null);
	let removeUserId = $state('');
	let removeConfirmed = $state(false);
	let confirmOpen = $state(false);
	let confirmText = $state('');
	let pendingRemoval = $state<WorkspaceMemberView | null>(null);

	async function submitRemove(member: WorkspaceMemberView) {
		removeUserId = member.userId;
		removeConfirmed = member.ownedActive > 0;

		await tick();
		removeForm?.requestSubmit();
	}

	function askRemove(member: WorkspaceMemberView) {
		if (member.ownedActive === 0) {
			void submitRemove(member);
			return;
		}

		pendingRemoval = member;
		confirmText = `${member.fullName} отвечает за незавершённые взаимодействия пространства «${workspace.name}»: ${formatNumber(member.ownedActive)}. После исключения он перестанет их видеть — записи останутся за ним, пока их не передадут другому ответственному.`;
		confirmOpen = true;
	}

	/** Выбранный для включения сотрудник. */
	let addChoice = $state('');

	// Включённый уходит из списка кандидатов — выбор за ним не остаётся.
	const submitAdd: SubmitFunction = () => {
		return async ({ result, update }) => {
			await update();

			if (result.type === 'success') {
				addChoice = '';
			}
		};
	};

	/** Кого ещё можно включить: действующие сотрудники не из состава. */
	const candidates = $derived.by(() => {
		if (data.members === null) {
			return [];
		}

		const inside = new Set(data.members.list.map((member) => member.userId));

		return data.members.candidates.filter((candidate) => !inside.has(candidate.userId));
	});
</script>

<svelte:head>
	<title>{workspace.name} — пространство — Альма CRM</title>
</svelte:head>

<Flash
	messages={{
		created: 'Пространство заведено. Назначьте процесс, подключите модули и включите сотрудников'
	}}
/>

{#if rowMessage}
	<Alert.Root variant={rowFailed ? 'destructive' : 'default'}>
		<Alert.Description>{rowMessage}</Alert.Description>
	</Alert.Root>
{/if}

<Card.Root>
	<Card.Header>
		<Card.Title>Основное</Card.Title>
		<Card.Description>
			Название и пояснение видны в меню и в заголовке доски. Ключ стоит в адресе доски и
			переименованием не меняется — иначе разосланные ссылки и закладки перестали бы открываться.
		</Card.Description>
		<Card.Action>
			<Button
				variant="outline"
				size="sm"
				href={resolve('/(app)/w/[workspace]/interactions', { workspace: workspace.key })}
			>
				Доска пространства
				<ArrowRightIcon aria-hidden="true" />
			</Button>
		</Card.Action>
	</Card.Header>
	<Card.Content class="flex flex-col gap-6">
		<KeyValue>
			<KeyValueRow label="Ключ">
				<!-- Ключ моноширинным: его сверяют с адресом в строке браузера. -->
				<code class="text-xs">{workspace.key}</code>
			</KeyValueRow>
			<KeyValueRow label="Незавершённых взаимодействий">
				{formatNumber(workspace.activeInteractions)}
				<span class="text-muted-foreground">
					из {formatNumber(workspace.interactions)} заведённых
				</span>
			</KeyValueRow>
		</KeyValue>

		{#if $renameErrors._errors}
			<Alert.Root variant="destructive">
				<Alert.Description>
					<ul class="list-inside list-disc">
						{#each $renameErrors._errors as issue (issue)}
							<li>{issue}</li>
						{/each}
					</ul>
				</Alert.Description>
			</Alert.Root>
		{/if}

		<!-- novalidate: проверяет схема и говорит по-русски, а не браузер на своём языке. -->
		<form method="POST" action="?/rename" use:renameEnhance novalidate class="flex flex-col gap-4">
			<FieldInput
				name="name"
				label="Название"
				required
				bind:value={$renameData.name}
				errors={$renameErrors.name}
			/>
			<FieldTextarea
				name="description"
				label="Кого ведём"
				description="Одна строка о том, чем это направление отличается от соседних. Можно оставить пустым."
				rows={2}
				bind:value={
					() => $renameData.description ?? '',
					(next) => ($renameData.description = next === '' ? null : next)
				}
				errors={$renameErrors.description}
			/>
			<FormActions submitting={$renameSubmitting} submitLabel="Сохранить название" />
		</form>

		<section class="flex flex-col gap-2" aria-labelledby="workspace-workflow">
			<h3 id="workspace-workflow" class="section-title">Процесс</h3>
			{#if canAssign}
				<Select.Root
					type="single"
					value={workspace.workflow?.key ?? NONE}
					onValueChange={(next) => assign(next)}
				>
					<Select.Trigger class="w-full sm:w-96" aria-label="Процесс пространства">
						{workspace.workflow?.name ?? 'Не назначен'}
					</Select.Trigger>
					<Select.Content>
						<Select.Item value={NONE} label="Не назначен" />
						{#each workflowOptions as option (option.value)}
							<Select.Item value={option.value} label={option.label} />
						{/each}
					</Select.Content>
				</Select.Root>
				{#if workspace.workflow === null}
					<span>
						<StatusBadge tone="warning">Взаимодействия заводить нечем</StatusBadge>
					</span>
				{:else}
					<p class="text-sm text-muted-foreground">
						Стадий в действующей редакции: {formatNumber(workspace.stageCount)}.
						<a
							class="rounded-sm text-link underline-offset-4 focus-ring hover:text-link-hover hover:underline"
							href={resolve('/(app)/settings/workflows/[key]', { key: workspace.workflow.key })}
						>
							Открыть процесс
						</a>
					</p>
				{/if}
				<p class="text-xs text-muted-foreground">
					Один процесс можно назначить нескольким пространствам. Сменить процесс можно, пока в
					пространстве нет ни одного взаимодействия.
				</p>
			{:else if workspace.workflow !== null}
				<!-- Выбора нет, потому что смена невозможна, а не потому, что её забыли
					предложить: причина стоит рядом. Сама проверка — в команде. -->
				<p class="text-sm">
					<a
						class="rounded-sm font-medium text-link underline-offset-4 focus-ring hover:text-link-hover hover:underline"
						href={resolve('/(app)/settings/workflows/[key]', { key: workspace.workflow.key })}
					>
						{workspace.workflow.name}
					</a>
					<span class="text-muted-foreground">
						— стадий: {formatNumber(workspace.stageCount)}
					</span>
				</p>
				<p class="text-xs text-muted-foreground">
					Сменить процесс нельзя: в пространстве уже есть взаимодействия, и ключи стадий другого
					процесса для них ничего не значат. Для работы по другому сценарию заведите отдельное
					пространство.
				</p>
			{/if}
		</section>
	</Card.Content>
</Card.Root>

<!-- Выбор процесса только называет значение; отправляет эта форма. -->
<form method="POST" action="?/assign" bind:this={assignForm} use:enhance class="hidden">
	<input type="hidden" name="workflowKey" value={assignWorkflowKey} />
</form>

<Card.Root>
	<Card.Header>
		<Card.Title>Модули</Card.Title>
		<Card.Description>
			Модуль добавляет пространству панели карточки, факты в шапке, действия и пункты меню.
			Действует он, если подключён или если его требует стадия процесса. Выключение прячет панели и
			действия модуля, но не стирает записанного в них: подключите модуль снова — и данные вернутся
			на место. Панель модуля видна в карточке, только если её выбрал и процесс пространства.
		</Card.Description>
	</Card.Header>
	<Card.Content>
		<WorkspaceModules modules={data.modules} workflow={workspace.workflow} />
	</Card.Content>
</Card.Root>

{#if data.members !== null}
	<Card.Root>
		<Card.Header>
			<Card.Title>Сотрудники</Card.Title>
			<Card.Description>
				Сотрудник видит взаимодействия только тех пространств, в которые включён; внутри действует
				его обычная область — свои вузы и работа подчинённых. Администратор видит все пространства
				без включения. Справочники общие: организации и контакты видны независимо от пространства.
			</Card.Description>
		</Card.Header>
		<Card.Content class="flex flex-col gap-4">
			{#if data.members.list.length === 0}
				<p class="text-sm text-muted-foreground">
					В пространстве пока никого: его работу видит только администратор.
				</p>
			{:else}
				<div class="overflow-x-auto">
					<Table.Root>
						<Table.Header>
							<Table.Row class="hover:bg-transparent">
								<Table.Head>Сотрудник</Table.Head>
								<Table.Head class="w-40">Роль</Table.Head>
								<Table.Head class="w-32">В пространстве с</Table.Head>
								<Table.Head class="w-36 text-right">Отвечает за</Table.Head>
								<Table.Head class="w-32"><span class="sr-only">Действия</span></Table.Head>
							</Table.Row>
						</Table.Header>
						<Table.Body>
							{#each data.members.list as member (member.userId)}
								<Table.Row>
									<Table.Cell class="font-medium whitespace-normal">
										{member.fullName}
										{#if !member.isActive}
											<StatusBadge tone="neutral">Выключен</StatusBadge>
										{/if}
									</Table.Cell>
									<Table.Cell>{member.roleName}</Table.Cell>
									<Table.Cell>{formatDate(member.since)}</Table.Cell>
									<Table.Cell class="text-right">
										{formatNumber(member.ownedActive)}
									</Table.Cell>
									<Table.Cell class="text-right">
										<Button
											variant="outline"
											size="sm"
											aria-label="Исключить из пространства: {member.fullName}"
											onclick={() => askRemove(member)}
										>
											Исключить
										</Button>
									</Table.Cell>
								</Table.Row>
							{/each}
						</Table.Body>
					</Table.Root>
				</div>
			{/if}

			{#if candidates.length > 0}
				<form
					method="POST"
					action="?/addMember"
					use:enhance={submitAdd}
					class="flex flex-wrap items-center gap-2"
				>
					<input type="hidden" name="userId" value={addChoice} />
					<Select.Root type="single" value={addChoice} onValueChange={(next) => (addChoice = next)}>
						<Select.Trigger class="w-72" aria-label="Кого включить в пространство">
							{candidates.find((candidate) => candidate.userId === addChoice)?.fullName ??
								'Выберите сотрудника'}
						</Select.Trigger>
						<Select.Content>
							{#each candidates as candidate (candidate.userId)}
								<Select.Item
									value={candidate.userId}
									label="{candidate.fullName} — {candidate.roleName}"
								/>
							{/each}
						</Select.Content>
					</Select.Root>
					<Button type="submit" size="sm" variant="outline" disabled={addChoice === ''}>
						<PlusIcon aria-hidden="true" />
						Включить
					</Button>
				</form>
			{/if}
		</Card.Content>
	</Card.Root>

	<form method="POST" action="?/removeMember" bind:this={removeForm} use:enhance class="hidden">
		<input type="hidden" name="userId" value={removeUserId} />
		<input type="hidden" name="confirmOwned" value={removeConfirmed ? 'true' : 'false'} />
	</form>

	<ConfirmDialog
		bind:open={confirmOpen}
		title="Исключить сотрудника, у которого есть работа?"
		description={confirmText}
		confirmLabel="Исключить"
		tone="danger"
		onconfirm={async () => {
			if (pendingRemoval !== null) {
				await submitRemove(pendingRemoval);
				pendingRemoval = null;
			}
		}}
	/>
{/if}
