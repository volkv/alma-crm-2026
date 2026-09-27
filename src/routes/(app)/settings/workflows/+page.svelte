<script lang="ts">
	import { untrack } from 'svelte';
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { superForm } from 'sveltekit-superforms';
	import { zod4Client } from 'sveltekit-superforms/adapters';
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
	import { createWorkflowSchema } from '$lib/contracts/interactions';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let createOpen = $state(false);

	// Успех заведения — переход в редактор нового процесса, а сообщение о нём
	// показывает уже он; здесь остаются только ошибки формы.
	const {
		form: createData,
		errors: createErrors,
		enhance: createEnhance,
		submitting: createSubmitting
	} = superForm(
		untrack(() => data.createForm),
		{ validators: zod4Client(createWorkflowSchema) }
	);

	/** Ключ правили руками — название его больше не переписывает. */
	let keyEdited = $state(false);

	const takenKeys = $derived(new Set(data.workflows.map((workflow) => workflow.key)));

	function rename(next: string) {
		$createData.name = next;

		if (!keyEdited) {
			$createData.key = keyFromName(next, ADDRESS_KEY_STYLE, takenKeys);
		}
	}

	/**
	 * Образцы копии — процессы, в которых есть что копировать. Пустое значение
	 * — «пустой процесс»: стадии описывают в редакторе с нуля.
	 */
	const copyOptions = $derived([
		{ value: '', label: 'Пустой — стадии опишу в редакторе' },
		...data.workflows
			.filter((workflow) => workflow.stageCount > 0)
			.map((workflow) => ({
				value: workflow.key,
				label: `Копия «${workflow.name}» — стадий: ${formatNumber(workflow.stageCount)}`
			}))
	]);

	/**
	 * Обычная таблица, а не `DataTable`: процессов единицы, их не ищут и не
	 * листают — их читают целиком, поэтому ни страницы, ни фильтра здесь нет.
	 *
	 * Строка ведёт в редактор целиком, а не только названием: раздел открывают
	 * ради того, чтобы войти в процесс, и вход обязан быть виден — отсюда и
	 * колонка «Открыть» справа. Описание переносится по словам: в одну строку
	 * оно уносило вправо всё остальное, и на ноутбуке число стадий, число
	 * пространств и число незавершённых оказывались за краем.
	 */
	function open(key: string) {
		return goto(resolve('/(app)/settings/workflows/[key]', { key }));
	}
</script>

<svelte:head><title>Процессы — Альма CRM</title></svelte:head>

