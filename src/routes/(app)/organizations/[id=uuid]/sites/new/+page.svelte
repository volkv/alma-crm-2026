<script lang="ts">
	import { untrack } from 'svelte';
	import { superForm } from 'sveltekit-superforms';
	import { zod4Client } from 'sveltekit-superforms/adapters';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import FormAlert from '$lib/components/directory/form-alert.svelte';
	import type { DirectoryMessage } from '$lib/components/directory/messages';
	import SiteFields from '$lib/components/directory/site-fields.svelte';
	import FormActions from '$lib/components/form/form-actions.svelte';
	import PageHeader from '$lib/components/page-header.svelte';
	import { createSiteSchema, type CreateSiteInput } from '$lib/contracts/directory';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const cardHref = $derived(
		resolve('/(app)/organizations/[id=uuid]', { id: data.organization.id })
	);

	const superform = superForm<CreateSiteInput, DirectoryMessage>(
		untrack(() => data.form),
		{
			validators: zod4Client(createSiteSchema),
			taintedMessage: 'Введённые данные не сохранены. Уйти со страницы?'
		}
	);

	const { enhance, submitting, message } = superform;
</script>

<svelte:head><title>Новая площадка — LCT CRM</title></svelte:head>

<PageHeader
	title="Новая площадка"
	description={data.organization.shortName}
	breadcrumbs={[
		{ label: 'Организации', href: resolve('/(app)/organizations') },
		{ label: data.organization.shortName, href: cardHref }
	]}
/>

<div class="p-4 sm:p-6">
	<form
		data-tour="organization-site-new-form"
		method="POST"
		use:enhance
		novalidate
		class="flex max-w-2xl flex-col gap-4 rounded-lg border border-border bg-surface p-4 sm:p-6"
	>
		<FormAlert message={$message} />
		<SiteFields {superform} />
		<FormActions
			submitting={$submitting}
			submitLabel="Добавить площадку"
			oncancel={() => goto(cardHref)}
		/>
	</form>
</div>
