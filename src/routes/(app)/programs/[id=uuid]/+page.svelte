<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import DownloadIcon from '@lucide/svelte/icons/download';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Table from '$lib/components/ui/table/index.js';
	import ActionAlert from '$lib/components/directory/action-alert.svelte';
	import Flash from '$lib/components/directory/flash.svelte';
	import FileDropzone from '$lib/components/form/file-dropzone.svelte';
	import {
		LIFECYCLE_STATUS_LABELS,
		LIFECYCLE_STATUS_TONES,
		PROGRAM_LEVEL_LABELS
	} from '$lib/components/directory/labels';
	import EmptyState from '$lib/components/empty-state.svelte';
	import KeyValue from '$lib/components/key-value.svelte';
	import KeyValueRow from '$lib/components/key-value-row.svelte';
	import Breadcrumbs from '$lib/components/breadcrumbs.svelte';
	import Header from '$lib/components/header.svelte';
	import StatusBadge from '$lib/components/status-badge.svelte';
	import RankingPlace from '$lib/components/stats/ranking-place.svelte';
	import { PROGRAM_MATERIAL_MAX_FILES } from '$lib/contracts/directory';
	import { documentFormat } from '$lib/contracts/documents';
	import { formatBytes, formatDate, formatDateTime } from '$lib/format';
	import { openWhenRequested } from '$lib/components/create-dialog/create-dialog.svelte';
	import CreateVersionDialog from './create-version-dialog.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	// `?create` в адресе открывает окно новой версии сразу — так на него ведут
	// ссылки с других экранов; параметр затем уходит, чтобы обновление не
	// открыло окно снова.
	let versionOpen = $state(false);

	openWhenRequested(
		() => data.createVersion?.openOnLoad ?? false,
		() => (versionOpen = true)
	);

	// Номера версий выдаёт сервис по порядку; список идёт от новой к старой.
	const nextVersion = $derived((data.versions[0]?.version ?? 0) + 1);

	let uploading = $state(false);
</script>

<svelte:head><title>{data.program.code} — Альма CRM</title></svelte:head>

<Flash
	messages={{
		created: 'Программа создана',
		updated: 'Изменения сохранены',
		version_created: 'Версия добавлена'
	}}
/>

