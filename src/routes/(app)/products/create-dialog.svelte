<script lang="ts">
	import { untrack } from 'svelte';
	import { superForm } from 'sveltekit-superforms';
	import { zod4Client } from 'sveltekit-superforms/adapters';
	import CreateDialog from '$lib/components/create-dialog/create-dialog.svelte';
	import FormAlert from '$lib/components/directory/form-alert.svelte';
	import type { DirectoryMessage } from '$lib/components/directory/messages';
	import ProductFields from '$lib/components/directory/product-fields.svelte';
	import { createProductSchema, type CreateProductInput } from '$lib/contracts/directory';
	import type { PageData } from './$types';

	/**
	 * Окно «Новый продукт» над списком продуктов. Поля те же, что в правке
	 * карточки. После создания — сразу в карточку нового продукта (переход
	 * делает сервер).
	 */
	let {
		open = $bindable(false),
		create
	}: {
		open?: boolean;
		create: NonNullable<PageData['create']>;
	} = $props();

	const superform = superForm<CreateProductInput, DirectoryMessage>(
		// superforms берёт начальную форму один раз и дальше следит за
		// обновлениями страницы сам, поэтому чтение не является зависимостью.
		untrack(() => create.form),
		{
			validators: zod4Client(createProductSchema),
			// Сохранённое окно уводит в карточку: список под ним обновлять незачем.
			invalidateAll: false
		}
	);

	const { enhance, submitting, message, tainted, reset } = superform;
</script>

<CreateDialog
	bind:open
	title="Новый продукт"
	description="То, что оператор предлагает вузам вместе с программами."
	formId="create-product-form"
	submitLabel="Создать продукт"
	submitting={$submitting}
	dirty={$tainted !== undefined}
	onclose={() => reset()}
>
	<form
		id="create-product-form"
		method="POST"
		action="?/create"
		use:enhance
		novalidate
		class="flex flex-col gap-4"
	>
		<FormAlert message={$message} />
		<ProductFields {superform} organizations={create.organizations} />
	</form>
</CreateDialog>
