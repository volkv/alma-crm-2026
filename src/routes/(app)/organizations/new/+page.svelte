<script lang="ts">
	import { untrack } from 'svelte';
	import { superForm } from 'sveltekit-superforms';
	import { zod4Client } from 'sveltekit-superforms/adapters';
	import { resolve } from '$app/paths';
	import { goto } from '$app/navigation';
	import FormAlert from '$lib/components/directory/form-alert.svelte';
	import type { DirectoryMessage } from '$lib/components/directory/messages';
	import OrganizationFields from '$lib/components/directory/organization-fields.svelte';
	import FormActions from '$lib/components/form/form-actions.svelte';
	import Breadcrumbs from '$lib/components/breadcrumbs.svelte';
	import Header from '$lib/components/header.svelte';
	import { createOrganizationSchema, type CreateOrganizationInput } from '$lib/contracts/directory';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const superform = superForm<CreateOrganizationInput, DirectoryMessage>(
		// superforms берёт начальную форму один раз и дальше следит за обновлениями
		// страницы сам, поэтому чтение намеренно не становится зависимостью.
		untrack(() => data.form),
		{
			validators: zod4Client(createOrganizationSchema),
			taintedMessage: 'Введённые данные не сохранены. Уйти со страницы?'
		}
	);

	const { enhance, submitting, message } = superform;
</script>

<svelte:head><title>Новая организация — LCT CRM</title></svelte:head>

<Header title="Новая организация" />

<Breadcrumbs
	items={[
		{ label: 'Организации', href: resolve('/organizations') },
		{ label: 'Новая организация' }
	]}
/>

<div class="p-4 sm:p-6">
	<form
		data-tour="organization-new-form"
		method="POST"
		use:enhance
		novalidate
		class="flex max-w-3xl flex-col gap-4 rounded-lg border border-border bg-surface p-4 sm:p-6"
	>
		<FormAlert message={$message} />
		<OrganizationFields {superform} />
		<FormActions
			submitting={$submitting}
			submitLabel="Создать организацию"
			oncancel={() => goto(resolve('/organizations'))}
		/>
	</form>
</div>
