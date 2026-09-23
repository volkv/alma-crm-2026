<script lang="ts">
	import { untrack } from 'svelte';
	import { superForm } from 'sveltekit-superforms';
	import { zod4Client } from 'sveltekit-superforms/adapters';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { resolve } from '$app/paths';
	import * as Alert from '$lib/components/ui/alert/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import Breadcrumbs from '$lib/components/breadcrumbs.svelte';
	import FormAlert from '$lib/components/directory/form-alert.svelte';
	import type { DirectoryMessage } from '$lib/components/directory/messages';
	import {
		EDUCATION_LEVEL_LABELS,
		ORGANIZATION_KIND_LABELS
	} from '$lib/components/directory/labels';
	import FieldInput from '$lib/components/form/field-input.svelte';
	import Header from '$lib/components/header.svelte';
	import KeyValue from '$lib/components/key-value.svelte';
	import KeyValueRow from '$lib/components/key-value-row.svelte';
	import StatusBadge from '$lib/components/status-badge.svelte';
	import {
		organizationLookupSchema,
		type FieldSource,
		type LegalStatus,
		type OrganizationLookupInput
	} from '$lib/contracts/enrichment';
	import type { PageProps } from './$types';

	let { data, form: actionData }: PageProps = $props();

	const superform = superForm<OrganizationLookupInput, DirectoryMessage>(
		untrack(() => data.form),
		{ validators: zod4Client(organizationLookupSchema) }
	);

	const { form, errors, enhance, submitting, message } = superform;

	const result = $derived(actionData && 'result' in actionData ? actionData.result : null);

	/** Откуда взялось поле: подпись видна рядом со значением, а не в легенде. */
	const SOURCE_LABELS: Record<FieldSource, string> = {
		dadata: 'ЕГРЮЛ',
		sveden: 'сайт, /sveden',
		guess: 'догадка',
		input: 'введено вручную'
	};

	const STATUS_LABELS: Record<LegalStatus, string> = {
		active: 'Действует',
		liquidating: 'Ликвидируется',
		liquidated: 'Ликвидирована',
		reorganizing: 'Реорганизуется',
		bankrupt: 'Банкротство',
		unknown: 'Состояние неизвестно'
	};
</script>

<svelte:head><title>Поиск реквизитов вуза — LCT CRM</title></svelte:head>

<Header title="Поиск реквизитов вуза" />

<Breadcrumbs
	items={[{ label: 'Организации', href: resolve('/organizations') }, { label: 'Поиск реквизитов' }]}
/>