<!-- `data-tour` — метка подсказок по этому экрану (`$lib/onboarding/screens`). -->
<Card.Root data-tour="workflows">
	<Card.Header>
		<Card.Title>Процессы</Card.Title>
		<Card.Description>
			Процесс описан данными: стадии с нормативами и чек-листами и переходы между ними. Новый
			процесс заводится пустым — стадии описывают черновиком в редакторе — или копией действующего
			процесса, которую потом правят черновиком.
		</Card.Description>
		<Card.Action>
			<Button size="sm" onclick={() => (createOpen = true)}>
				<PlusIcon aria-hidden="true" />
				Завести процесс
			</Button>
		</Card.Action>
	</Card.Header>
	<Card.Content class="flex flex-col gap-4">
		<InlineHint>
			Один процесс можно назначить нескольким пространствам: два направления по одному сценарию —
			это одно описание работы, а не две копии. Само назначение делается в разделе «Пространства»;
			здесь видно только, скольким пространствам процесс назначен, и применение черновика меняет
			работу во всех них сразу.
		</InlineHint>

		{#if data.workflows.length === 0}
			<EmptyState
				title="Процессов нет"
				description="Заведите первый процесс: стадии и переходы вы опишете черновиком в редакторе."
			/>
		{:else}
			<div class="overflow-x-auto">
				<Table.Root>
					<Table.Header>
						<Table.Row class="hover:bg-transparent">
							<Table.Head>Процесс</Table.Head>
							<Table.Head class="w-40">Ключ</Table.Head>
							<!-- Описанию задана ширина: без неё браузер отдавал место колонке
								названия, и три слова переносились на шесть строк. -->
							<Table.Head class="w-80">Что за работа</Table.Head>
							<Table.Head class="w-20 text-right">Стадий</Table.Head>
							<Table.Head class="w-32 text-right">Пространств</Table.Head>
							<Table.Head class="w-32 text-right">Незавершённых</Table.Head>
							<Table.Head class="w-44">Черновик</Table.Head>
							<Table.Head class="w-28"><span class="sr-only">Действия</span></Table.Head>
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{#each data.workflows as workflow (workflow.id)}
							<Table.Row class="h-row cursor-pointer" onclick={() => void open(workflow.key)}>
								<Table.Cell
									class="font-medium whitespace-normal"
									onclick={(event) => event.stopPropagation()}
								>
									<a
										class="rounded-sm text-link underline-offset-4 focus-ring hover:text-link-hover hover:underline"
										href={resolve('/(app)/settings/workflows/[key]', { key: workflow.key })}
									>
										{workflow.name}
									</a>
									{#if workflow.stageCount === 0}
										<span class="mt-1 block">
											<StatusBadge tone="danger">Стадии не описаны</StatusBadge>
										</span>
									{/if}
								</Table.Cell>
								<Table.Cell>
									<!-- Ключ моноширинным: его сверяют с адресом в строке браузера. -->
									<code class="text-xs">{workflow.key}</code>
								</Table.Cell>
								<Table.Cell class="whitespace-normal text-muted-foreground">
									{workflow.description ?? '—'}
								</Table.Cell>
								<Table.Cell class="text-right">{formatNumber(workflow.stageCount)}</Table.Cell>
								<Table.Cell class="text-right">
									<!-- Ноль здесь не ошибка: процесс описывают раньше, чем решают,
										где по нему работать. -->
									{formatNumber(workflow.workspaces)}
								</Table.Cell>
								<Table.Cell class="text-right">
									{formatNumber(workflow.activeInteractions)}
								</Table.Cell>
								<Table.Cell class="whitespace-normal">
									{#if workflow.hasDraft}
										<StatusBadge tone="warning">Готовится изменение</StatusBadge>
									{:else}
										<span class="text-muted-foreground">—</span>
									{/if}
								</Table.Cell>
								<Table.Cell class="text-right" onclick={(event) => event.stopPropagation()}>
									<!-- Ссылка, а не кнопка: открывает адрес, и открывать его
										должны уметь и средняя кнопка мыши, и клавиатура. -->
									<!-- `data-tour` — метка подсказок по этому экрану
										(`$lib/onboarding/screens`): рамка встаёт вокруг входа в
										редактор первого процесса. -->
									<Button
										data-tour="process-open"
										variant="outline"
										size="sm"
										href={resolve('/(app)/settings/workflows/[key]', { key: workflow.key })}
										aria-label="Открыть процесс: {workflow.name}"
									>
										Открыть
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
			<Dialog.Title>Новый процесс</Dialog.Title>
			<Dialog.Description>
				Описание работы: стадии, нормативы, чек-листы и переходы. Пустой процесс описывают в
				редакторе, копия сразу получает стадии, переходы и состав карточки образца — их правят
				черновиком. Где работать по процессу, решается в разделе «Пространства». После заведения
				откроется редактор.
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
		<form method="POST" action="?/create" use:createEnhance novalidate class="flex flex-col gap-4">
			<FieldInput
				name="name"
				label="Название"
				required
				placeholder="Корпоративные продажи"
				bind:value={() => $createData.name, rename}
				errors={$createErrors.name}
			/>
			<FieldInput
				name="key"
				label="Ключ"
				required
				description="Собирается из названия; поправьте, если хотите. Строчные латинские буквы, цифры и дефис — ключ встанет в адрес редактора навсегда."
				placeholder="korporativnye-prodazhi"
				bind:value={
					() => $createData.key,
					(next) => {
						keyEdited = true;
						$createData.key = next;
					}
				}
				errors={$createErrors.key}
			/>
			<FieldSelect
				name="copyFromKey"
				label="С чего начать"
				options={copyOptions}
				bind:value={
					() => $createData.copyFromKey ?? '',
					(next) => ($createData.copyFromKey = next === '' ? null : next)
				}
				errors={$createErrors.copyFromKey}
			/>
			<FieldTextarea
				name="description"
				label="Что за работа"
				description="Одна строка о том, чем этот сценарий отличается от соседних. Можно оставить пустым."
				rows={2}
				bind:value={
					() => $createData.description ?? '',
					(next) => ($createData.description = next === '' ? null : next)
				}
				errors={$createErrors.description}
			/>
			<FormActions
				submitting={$createSubmitting}
				submitLabel="Завести процесс"
				oncancel={() => (createOpen = false)}
			/>
		</form>
	</Dialog.Content>
</Dialog.Root>
