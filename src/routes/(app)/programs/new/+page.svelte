<script lang="ts">
	import { untrack } from 'svelte';
	import { superForm } from 'sveltekit-superforms';
	import { zod4Client } from 'sveltekit-superforms/adapters';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import FormAlert from '$lib/components/directory/form-alert.svelte';
	import type { DirectoryMessage } from '$lib/components/directory/messages';
	import ProgramFields from '$lib/components/directory/program-fields.svelte';
	import FormActions from '$lib/components/form/form-actions.svelte';
	import Breadcrumbs from '$lib/components/breadcrumbs.svelte';
	import Header from '$lib/components/header.svelte';
	import { createProgramSchema, type CreateProgramInput } from '$lib/contracts/directory';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const superform = superForm<CreateProgramInput, DirectoryMessage>(
		untrack(() => data.form),
		{
			validators: zod4Client(createProgramSchema),
			taintedMessage: 'Введённые данные не сохранены. Уйти со страницы?'
		}
	);

	const { enhance, submitting, message } = superform;
</script>

<svelte:head><title>Новая программа — LCT CRM</title></svelte:head>

<Header title="Новая программа" />

<Breadcrumbs
	items={[{ label: 'Программы', href: resolve('/(app)/programs') }, { label: 'Новая программа' }]}
/>

<div class="p-4 sm:px-9 sm:py-6">
	<form
		data-tour="program-new-form"
		method="POST"
		use:enhance
		novalidate
		class="flex max-w-3xl flex-col gap-4 rounded-lg border border-border bg-surface p-4 sm:p-6"
	>
		<FormAlert message={$message} />
		<ProgramFields {superform} />
		<FormActions
			submitting={$submitting}
			submitLabel="Создать программу"
			oncancel={() => goto(resolve('/(app)/programs'))}
		/>
	</form>
</div>
