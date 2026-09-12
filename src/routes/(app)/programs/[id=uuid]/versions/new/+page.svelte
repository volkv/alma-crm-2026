<script lang="ts">
	import { untrack } from 'svelte';
	import { superForm } from 'sveltekit-superforms';
	import { zod4Client } from 'sveltekit-superforms/adapters';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import FormAlert from '$lib/components/directory/form-alert.svelte';
	import type { DirectoryMessage } from '$lib/components/directory/messages';
	import ProgramVersionFields from '$lib/components/directory/program-version-fields.svelte';
	import FormActions from '$lib/components/form/form-actions.svelte';
	import InlineHint from '$lib/components/inline-hint.svelte';
	import PageHeader from '$lib/components/page-header.svelte';
	import {
		createProgramVersionSchema,
		type CreateProgramVersionInput
	} from '$lib/contracts/directory';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const cardHref = $derived(resolve('/(app)/programs/[id=uuid]', { id: data.program.id }));

	const superform = superForm<CreateProgramVersionInput, DirectoryMessage>(
		untrack(() => data.form),
		{
			validators: zod4Client(createProgramVersionSchema),
			taintedMessage: 'Введённые данные не сохранены. Уйти со страницы?'
		}
	);

	const { enhance, submitting, message } = superform;
</script>

<svelte:head><title>Новая версия программы — LCT CRM</title></svelte:head>

<PageHeader
	title="Новая версия"
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
		class="flex max-w-2xl flex-col gap-4 rounded-lg border border-border bg-surface p-4 sm:p-6"
	>
		<FormAlert message={$message} />
		<InlineHint>
			Версия получит номер {data.nextVersion}: номера выдаёт сервис по порядку, вручную их не
			назначают.
		</InlineHint>
		<ProgramVersionFields {superform} />
		<FormActions
			submitting={$submitting}
			submitLabel="Добавить версию"
			oncancel={() => goto(cardHref)}
		/>
	</form>
</div>
