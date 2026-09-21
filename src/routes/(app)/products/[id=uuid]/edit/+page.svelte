<script lang="ts">
	import { untrack } from 'svelte';
	import { superForm } from 'sveltekit-superforms';
	import { zod4Client } from 'sveltekit-superforms/adapters';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import FormAlert from '$lib/components/directory/form-alert.svelte';
	import type { DirectoryMessage } from '$lib/components/directory/messages';
	import ProductFields from '$lib/components/directory/product-fields.svelte';
	import FormActions from '$lib/components/form/form-actions.svelte';
	import Breadcrumbs from '$lib/components/breadcrumbs.svelte';
	import Header from '$lib/components/header.svelte';
	import { createProductSchema, type CreateProductInput } from '$lib/contracts/directory';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const cardHref = $derived(resolve('/(app)/products/[id=uuid]', { id: data.product.id }));

	const superform = superForm<CreateProductInput, DirectoryMessage>(
		untrack(() => data.form),
		{
			validators: zod4Client(createProductSchema),
			taintedMessage: 'Введённые данные не сохранены. Уйти со страницы?'
		}
	);

	const { enhance, submitting, message } = superform;
</script>

<svelte:head><title>{data.product.code}: изменение — LCT CRM</title></svelte:head>

<Header title="Изменение продукта" description={data.product.name} />

<Breadcrumbs
	items={[
		{ label: 'Продукты', href: resolve('/(app)/products') },
		{ label: data.product.code, href: cardHref },
		{ label: 'Изменение продукта' }
	]}
/>

<div class="p-4 sm:p-6">
	<form
		data-tour="product-edit-form"
		method="POST"
		use:enhance
		novalidate
		class="flex max-w-3xl flex-col gap-4 rounded-lg border border-border bg-surface p-4 sm:p-6"
	>
		<FormAlert message={$message} />
		<ProductFields {superform} organizations={data.organizations} />
		<FormActions
			submitting={$submitting}
			submitLabel="Сохранить продукт"
			oncancel={() => goto(cardHref)}
		/>
	</form>
</div>
