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
	import type { PassportAcceptance } from '$lib/contracts/enrichment';
	import PassportPanel from '../passport/passport-panel.svelte';
	import RegistryStart from './registry-start.svelte';
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

	/** Поля, принятые из паспорта: уходят с формой, чтобы сервер записал их происхождение. */
	let accepted = $state<PassportAcceptance>([]);
</script>

<svelte:head><title>Добавить организацию — Альма CRM</title></svelte:head>

<Header title="Добавить организацию" />

<Breadcrumbs
	items={[
		{ label: 'Организации', href: resolve('/organizations') },
		{ label: 'Добавить организацию' }
	]}
/>

<div class="flex flex-col gap-4 p-4 sm:px-9 sm:py-6">
	{#if data.mode === 'registry'}
		<RegistryStart allowVendor={data.allowVendor} />
	{:else}
		{#if data.registry}
			<p class="text-sm text-muted-foreground">
				Заполните карточку вручную или
				<a
					class="underline underline-offset-2 hover:text-foreground"
					href={resolve('/organizations/new')}>вернитесь к поиску в ЕГРЮЛ</a
				>.
			</p>
		{/if}

		<PassportPanel {superform} availability={data.passport} bind:accepted />

		<form
			data-tour="organization-new-form"
			method="POST"
			action="?/save"
			use:enhance
			novalidate
			class="flex max-w-3xl flex-col gap-4 rounded-lg border border-border bg-surface p-4 sm:p-6"
		>
			<FormAlert message={$message} confirmLabel="Создать всё равно" />
			<input type="hidden" name="passport" value={JSON.stringify(accepted)} />
			<OrganizationFields {superform} allowVendor={data.allowVendor} />
			<FormActions
				submitting={$submitting}
				submitLabel="Создать организацию"
				oncancel={() => goto(resolve('/organizations'))}
			/>
		</form>
	{/if}
</div>
