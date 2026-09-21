<script lang="ts">
	import { untrack } from 'svelte';
	import { superForm } from 'sveltekit-superforms';
	import { zod4Client } from 'sveltekit-superforms/adapters';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import AffiliationFields from '$lib/components/directory/affiliation-fields.svelte';
	import FormAlert from '$lib/components/directory/form-alert.svelte';
	import type { DirectoryMessage } from '$lib/components/directory/messages';
	import EmptyState from '$lib/components/empty-state.svelte';
	import FormActions from '$lib/components/form/form-actions.svelte';
	import InlineHint from '$lib/components/inline-hint.svelte';
	import Breadcrumbs from '$lib/components/breadcrumbs.svelte';
	import Header from '$lib/components/header.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import { createAffiliationSchema, type CreateAffiliationInput } from '$lib/contracts/directory';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const fullName = $derived(`${data.person.lastName} ${data.person.firstName}`);
	const cardHref = $derived(resolve('/(app)/people/[id=uuid]', { id: data.person.id }));

	const superform = superForm<CreateAffiliationInput, DirectoryMessage>(
		untrack(() => data.form),
		{
			validators: zod4Client(createAffiliationSchema),
			taintedMessage: 'Введённые данные не сохранены. Уйти со страницы?'
		}
	);

	const { enhance, submitting, message } = superform;
</script>

<svelte:head><title>Новая роль — LCT CRM</title></svelte:head>

<Header title="Новая роль" description={fullName} />

<Breadcrumbs
	items={[
		{ label: 'Контакты', href: resolve('/(app)/people') },
		{ label: fullName, href: cardHref },
		{ label: 'Новая роль' }
	]}
/>

<div class="p-4 sm:p-6">
	{#if data.organizations.length === 0}
		<div class="max-w-2xl rounded-lg border border-border bg-surface">
			<EmptyState
				title="Нет ни одной действующей организации"
				description="Роль связывает человека с организацией, поэтому сначала заводят организацию."
			>
				{#snippet action()}
					<Button href={resolve('/(app)/organizations/new')}>Завести организацию</Button>
				{/snippet}
			</EmptyState>
		</div>
	{:else}
		<form
			data-tour="person-affiliation-new-form"
			method="POST"
			use:enhance
			novalidate
			class="flex max-w-2xl flex-col gap-4 rounded-lg border border-border bg-surface p-4 sm:p-6"
		>
			<FormAlert message={$message} />
			<AffiliationFields {superform} mode="for-person" organizations={data.organizations} />
			<InlineHint>
				Площадку у роли назначают в карточке организации: она обязана принадлежать именно этой
				организации.
			</InlineHint>
			<FormActions
				submitting={$submitting}
				submitLabel="Добавить роль"
				oncancel={() => goto(cardHref)}
			/>
		</form>
	{/if}
</div>