<Header title={data.program.name} description={data.program.code}>
	{#snippet actions()}
		{#if data.canWrite}
			<Button
				variant="outline"
				href={resolve('/(app)/programs/[id=uuid]/edit', { id: data.program.id })}
			>
				<PencilIcon aria-hidden="true" />
				Изменить
			</Button>
			<Button onclick={() => (versionOpen = true)}>
				<PlusIcon aria-hidden="true" />
				Добавить версию
			</Button>
		{/if}
	{/snippet}
</Header>

{#if data.createVersion !== null}
	<CreateVersionDialog
		bind:open={versionOpen}
		create={data.createVersion}
		programName={data.program.name}
		{nextVersion}
	/>
{/if}

<Breadcrumbs
	items={[{ label: 'Программы', href: resolve('/(app)/programs') }, { label: data.program.name }]}
/>

<div class="flex flex-col gap-4 p-4 sm:px-9 sm:py-6">
	<section
		class="rounded-lg border border-border bg-surface p-4 sm:p-6"
		data-tour="program-summary"
	>
		<h2 class="mb-4 section-title">Программа</h2>
		<KeyValue>
			<KeyValueRow label="Код" value={data.program.code} />
			<KeyValueRow label="Уровень" value={PROGRAM_LEVEL_LABELS[data.program.level]} />
			<KeyValueRow label="Направление подготовки" value={data.program.directionCode} />
			<KeyValueRow label="Приоритет">
				{#if data.program.priority === null}
					<span class="text-faint">Не назначен</span>
				{:else}
					<StatusBadge tone="accent">{data.program.priority}</StatusBadge>
				{/if}
			</KeyValueRow>
			<KeyValueRow label="Состояние">
				<StatusBadge tone={LIFECYCLE_STATUS_TONES[data.program.status]} dot>
					{LIFECYCLE_STATUS_LABELS[data.program.status]}
				</StatusBadge>
			</KeyValueRow>
		</KeyValue>

		<div class="mt-4 border-t border-border pt-4">
			<h3 class="text-xs text-muted-foreground">Описание</h3>
			{#if data.program.description}
				<p class="mt-0.5 text-sm break-words whitespace-pre-line">{data.program.description}</p>
			{:else}
				<p class="mt-0.5 text-sm text-faint">Не заполнено</p>
			{/if}
		</div>
	</section>

	<section class="rounded-lg border border-border bg-surface">
		<header class="border-b border-border px-4 py-3">
			<h2 class="section-title">Материалы</h2>
			<p class="mt-1 text-xs text-muted-foreground">
				Полные описания программы для вуза. Из карточки взаимодействия их отправляют контактным
				лицам в один клик — кнопкой «Отправить информацию о программах» в панели «Программы и
				продукты» на стадии «Коммуникация и сверка программ»: файлы уходят вложением вместе с
				описанием программы.
			</p>
		</header>

		{#if data.materials.length === 0}
			<EmptyState
				title="Материалов пока нет"
				description="Файлы с полным описанием программы: программа курса, учебный план, презентация."
			/>
		{:else}
			<ul class="divide-y divide-border">
				{#each data.materials as material (material.documentId)}
					<li class="flex flex-wrap items-center gap-3 px-4 py-3">
						<div class="min-w-0 flex-1">
							<p class="truncate text-sm font-medium" title={material.fileName}>
								{material.title}
							</p>
							<p class="text-xs text-muted-foreground">
								{documentFormat(material.mime)?.toUpperCase() ?? material.mime} · {formatBytes(
									material.sizeBytes
								)} · {formatDateTime(material.createdAt)}
							</p>
						</div>
						<Button
							variant="outline"
							size="sm"
							href={resolve('/(app)/programs/[id=uuid]/materials/[documentId=uuid]', {
								id: data.program.id,
								documentId: material.documentId
							})}
							data-sveltekit-reload
						>
							<DownloadIcon aria-hidden="true" />
							Скачать
						</Button>
						{#if data.canWrite}
							<form method="POST" action="?/removeMaterial" use:enhance>
								<input type="hidden" name="documentId" value={material.documentId} />
								<Button type="submit" variant="ghost" size="sm">Убрать из программы</Button>
							</form>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}

		<!-- Отказ загрузки или снятия материала: чужой тип, лишний файл, пропавшая
			связь. У действий материалов нет своей формы с сообщением, поэтому
			фраза приходит в `page.form`, как у прочих действий без формы. -->
		{#if page.form?.message}
			<div class="border-t border-border p-4">
				<ActionAlert />
			</div>
		{/if}

		{#if data.canWrite}
			<form
				method="POST"
				action="?/uploadMaterials"
				enctype="multipart/form-data"
				use:enhance={() => {
					uploading = true;

					// Удачная загрузка сбрасывает форму, а с ней и список выбранных файлов.
					return async ({ update }) => {
						await update();
						uploading = false;
					};
				}}
				class="flex flex-col gap-form border-t border-border p-4 sm:p-6"
			>
				<FileDropzone
					id="programMaterials"
					name="files"
					label="Добавить материалы"
					description="PDF или DOCX: до {PROGRAM_MATERIAL_MAX_FILES} файлов за раз, вместе до 25 МиБ."
					accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
					multiple
					required
				/>
				<Button type="submit" size="sm" class="self-end" disabled={uploading}>Загрузить</Button>
			</form>
		{/if}
	</section>

	{#if data.ranking}
		<RankingPlace place={data.ranking.place} period={data.ranking.period} />
	{/if}

	<section class="rounded-lg border border-border bg-surface" data-tour="program-versions">
		<header class="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
			<h2 class="section-title">Версии</h2>
		</header>

		{#if data.versions.length === 0}
			<EmptyState
				title="Версий пока нет"
				description="Версия фиксирует, что именно предлагалось вузу и с какого дня."
			/>
		{:else}
			<Table.Root>
				<Table.Header>
					<Table.Row class="hover:bg-transparent">
						<Table.Head class="w-24">Версия</Table.Head>
						<Table.Head class="w-36">Действует с</Table.Head>
						<Table.Head>Что изменилось</Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each data.versions as version (version.id)}
						<Table.Row class="h-row">
							<Table.Cell class="font-medium">в. {version.version}</Table.Cell>
							<Table.Cell>{formatDate(version.effectiveFrom)}</Table.Cell>
							<Table.Cell class="whitespace-pre-line">{version.summary}</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		{/if}
	</section>
</div>
