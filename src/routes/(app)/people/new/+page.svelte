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
	import Breadcrumbs from '$lib/components/breadcrumbs.svelte';
	import Header from '$lib/components/header.svelte';
	import FieldSelect from '$lib/components/form/field-select.svelte';
	import { CONSENT_BASIS_LABELS } from '$lib/components/directory/labels';
	import {
		CONSENT_BASES,
		newPersonSchema,
		type ConsentBasis,
		type NewPersonInput
	} from '$lib/contracts/directory';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const superform = superForm<NewPersonInput, DirectoryMessage>(
		untrack(() => data.form),
		{
			validators: zod4Client(newPersonSchema),
			taintedMessage: 'Введённые данные не сохранены. Уйти со страницы?'
		}
	);

	const { form, errors, enhance, submitting, message } = superform;

	const BASIS_OPTIONS = CONSENT_BASES.map((basis) => ({
		value: basis,
		label: CONSENT_BASIS_LABELS[basis]
	}));
</script>

<svelte:head><title>Добавить контакт — Альма CRM</title></svelte:head>

<Header title="Добавить контакт" />

<Breadcrumbs
	items={[{ label: 'Контакты', href: resolve('/(app)/people') }, { label: 'Добавить контакт' }]}
/>

<div class="p-4 sm:px-9 sm:py-6">
	<form
		data-tour="person-new-form"
		method="POST"
		use:enhance
		novalidate
		class="flex max-w-3xl flex-col gap-4 rounded-lg border border-border bg-surface p-4 sm:p-6"
	>
		<FormAlert message={$message} />
		<PersonFields {superform} />
		<FieldSelect
			name="basis"
			label="Основание обработки персональных данных"
			description="Контакт вуза или компании — обычно исполнение договора с организацией; согласие — если человек дал его сам. Запись ляжет в историю согласий датой заведения."
			required
			options={BASIS_OPTIONS}
			placeholder="Выберите основание"
			errors={$errors.basis}
			bind:value={() => $form.basis ?? '', (next) => ($form.basis = next as ConsentBasis)}
		/>
		<FormActions
			submitting={$submitting}
			submitLabel="Добавить контакт"
			oncancel={() => goto(resolve('/(app)/people'))}
		/>
	</form>
</div>
