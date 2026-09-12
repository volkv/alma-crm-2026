<script lang="ts">
	import { untrack } from 'svelte';
	import { superForm } from 'sveltekit-superforms';
	import { zod4Client } from 'sveltekit-superforms/adapters';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import FormAlert from '$lib/components/directory/form-alert.svelte';
	import type { DirectoryMessage } from '$lib/components/directory/messages';
	import OrganizationFields from '$lib/components/directory/organization-fields.svelte';
	import FormActions from '$lib/components/form/form-actions.svelte';
	import PageHeader from '$lib/components/page-header.svelte';
	import { createOrganizationSchema, type CreateOrganizationInput } from '$lib/contracts/directory';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const cardHref = $derived(resolve('/(app)/organizations/[id]', { id: data.organization.id }));

	const superform = superForm<CreateOrganizationInput, DirectoryMessage>(
		untrack(() => data.form),
		{
			validators: zod4Client(createOrganizationSchema),
			taintedMessage: 'Введённые данные не сохранены. Уйти со страницы?'
		}
	);

	const { enhance, submitting, message } = superform;
</script>

<svelte:head><title>{data.organization.shortName}: изменение — LCT CRM</title></svelte:head>

<PageHeader
	title="Изменение организации"
	description={data.organization.shortName}
	breadcrumbs={[
		{ label: 'Организации', href: resolve('/(app)/organizations') },
		{ label: data.organization.shortName, href: cardHref }
	]}
/>

<div class="p-4 sm:p-6">
	<form
		method="POST"
		use:enhance
		novalidate
		class="flex max-w-3xl flex-col gap-4 rounded-lg border border-border bg-surface p-4 sm:p-6"
	>
		<FormAlert message={$message} />
		<OrganizationFields {superform} />
		<FormActions
			submitting={$submitting}
			submitLabel="Сохранить организацию"
			oncancel={() => goto(cardHref)}
		/>
	</form>
</div>