<div class="flex flex-col gap-4 p-4 sm:px-9 sm:py-6">
	<p class="max-w-3xl text-sm text-muted-foreground">
		Название или ИНН — в ответ реквизиты из ЕГРЮЛ и то, что удалось прочитать в разделе «Сведения об
		образовательной организации» на сайте вуза. Это черновик: ничего никуда не сохраняется, и рядом
		с каждым полем написано, откуда оно взято.
	</p>

	{#if !data.configured}
		<Alert.Root variant="destructive" class="max-w-3xl">
			<TriangleAlertIcon aria-hidden="true" />
			<Alert.Title>Поиск не настроен</Alert.Title>
			<Alert.Description>
				Администратору стенда нужно задать переменную окружения <code>DADATA_API_KEY</code> — ключ подсказок
				dadata.ru — и перезапустить приложение.
			</Alert.Description>
		</Alert.Root>
	{/if}

	<form
		data-tour="organization-lookup-form"
		method="POST"
		use:enhance
		novalidate
		class="flex max-w-3xl flex-col gap-4 rounded-lg border border-border bg-surface p-4 sm:p-6"
	>
		<FormAlert message={$message} />
		<FieldInput
			name="query"
			label="Название вуза или ИНН"
			description="ИНН узнаётся по самой строке: десять или двенадцать цифр с верной контрольной суммой — это ИНН, всё остальное — название."
			placeholder="Санкт-Петербургский политехнический университет"
			required
			bind:value={$form.query}
			errors={$errors.query}
		/>
		<FieldInput
			name="website"
			label="Сайт (если знаете)"
			description="В ЕГРЮЛ сайта нет: без подсказки он ищется по домену почты из выписки, и это догадка."
			placeholder="spbstu.ru"
			bind:value={$form.website}
			errors={$errors.website}
		/>
		<div>
			<Button type="submit" disabled={$submitting || !data.configured}>
				{$submitting ? 'Ищем…' : 'Найти'}
			</Button>
		</div>
	</form>

	{#if result}
		{#if result.warnings.length > 0}
			<Alert.Root class="max-w-3xl">
				<TriangleAlertIcon aria-hidden="true" />
				<Alert.Title>Проверьте глазами</Alert.Title>
				<Alert.Description>
					<ul class="list-disc pl-4">
						{#each result.warnings as warning (warning)}
							<li>{warning}</li>
						{/each}
					</ul>
				</Alert.Description>
			</Alert.Root>
		{/if}

		<section
			data-tour="organization-lookup-draft"
			class="max-w-3xl rounded-lg border border-border bg-surface p-4 sm:p-6"
		>
			<h2 class="mb-3 text-base font-medium">Черновик карточки организации</h2>
			<KeyValue>
				<KeyValueRow label="Вид">
					{ORGANIZATION_KIND_LABELS[result.draft.kind]}
					<span class="text-faint">— {SOURCE_LABELS[result.sources.kind]}</span>
				</KeyValueRow>
				<KeyValueRow label="Уровень образования">
					{#if result.draft.educationLevel === null}
						<span class="text-faint">—</span>
					{:else}
						{EDUCATION_LEVEL_LABELS[result.draft.educationLevel]}
						<span class="text-faint">— {SOURCE_LABELS[result.sources.educationLevel]}</span>
					{/if}
				</KeyValueRow>
				<KeyValueRow label="Полное наименование">
					{result.draft.legalName}
					<span class="text-faint">— {SOURCE_LABELS[result.sources.legalName]}</span>
				</KeyValueRow>
				<KeyValueRow label="Краткое наименование">
					{result.draft.shortName}
					<span class="text-faint">— {SOURCE_LABELS[result.sources.shortName]}</span>
				</KeyValueRow>
				<KeyValueRow label="ИНН" value={result.draft.inn} />
				<KeyValueRow label="КПП" value={result.draft.kpp} />
				<KeyValueRow label="ОГРН" value={result.draft.ogrn} />
				<KeyValueRow label="Регион" value={result.draft.region} />
				<KeyValueRow label="Сайт">
					{#if result.draft.website === null}
						<span class="text-faint">—</span>
					{:else}
						<a
							class="underline underline-offset-2 focus-ring"
							href={result.draft.website}
							target="_blank"
							rel="noreferrer noopener external">{result.draft.website}</a
						>
						<span class="text-faint">— {SOURCE_LABELS[result.sources.website]}</span>
					{/if}
				</KeyValueRow>
			</KeyValue>
		</section>

		<section class="max-w-3xl rounded-lg border border-border bg-surface p-4 sm:p-6">
			<h2 class="mb-3 text-base font-medium">Что отдал ЕГРЮЛ</h2>
			<KeyValue>
				<KeyValueRow label="Состояние">
					<StatusBadge tone={result.entity.status === 'active' ? 'success' : 'warning'} dot>
						{STATUS_LABELS[result.entity.status]}
					</StatusBadge>
				</KeyValueRow>
				<KeyValueRow
					label="Головная организация"
					value={result.entity.isBranch ? 'Нет, это филиал' : 'Да'}
				/>
				<KeyValueRow label="Адрес" value={result.entity.address} />
				<KeyValueRow label="ОКВЭД" value={result.entity.okved} />
				<KeyValueRow label="Руководитель">
					{#if result.entity.management === null}
						<span class="text-faint">—</span>
					{:else}
						{result.entity.management.name}
						{#if result.entity.management.post}
							<span class="text-faint">— {result.entity.management.post}</span>
						{/if}
					{/if}
				</KeyValueRow>
				<KeyValueRow label="Почта" value={result.entity.emails.join(', ')} />
			</KeyValue>
		</section>

		<section class="max-w-3xl rounded-lg border border-border bg-surface p-4 sm:p-6">
			<h2 class="mb-3 text-base font-medium">Раздел «Сведения об образовательной организации»</h2>
			{#if result.sveden === null}
				<p class="text-sm text-muted-foreground">
					Искать было негде: адрес сайта не известен ни из выписки, ни из формы.
				</p>
			{:else}
				<KeyValue>
					<KeyValueRow label="Адрес раздела">
						<a
							class="underline underline-offset-2 focus-ring"
							href={result.sveden.url}
							target="_blank"
							rel="noreferrer noopener external">{result.sveden.url}</a
						>
					</KeyValueRow>
					<KeyValueRow label="Микроразметка">
						{#if result.sveden.found}
							<StatusBadge tone="success" dot>
								Найдена, свойств: {result.sveden.propertyCount}
							</StatusBadge>
						{:else}
							<StatusBadge tone="warning" dot>{result.sveden.problem}</StatusBadge>
						{/if}
					</KeyValueRow>
					<KeyValueRow label="Полное наименование" value={result.sveden.fields.fullName} />
					<KeyValueRow label="Краткое наименование" value={result.sveden.fields.shortName} />
					<KeyValueRow label="Дата создания" value={result.sveden.fields.regDate} />
					<KeyValueRow label="Адрес" value={result.sveden.fields.address} />
					<KeyValueRow label="Телефон" value={result.sveden.fields.telephone} />
					<KeyValueRow label="Почта" value={result.sveden.fields.email} />
					<KeyValueRow label="Учредитель" value={result.sveden.fields.founder} />
					<KeyValueRow label="Руководитель" value={result.sveden.fields.headName} />
					<KeyValueRow label="Должность руководителя" value={result.sveden.fields.headPost} />
				</KeyValue>
			{/if}
		</section>

		{#if result.others.length > 0}
			<section class="max-w-3xl rounded-lg border border-border bg-surface p-4 sm:p-6">
				<h2 class="mb-3 text-base font-medium">Кто ещё попал под запрос</h2>
				<ul class="flex flex-col gap-2 text-sm">
					<!-- Ключ — ОГРН вместе с КПП: у филиалов и представительств ОГРН и ИНН
					     общие с головной организацией, различает их только КПП. -->
					{#each result.others as other, index (`${other.ogrn}/${other.kpp}/${index}`)}
						<li class="border-t border-border pt-2 first:border-0 first:pt-0">
							<div>{other.legalName}</div>
							<div class="text-xs text-muted-foreground">
								ИНН {other.inn ?? '—'} · {other.region ?? 'регион не указан'} · {STATUS_LABELS[
									other.status
								]}
							</div>
						</li>
					{/each}
				</ul>
			</section>
		{/if}
	{/if}
</div>
