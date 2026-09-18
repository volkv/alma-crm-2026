<script lang="ts">
	import { untrack } from 'svelte';
	import { superForm } from 'sveltekit-superforms';
	import { zod4Client } from 'sveltekit-superforms/adapters';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import DirectionFields from '$lib/components/directory/direction-fields.svelte';
	import FormAlert from '$lib/components/directory/form-alert.svelte';
	import type { DirectoryMessage } from '$lib/components/directory/messages';
	import FormActions from '$lib/components/form/form-actions.svelte';
	import PageHeader from '$lib/components/page-header.svelte';
	import { createDirectionSchema, type CreateDirectionInput } from '$lib/contracts/directory';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const superform = superForm<CreateDirectionInput, DirectoryMessage>(
		untrack(() => data.form),
		{
			validators: zod4Client(createDirectionSchema),
			taintedMessage: 'Введённые данные не сохранены. Уйти со страницы?'
		}
	);

	const { enhance, submitting, message } = superform;
</script>

<svelte:head><title>Новое направление — LCT CRM</title></svelte:head>

<PageHeader
	title="Новое направление"
	breadcrumbs={[{ label: 'Направления', href: resolve('/(app)/directions') }]}
/>

<div class="p-4 sm:p-6">
	<form
		method="POST"
		use:enhance
		novalidate
		class="flex max-w-3xl flex-col gap-4 rounded-lg border border-border bg-surface p-4 sm:p-6"
	>
		<FormAlert message={$message} />
		<DirectionFields {superform} />
		<FormActions
			submitting={$submitting}
			submitLabel="Создать направление"
			oncancel={() => goto(resolve('/(app)/directions'))}
		/>
	</form>
</div>
