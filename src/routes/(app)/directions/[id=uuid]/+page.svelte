<script lang="ts">
	import { resolve } from '$app/paths';
	import ArchiveIcon from '@lucide/svelte/icons/archive';
	import ArchiveRestoreIcon from '@lucide/svelte/icons/archive-restore';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import * as Select from '$lib/components/ui/select/index.js';
	import * as Table from '$lib/components/ui/table/index.js';
	import ActionAlert from '$lib/components/directory/action-alert.svelte';
	import Flash from '$lib/components/directory/flash.svelte';
	import { DIRECTION_STATE_LABELS, DIRECTION_STATE_TONES } from '$lib/components/directory/labels';
	import ConfirmDialog from '$lib/components/confirm-dialog.svelte';
	import EmptyState from '$lib/components/empty-state.svelte';
	import KeyValue from '$lib/components/key-value.svelte';
	import KeyValueRow from '$lib/components/key-value-row.svelte';
	import PageHeader from '$lib/components/page-header.svelte';
	import StatusBadge from '$lib/components/status-badge.svelte';
	import type { DirectionState } from '$lib/contracts/directory';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	// Переменную нельзя звать `state`: после неё `$state(...)` разбирается как
	// обращение к стору с таким именем, и компонент целиком выпадает из
	// runes-режима.
	const directionState: DirectionState = $derived(data.direction.isActive ? 'active' : 'archived');

	let archiveForm = $state<HTMLFormElement | null>(null);
	let archiveOpen = $state(false);

	let restoreForm = $state<HTMLFormElement | null>(null);
	let restoreOpen = $state(false);

	let unlinkForm = $state<HTMLFormElement | null>(null);
	let unlinking = $state<{ id: string; label: string } | null>(null);
	let unlinkOpen = $state(false);

	function askUnlink(product: { id: string; label: string }) {
		unlinking = product;
		unlinkOpen = true;
	}

	let linkProductId = $state('');
	const linkProduct = $derived(
		data.productOptions.find((product) => product.id === linkProductId) ?? null
	);
</script>

<svelte:head><title>{data.direction.code} — LCT CRM</title></svelte:head>

<Flash
	messages={{
		created: 'Направление создано',
		updated: 'Изменения сохранены',
		restored: 'Направление возвращено из архива',
		product_linked: 'Продукт отнесён к направлению',
		product_unlinked: 'Продукт отвязан от направления'
	}}
/>

<PageHeader
	title={data.direction.name}
	description={data.direction.code}
	breadcrumbs={[{ label: 'Направления', href: resolve('/(app)/directions') }]}
