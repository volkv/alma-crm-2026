<script lang="ts">
	import { untrack } from 'svelte';
	import { superForm } from 'sveltekit-superforms';
	import { zod4Client } from 'sveltekit-superforms/adapters';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import FormAlert from '$lib/components/directory/form-alert.svelte';
	import type { DirectoryMessage } from '$lib/components/directory/messages';
	import PersonFields from '$lib/components/directory/person-fields.svelte';
	import FormActions from '$lib/components/form/form-actions.svelte';
	import PageHeader from '$lib/components/page-header.svelte';
	import { createPersonSchema, type CreatePersonInput } from '$lib/contracts/directory';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const fullName = $derived(`${data.person.lastName} ${data.person.firstName}`);
	const cardHref = $derived(resolve('/(app)/people/[id=uuid]', { id: data.person.id }));

	const superform = superForm<CreatePersonInput, DirectoryMessage>(
		untrack(() => data.form),
		{
			validators: zod4Client(createPersonSchema),
			taintedMessage: 'Введённые данные не сохранены. Уйти со страницы?'
		}
	);

	const { enhance, submitting, message } = superform;
</script>

<svelte:head><title>{fullName}: изменение — LCT CRM</title></svelte:head>

<PageHeader
	title="Изменение человека"
	description={fullName}
	breadcrumbs={[
		{ label: 'Контакты', href: resolve('/(app)/people') },
		{ label: fullName, href: cardHref }
	]}
/>

<div class="p-4 sm:p-6">
	<form
		data-tour="person-edit-form"
		method="POST"
		use:enhance
		novalidate
		class="flex max-w-3xl flex-col gap-4 rounded-lg border border-border bg-surface p-4 sm:p-6"
	>
		<FormAlert message={$message} />
		<PersonFields {superform} />
		<FormActions
			submitting={$submitting}
			submitLabel="Сохранить человека"
			oncancel={() => goto(cardHref)}
		/>
	</form>
</div>
