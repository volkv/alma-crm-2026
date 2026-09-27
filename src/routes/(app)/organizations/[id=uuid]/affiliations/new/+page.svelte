<script lang="ts">
	import { untrack } from 'svelte';
	import { superForm } from 'sveltekit-superforms';
	import { zod4Client } from 'sveltekit-superforms/adapters';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import type { ResolvedPathname } from '$app/types';
	import AffiliationFields from '$lib/components/directory/affiliation-fields.svelte';
	import FormAlert from '$lib/components/directory/form-alert.svelte';
	import type { DirectoryMessage } from '$lib/components/directory/messages';
	import EmptyState from '$lib/components/empty-state.svelte';
	import FormActions from '$lib/components/form/form-actions.svelte';
	import Breadcrumbs from '$lib/components/breadcrumbs.svelte';
	import Header from '$lib/components/header.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import { createAffiliationSchema, type CreateAffiliationInput } from '$lib/contracts/directory';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const cardHref = $derived(
		resolve('/(app)/organizations/[id=uuid]', { id: data.organization.id })
	);

	const superform = superForm<CreateAffiliationInput, DirectoryMessage>(
		untrack(() => data.form),
		{
			validators: zod4Client(createAffiliationSchema),
			taintedMessage: 'Введённые данные не сохранены. Уйти со страницы?'
		}
	);

	const { enhance, submitting, message } = superform;

	/**
	 * Новый человек из этой формы: после заведения он вернётся сюда уже
	 * выбранным. Путь собран `resolve`; добавлена только строка запроса, а её
	 * типа в `ResolvedPathname` нет (тот же приём — карточка организации).
	 */
	const newPersonHref = $derived(
		`${resolve('/(app)/people/new')}?for=${data.organization.id}` as ResolvedPathname
	);
</script>

<svelte:head><title>Новый контакт — Альма CRM</title></svelte:head>

<Header title="Новый контакт" description={data.organization.shortName} />

<Breadcrumbs
	items={[
		{ label: 'Организации', href: resolve('/(app)/organizations') },
		{ label: data.organization.shortName, href: cardHref },
		{ label: 'Новый контакт' }
	]}
/>

<div class="p-4 sm:px-9 sm:py-6">
	{#if data.people.length === 0}
		<div class="max-w-2xl rounded-lg border border-border bg-surface">
			<EmptyState
				title="В справочнике пока нет людей"
				description="Контакт — это роль человека в организации, поэтому сначала заводят человека."
			>
				{#snippet action()}
					<Button href={newPersonHref}>Завести человека</Button>
				{/snippet}
			</EmptyState>
		</div>
	{:else}
		<form
			data-tour="organization-affiliation-new-form"
			method="POST"
			use:enhance
			novalidate
			class="flex max-w-2xl flex-col gap-4 rounded-lg border border-border bg-surface p-4 sm:p-6"
		>
			<FormAlert message={$message} />
			<AffiliationFields
				{superform}
				mode="in-organization"
				people={data.people}
				sites={data.siteOptions}
			/>
			<p class="-mt-2 text-xs text-muted-foreground">
				Нужного человека нет в списке?
				<a class="text-link hover:text-link-hover" href={newPersonHref}>Завести нового</a> — после сохранения
				он вернётся в эту форму выбранным.
			</p>
			<FormActions
				submitting={$submitting}
				submitLabel="Добавить контакт"
				oncancel={() => goto(cardHref)}
			/>
		</form>
	{/if}
</div>
