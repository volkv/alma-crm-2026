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
	import PageHeader from '$lib/components/page-header.svelte';
	import { createProgramSchema, type CreateProgramInput } from '$lib/contracts/directory';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const cardHref = $derived(resolve('/(app)/programs/[id=uuid]', { id: data.program.id }));

	const superform = superForm<CreateProgramInput, DirectoryMessage>(
		untrack(() => data.form),
		{
			validators: zod4Client(createProgramSchema),
			taintedMessage: 'Введённые данные не сохранены. Уйти со страницы?'
		}
	);

	const { enhance, submitting, message } = superform;
</script>

<svelte:head><title>{data.program.code}: изменение — LCT CRM</title></svelte:head>

<PageHeader
	title="Изменение программы"
	description={data.program.name}
	breadcrumbs={[
		{ label: 'Программы', href: resolve('/(app)/programs') },
		{ label: data.program.code, href: cardHref }
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
		<ProgramFields {superform} />
		<FormActions
			submitting={$submitting}
			submitLabel="Сохранить программу"
			oncancel={() => goto(cardHref)}
		/>
	</form>
</div>
