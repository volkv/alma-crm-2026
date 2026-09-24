<script lang="ts">
	import { tick, untrack } from 'svelte';
	import { enhance } from '$app/forms';
	import { superForm } from 'sveltekit-superforms';
	import { zod4Client } from 'sveltekit-superforms/adapters';
	import { toast } from 'svelte-sonner';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import ChevronUpIcon from '@lucide/svelte/icons/chevron-up';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import * as Alert from '$lib/components/ui/alert/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import * as Select from '$lib/components/ui/select/index.js';
	import * as Table from '$lib/components/ui/table/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import ConfirmDialog from '$lib/components/confirm-dialog.svelte';
	import EmptyState from '$lib/components/empty-state.svelte';
	import FieldInput from '$lib/components/form/field-input.svelte';
	import FieldSelect from '$lib/components/form/field-select.svelte';
	import FieldTextarea from '$lib/components/form/field-textarea.svelte';
	import FormActions from '$lib/components/form/form-actions.svelte';
	import InlineHint from '$lib/components/inline-hint.svelte';
	import StatusBadge from '$lib/components/status-badge.svelte';
	import { formatDate, formatNumber } from '$lib/format';
	import {
		createWorkspaceSchema,
		renameWorkspaceSchema,
		type WorkspaceMemberView,
		type WorkspaceMembership,
		type WorkspaceSummary
	} from '$lib/contracts/interactions';
	import type { PageProps } from './$types';

	let { data, form: actionResult }: PageProps = $props();

	/**
	 * Значение пункта «процесс не назначен». Пустая строка тут не годится: для
	 * списка она означает «ничего не выбрано», и пункт стал бы неотличим от
	 * пустоты, — а в форму всё равно уходит пустая строка.
	 */
	const NONE = '__none';

	/**
	 * Назначение, порядок и состав приходят обычным ответом действия, а не через
	 * superforms. Успех помечен `ok`: отказ без претензий к полям (например,
	 * «сотрудник уже в пространстве») — всё равно отказ, и выглядеть обязан так же.
	 */
	const rowMessage = $derived(
		actionResult !== null && 'message' in actionResult ? actionResult.message : null
	);
	const rowFailed = $derived(
		actionResult !== null && 'message' in actionResult && !('ok' in actionResult)
	);

	let createOpen = $state(false);
	let renameOpen = $state(false);

	const {
		form: createData,
		errors: createErrors,
		enhance: createEnhance,
		submitting: createSubmitting,
		reset: resetCreate
	} = superForm(
		untrack(() => data.createForm),
		{
			validators: zod4Client(createWorkspaceSchema),
			onUpdated: ({ form }) => {
				if (typeof form.message === 'string') {
					toast.success(form.message);
					createOpen = false;
					resetCreate();
				}
			}
		}
	);

	const {
		form: renameData,
		errors: renameErrors,
		enhance: renameEnhance,
		submitting: renameSubmitting
	} = superForm(
		untrack(() => data.renameForm),
		{
			validators: zod4Client(renameWorkspaceSchema),
			onUpdated: ({ form }) => {
				if (typeof form.message === 'string') {
					toast.success(form.message);
					renameOpen = false;
				}
			}
		}
	);

	/**
	 * Назначение процесса отправляет одна скрытая форма на всю таблицу, а не по
	 * форме в строке: выбор в строке рисуем мы, и отправить себя он может только
	 * из обработчика — ссылки на «свою» форму у него нет. Меняют за раз одно
	 * пространство, поэтому одной формы и хватает.
	 */
	let assignForm = $state<HTMLFormElement | null>(null);
	let assignKey = $state('');
	let assignWorkflowKey = $state('');

	async function assign(key: string, workflowKey: string) {
		assignKey = key;
		assignWorkflowKey = workflowKey === NONE ? '' : workflowKey;

		// Отправка ждёт `tick()`, иначе запрос уйдёт с прежним значением скрытых
		// полей, которое Svelte ещё не успел записать в разметку.
		await tick();
		assignForm?.requestSubmit();
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

	/**
	 * Можно ли предложить смену процесса. Назначить первый процесс можно всегда;
	 * сменить назначенный — только пока в пространстве нет взаимодействий: ключи
	 * стадий нового процесса ничего не значат для записей старого.
	 *
	 * Список знает только незавершённые, а команда считает все, поэтому выбор
	 * бывает открыт и там, где команда откажет: у пространства, где всё доведено
	 * до конца. Это не расхождение правил — правило одно, и живёт оно в команде;
	 * форма лишь не предлагает того, что заведомо невозможно.
	 */
	function canAssign(workspace: WorkspaceSummary): boolean {
		return workspace.workflow === null || workspace.interactions === 0;
	}

	function askRename(workspace: WorkspaceSummary) {
		$renameData.key = workspace.key;
		$renameData.name = workspace.name;
		$renameData.description = workspace.description;
		renameOpen = true;
	}

	/**
	 * Исключение идёт одной скрытой формой на весь блок состава — тем же
	 * приёмом, что и назначение процесса. Если за сотрудником числятся
	 * незавершённые записи пространства, сначала спрашивается подтверждение:
	 * исключённый перестаёт их видеть, и это должно быть решением, а не
	 * случайностью. Команда без подтверждения откажет и сама.
	 */
	let removeForm = $state<HTMLFormElement | null>(null);
	let removeKey = $state('');
	let removeUserId = $state('');
	let removeConfirmed = $state(false);
	let confirmOpen = $state(false);
	let confirmText = $state('');

	async function submitRemove(workspace: WorkspaceMembership, member: WorkspaceMemberView) {
		removeKey = workspace.key;
		removeUserId = member.userId;
		removeConfirmed = member.ownedActive > 0;

		await tick();
		removeForm?.requestSubmit();
	}

	let pendingRemoval = $state<{
		workspace: WorkspaceMembership;
		member: WorkspaceMemberView;
	} | null>(null);

	function askRemove(workspace: WorkspaceMembership, member: WorkspaceMemberView) {
		if (member.ownedActive === 0) {
			void submitRemove(workspace, member);
			return;
		}

		pendingRemoval = { workspace, member };
		confirmText = `${member.fullName} отвечает за незавершённые взаимодействия пространства «${workspace.name}»: ${formatNumber(member.ownedActive)}. После исключения он перестанет их видеть — записи останутся за ним, пока их не передадут другому ответственному.`;
		confirmOpen = true;
	}

	/** Выбранный для включения сотрудник — по пространству. */
	let addChoice = $state<Record<string, string>>({});

	/** Кого ещё можно включить в пространство: действующие сотрудники не из состава. */
	function candidatesFor(workspace: WorkspaceMembership) {
		const inside = new Set(workspace.members.map((member) => member.userId));

		return (data.memberships?.candidates ?? []).filter(
			(candidate) => !inside.has(candidate.userId)
		);
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

{#snippet formErrors(issues: string[] | undefined)}
	{#if issues}
		<Alert.Root variant="destructive" class="mb-4">
			<Alert.Description>
				<ul class="list-inside list-disc">
					{#each issues as issue (issue)}
						<li>{issue}</li>
					{/each}
				</ul>
			</Alert.Description>
		</Alert.Root>
	{/if}
{/snippet}

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
			назначенный процесс. Ключ пространства стоит в адресе доски (<code>/w/ключ/interactions</code
			>) и переименованием не меняется — иначе разосланные ссылки и закладки перестали бы
			открываться. Порядок строк — это порядок секций в боковом меню.
		</Card.Description>
		<Card.Action>
			<Button size="sm" onclick={() => (createOpen = true)}>
				<PlusIcon aria-hidden="true" />
				Завести пространство
			</Button>
		</Card.Action>
	</Card.Header>
	<Card.Content class="flex flex-col gap-4">
		<InlineHint>
			Пространство без назначенного процесса — законное состояние: секция в меню у него есть, а
			завести в нём взаимодействие нельзя, потому что стадии, на которую его ставить, ещё не
			существует. Назначьте процесс — и доска заработает.
		</InlineHint>

		{#if data.workspaces.length === 0}
			<EmptyState
				title="Пространств нет"
				description="Заведите первое направление работы: у него появится своя секция в меню и своя доска взаимодействий."
			/>
		{:else}
			<!-- `data-tour` — метка подсказок по этому экрану (`$lib/onboarding/screens`);
				метка `workspaces` уже занята карточкой раздела «Процесс». -->
			<div data-tour="settings-workspaces" class="overflow-x-auto">
				<Table.Root>
					<Table.Header>
						<Table.Row class="hover:bg-transparent">
							<Table.Head>Пространство</Table.Head>
							<Table.Head class="w-40">Ключ</Table.Head>
							<!-- Колонке выбора задана ширина: без неё браузер отдавал место
								названию, и список процессов сжимался до многоточия. -->
							<Table.Head class="w-72">Процесс</Table.Head>
							<Table.Head class="w-20 text-right">Стадий</Table.Head>
							<Table.Head class="w-32 text-right">Незавершённых</Table.Head>
							<Table.Head class="w-24">Порядок</Table.Head>
							<Table.Head class="w-36"><span class="sr-only">Действия</span></Table.Head>
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{#each data.workspaces as workspace, index (workspace.id)}
							<Table.Row class="align-top">
								<Table.Cell class="font-medium whitespace-normal">
									{workspace.name}
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
									{#if canAssign(workspace)}
										<Select.Root
											type="single"
											value={workspace.workflow?.key ?? NONE}
											onValueChange={(next) => assign(workspace.key, next)}
										>
											<Select.Trigger
												class="w-full"
												aria-label="Процесс пространства: {workspace.name}"
											>
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
											<span class="mt-1 block">
												<StatusBadge tone="warning">Взаимодействия заводить нечем</StatusBadge>
											</span>
										{/if}
									{:else}
										<!-- Выбора нет, потому что смена невозможна, а не потому, что
											её забыли предложить: причина стоит рядом. Сама проверка — в
											команде: адрес действия набирают и руками. -->
										<span class="block font-medium">{workspace.workflow?.name}</span>
										<span class="mt-1 block text-xs text-muted-foreground">
											Сменить процесс нельзя: в пространстве уже идут взаимодействия, и ключи стадий
											другого процесса для них ничего не значат. Для работы по другому сценарию
											заведите отдельное пространство.
										</span>
									{/if}
								</Table.Cell>
								<Table.Cell class="text-right">
									{workspace.workflow === null ? '—' : formatNumber(workspace.stageCount)}
								</Table.Cell>
								<Table.Cell class="text-right">
									{formatNumber(workspace.activeInteractions)}
								</Table.Cell>
								<Table.Cell>
									<div class="flex items-center gap-1">
										{@render moveButton(index, -1, `Поднять выше: ${workspace.name}`)}
										{@render moveButton(index, 1, `Опустить ниже: ${workspace.name}`)}
									</div>
								</Table.Cell>
								<Table.Cell class="text-right">
									<Button variant="outline" size="sm" onclick={() => askRename(workspace)}>
										Переименовать
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

{#if data.memberships}
	<Card.Root>
		<Card.Header>
			<Card.Title>Сотрудники пространств</Card.Title>
			<Card.Description>
				Сотрудник видит взаимодействия только тех пространств, в которые включён; внутри действует
				его обычная область — свои вузы и работа подчинённых. Администратор видит все пространства
				без включения. Справочники общие: организации и контакты видны независимо от пространства.
			</Card.Description>
		</Card.Header>
		<Card.Content class="flex flex-col gap-6" data-tour="settings-workspace-members">
			{#each data.memberships.workspaces as workspace (workspace.id)}
				{@const candidates = candidatesFor(workspace)}
				<section class="flex flex-col gap-3" aria-labelledby="members-{workspace.key}">
					<h3 id="members-{workspace.key}" class="section-title">{workspace.name}</h3>

					{#if workspace.members.length === 0}
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
									{#each workspace.members as member (member.userId)}
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
													aria-label="Исключить из пространства «{workspace.name}»: {member.fullName}"
													onclick={() => askRemove(workspace, member)}
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
							use:enhance
							class="flex flex-wrap items-center gap-2"
						>
							<input type="hidden" name="key" value={workspace.key} />
							<input type="hidden" name="userId" value={addChoice[workspace.key] ?? ''} />
							<Select.Root
								type="single"
								value={addChoice[workspace.key] ?? ''}
								onValueChange={(next) => (addChoice[workspace.key] = next)}
							>
								<Select.Trigger
									class="w-72"
									aria-label="Кого включить в пространство «{workspace.name}»"
								>
									{candidates.find((candidate) => candidate.userId === addChoice[workspace.key])
										?.fullName ?? 'Выберите сотрудника'}
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
							<Button
								type="submit"
								size="sm"
								variant="outline"
								disabled={(addChoice[workspace.key] ?? '') === ''}
							>
								<PlusIcon aria-hidden="true" />
								Включить
							</Button>
						</form>
					{/if}
				</section>
			{/each}
		</Card.Content>
	</Card.Root>

	<form method="POST" action="?/removeMember" bind:this={removeForm} use:enhance class="hidden">
		<input type="hidden" name="key" value={removeKey} />
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
				await submitRemove(pendingRemoval.workspace, pendingRemoval.member);
				pendingRemoval = null;
			}
		}}
	/>
{/if}

<!-- Выбор в строке только называет значение; отправляет эта форма — действие
	одно на все строки. -->
<form method="POST" action="?/assign" bind:this={assignForm} use:enhance class="hidden">
	<input type="hidden" name="key" value={assignKey} />
	<input type="hidden" name="workflowKey" value={assignWorkflowKey} />
</form>

<Dialog.Root bind:open={createOpen}>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>Новое пространство</Dialog.Title>
			<Dialog.Description>
				Направление работы со своей доской и своей секцией в меню. Процесс можно назначить сразу, а
				можно позже — пространство без него заводится и живёт, только взаимодействий в нём ещё нет.
			</Dialog.Description>
		</Dialog.Header>

		{@render formErrors($createErrors._errors)}

		<!-- novalidate: проверяет схема и говорит по-русски, а не браузер на своём языке. -->
		<form method="POST" action="?/create" use:createEnhance novalidate class="flex flex-col gap-4">
			<FieldInput
				name="name"
				label="Название"
				required
				placeholder="Корпоративное обучение"
				bind:value={$createData.name}
				errors={$createErrors.name}
			/>
			<FieldInput
				name="key"
				label="Ключ"
				required
				description="Строчные латинские буквы, цифры и дефис. Ключ встанет в адрес доски и останется в нём навсегда: переименование его не меняет."
				placeholder="corporate"
				bind:value={$createData.key}
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
				description="Один процесс можно назначить нескольким пространствам: два направления по одному сценарию — это одно описание работы, а не две копии."
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
				submitLabel="Завести пространство"
				oncancel={() => (createOpen = false)}
			/>
		</form>
	</Dialog.Content>
</Dialog.Root>

<Dialog.Root bind:open={renameOpen}>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>Переименование пространства</Dialog.Title>
			<Dialog.Description>
				Меняются название и пояснение. Ключ <code>{$renameData.key}</code> остаётся прежним: он стоит
				в адресе доски, в закладках и в разосланных ссылках.
			</Dialog.Description>
		</Dialog.Header>

		{@render formErrors($renameErrors._errors)}

		<!-- novalidate: проверяет схема и говорит по-русски, а не браузер на своём языке. -->
		<form method="POST" action="?/rename" use:renameEnhance novalidate class="flex flex-col gap-4">
			<input type="hidden" name="key" value={$renameData.key} />
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
				rows={2}
				bind:value={
					() => $renameData.description ?? '',
					(next) => ($renameData.description = next === '' ? null : next)
				}
				errors={$renameErrors.description}
			/>
			<FormActions
				submitting={$renameSubmitting}
				submitLabel="Сохранить название"
				oncancel={() => (renameOpen = false)}
			/>
		</form>
	</Dialog.Content>
</Dialog.Root>
