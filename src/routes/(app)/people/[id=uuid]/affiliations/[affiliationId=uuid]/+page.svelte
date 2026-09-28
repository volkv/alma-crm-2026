<script lang="ts">
	import { untrack } from 'svelte';
	import { superForm } from 'sveltekit-superforms';
	import { zod4Client } from 'sveltekit-superforms/adapters';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import AffiliationFields from '$lib/components/directory/affiliation-fields.svelte';
	import FormAlert from '$lib/components/directory/form-alert.svelte';
	import type { DirectoryMessage } from '$lib/components/directory/messages';
	import FormActions from '$lib/components/form/form-actions.svelte';
	import InlineHint from '$lib/components/inline-hint.svelte';
	import KeyValue from '$lib/components/key-value.svelte';
	import KeyValueRow from '$lib/components/key-value-row.svelte';
	import Breadcrumbs from '$lib/components/breadcrumbs.svelte';
	import Header from '$lib/components/header.svelte';
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

<svelte:head><title>Изменение роли — Альма CRM</title></svelte:head>

<Header title="Изменение роли" description={fullName} />

<Breadcrumbs
	items={[
		{ label: 'Контакты', href: resolve('/(app)/people') },
		{ label: fullName, href: cardHref },
		{ label: 'Изменение роли' }
	]}
/>

<div class="p-4 sm:px-9 sm:py-6">
	<form
		data-tour="person-affiliation-form"
		method="POST"
		use:enhance
		novalidate
		class="flex max-w-2xl flex-col gap-form rounded-lg border border-border bg-surface p-4 sm:p-6"
	>
		<FormAlert message={$message} />
		<KeyValue>
			<KeyValueRow label="Организация" value={data.organization.label} />
		</KeyValue>
		<AffiliationFields {superform} mode="edit" />
		<InlineHint>
			Организацию у роли не меняют: роль в другой организации заводят новой, а эту закрывают.
			Площадку назначают в карточке организации.
		</InlineHint>
		<FormActions
			submitting={$submitting}
			submitLabel="Сохранить роль"
			oncancel={() => goto(cardHref)}
		/>
	</form>
</div>