>
	{#snippet actions()}
		{#if data.canWrite}
			<Button
				variant="outline"
				href={resolve('/(app)/directions/[id=uuid]/edit', { id: data.direction.id })}
			>
				<PencilIcon aria-hidden="true" />
				Изменить
			</Button>
			{#if data.direction.isActive}
				<Button variant="outline" onclick={() => (archiveOpen = true)}>
					<ArchiveIcon aria-hidden="true" />
					В архив
				</Button>
			{:else}
				<Button variant="outline" onclick={() => (restoreOpen = true)}>
					<ArchiveRestoreIcon aria-hidden="true" />
					Вернуть из архива
				</Button>
			{/if}
		{/if}
	{/snippet}
</PageHeader>

<div class="flex flex-col gap-4 p-4 sm:p-6">
	<ActionAlert />

	<section class="rounded-lg border border-border bg-surface p-4 sm:p-6">
		<h2 class="mb-4 text-sm font-semibold">Направление</h2>
		<KeyValue>
			<KeyValueRow label="Код" value={data.direction.code} />
			<KeyValueRow label="Порядок в списке" value={String(data.direction.position)} />
			<KeyValueRow label="Состояние">
				<StatusBadge tone={DIRECTION_STATE_TONES[directionState]} dot>
					{DIRECTION_STATE_LABELS[directionState]}
				</StatusBadge>
			</KeyValueRow>
		</KeyValue>
	</section>

	<section class="rounded-lg border border-border bg-surface">
		<header class="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
			<h2 class="text-sm font-semibold">Продукты</h2>
			<span class="text-xs text-muted-foreground">
				Связь многие ко многим: один продукт закрывает несколько направлений.
			</span>
		</header>

		{#if data.products.length === 0}
			<EmptyState
				title="Продуктов пока нет"
				description="Отнесите к направлению продукт — по этой связи собираются разрезы отчёта."
			/>
		{:else}
			<Table.Root>
				<Table.Header>
					<Table.Row class="hover:bg-transparent">
						<Table.Head>Продукт</Table.Head>
						{#if data.canWrite}
							<Table.Head class="w-28 text-right">Действие</Table.Head>
						{/if}
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each data.products as product (product.id)}
						<Table.Row class="h-row">
							<Table.Cell>
								<a
									class="underline underline-offset-2 focus-ring"
									href={resolve('/(app)/products/[id=uuid]', { id: product.id })}>{product.label}</a
								>
							</Table.Cell>
							{#if data.canWrite}
								<Table.Cell class="text-right">
									<Button variant="outline" size="sm" onclick={() => askUnlink(product)}>
										Отвязать
									</Button>
								</Table.Cell>
							{/if}
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		{/if}

		{#if data.canWrite}
			<div class="border-t border-border px-4 py-3">
				<form
					method="POST"
					action="?/linkProduct"
					class="flex flex-wrap items-end gap-3"
					data-testid="link-product"
				>
					<!-- Список наш, а форме нужно обычное поле: значение уходит скрытым
					     `input`. `required` здесь не ставим — нативную проверку браузер
					     пишет по-английски, а отказ «Не выбран продукт» приходит с
					     сервера и на русском. -->
					<div class="flex flex-col gap-1 text-xs">
						<Label for="linkProductId" class="text-xs font-medium">Продукт</Label>
						<input type="hidden" name="productId" value={linkProduct?.id ?? ''} />
						<Select.Root type="single" bind:value={linkProductId}>
							<Select.Trigger id="linkProductId" class="min-w-64 text-sm">
								{linkProduct?.label ?? '— выберите —'}
							</Select.Trigger>
							<Select.Content>
								{#each data.productOptions as product (product.id)}
									<Select.Item value={product.id} label={product.label} />
								{/each}
							</Select.Content>
						</Select.Root>
					</div>

					<Button type="submit" size="sm" disabled={!data.direction.isActive}>Отнести</Button>

					{#if !data.direction.isActive}
						<p class="text-xs text-muted-foreground">
							Направление в архиве: продукты к нему больше не относят.
						</p>
					{/if}
				</form>
			</div>
		{/if}
	</section>

	<section class="rounded-lg border border-border bg-surface">
		<header class="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
			<h2 class="text-sm font-semibold">Программы</h2>
			<span class="text-xs text-muted-foreground">
				У программы направление одно — оно задаётся на её карточке.
			</span>
		</header>

		{#if data.programs.length === 0}
			<EmptyState
				title="Программ пока нет"
				description="К направлению не отнесена ни одна образовательная программа."
			/>
		{:else}
			<Table.Root>
				<Table.Header>
					<Table.Row class="hover:bg-transparent">
						<Table.Head>Программа</Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each data.programs as program (program.id)}
						<Table.Row class="h-row">
							<Table.Cell>
								<a
									class="underline underline-offset-2 focus-ring"
									href={resolve('/(app)/programs/[id=uuid]', { id: program.id })}>{program.label}</a
								>
							</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		{/if}
	</section>
</div>

<form method="POST" action="?/archive" bind:this={archiveForm} hidden></form>
<form method="POST" action="?/restore" bind:this={restoreForm} hidden></form>

<form method="POST" action="?/unlinkProduct" bind:this={unlinkForm} hidden>
	<input type="hidden" name="productId" value={unlinking?.id ?? ''} />
</form>

<ConfirmDialog
	bind:open={archiveOpen}
	title="Перевести направление в архив?"
	description="Направление перестанет предлагаться при назначении ответственных, но останется в отчётах, в назначениях и в истории."
	confirmLabel="В архив"
	tone="danger"
	onconfirm={() => archiveForm?.requestSubmit()}
/>

<ConfirmDialog
	bind:open={restoreOpen}
	title="Вернуть направление из архива?"
	description="Направление снова будет предлагаться при назначении ответственных."
	confirmLabel="Вернуть"
	onconfirm={() => restoreForm?.requestSubmit()}
/>

<ConfirmDialog
	bind:open={unlinkOpen}
	title="Отвязать продукт от направления?"
	description={unlinking === null
		? undefined
		: `${unlinking.label} перестанет попадать в разрезы отчёта по этому направлению. Сам продукт останется в справочнике.`}
	confirmLabel="Отвязать"
	tone="danger"
	onconfirm={() => unlinkForm?.requestSubmit()}
/>
