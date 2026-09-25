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
	import Breadcrumbs from '$lib/components/breadcrumbs.svelte';
	import Header from '$lib/components/header.svelte';
	import { createOrganizationSchema, type CreateOrganizationInput } from '$lib/contracts/directory';
	import type { PassportAcceptance } from '$lib/contracts/enrichment';
	import PassportPanel from '../../passport/passport-panel.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const cardHref = $derived(
		resolve('/(app)/organizations/[id=uuid]', { id: data.organization.id })
	);

	const superform = superForm<CreateOrganizationInput, DirectoryMessage>(
		untrack(() => data.form),
		{
			validators: zod4Client(createOrganizationSchema),
			taintedMessage: 'Введённые данные не сохранены. Уйти со страницы?'
		}
	);

	const { enhance, submitting, message } = superform;

	/** Поля, принятые из паспорта: уходят с формой, чтобы сервер записал их происхождение. */
	let accepted = $state<PassportAcceptance>([]);
</script>

<svelte:head><title>{data.organization.shortName}: изменение — Альма CRM</title></svelte:head>

<Header title="Изменение организации" description={data.organization.shortName} />

<Breadcrumbs
	items={[
		{ label: 'Организации', href: resolve('/(app)/organizations') },
		{ label: data.organization.shortName, href: cardHref },
		{ label: 'Изменение организации' }
	]}
/>

<div class="flex flex-col gap-4 p-4 sm:px-9 sm:py-6">
	<PassportPanel {superform} availability={data.passport} bind:accepted />

	<form
		data-tour="organization-edit-form"
		method="POST"
		action="?/save"
		use:enhance
		novalidate
		class="flex max-w-3xl flex-col gap-4 rounded-lg border border-border bg-surface p-4 sm:p-6"
	>
		<FormAlert message={$message} />
		<input type="hidden" name="passport" value={JSON.stringify(accepted)} />
		<OrganizationFields {superform} allowVendor={data.allowVendor} />
		<FormActions
			submitting={$submitting}
			submitLabel="Сохранить организацию"
			oncancel={() => goto(cardHref)}
		/>
	</form>
</div>
