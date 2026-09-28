<script lang="ts">
	import { untrack } from 'svelte';
	import { superForm } from 'sveltekit-superforms';
	import { zod4Client } from 'sveltekit-superforms/adapters';
	import CreateDialog from '$lib/components/create-dialog/create-dialog.svelte';
	import FormAlert from '$lib/components/directory/form-alert.svelte';
	import type { DirectoryMessage } from '$lib/components/directory/messages';
	import ProgramFields from '$lib/components/directory/program-fields.svelte';
	import { createProgramSchema, type CreateProgramInput } from '$lib/contracts/directory';
	import type { PageData } from './$types';

	/**
	 * Окно «Новая программа» над списком программ. Поля те же, что в правке
	 * карточки; версии заводятся потом, из карточки. После создания — сразу в
	 * карточку новой программы (переход делает сервер).
	 */
	let {
		open = $bindable(false),
		create
	}: {
		open?: boolean;
		create: NonNullable<PageData['create']>;
	} = $props();

	const superform = superForm<CreateProgramInput, DirectoryMessage>(
		// superforms берёт начальную форму один раз и дальше следит за
		// обновлениями страницы сам, поэтому чтение не является зависимостью.
		untrack(() => create.form),
		{
			validators: zod4Client(createProgramSchema),
			// Сохранённое окно уводит в карточку: список под ним обновлять незачем.
			invalidateAll: false
		}
	);

	const { enhance, submitting, message, tainted, reset } = superform;
</script>

<CreateDialog
	bind:open
	title="Новая программа"
	description="Программа из номенклатуры оператора. Версии добавляют потом, в её карточке."
	formId="create-program-form"
	submitLabel="Создать программу"
	submitting={$submitting}
	dirty={$tainted !== undefined}
	onclose={() => reset()}
>
	<form
		id="create-program-form"
		method="POST"
		action="?/create"
		use:enhance
		novalidate
		class="flex flex-col gap-form"
	>
		<FormAlert message={$message} />
		<ProgramFields {superform} />
	</form>
</CreateDialog>
