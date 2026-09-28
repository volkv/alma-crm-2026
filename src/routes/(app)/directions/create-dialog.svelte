<script lang="ts">
	import { untrack } from 'svelte';
	import { superForm } from 'sveltekit-superforms';
	import { zod4Client } from 'sveltekit-superforms/adapters';
	import CreateDialog from '$lib/components/create-dialog/create-dialog.svelte';
	import DirectionFields from '$lib/components/directory/direction-fields.svelte';
	import FormAlert from '$lib/components/directory/form-alert.svelte';
	import type { DirectoryMessage } from '$lib/components/directory/messages';
	import { createDirectionSchema, type CreateDirectionInput } from '$lib/contracts/directory';
	import type { PageData } from './$types';

	/**
	 * Окно «Новое направление» над списком направлений. Позицию в списке не
	 * спрашивает: новое направление встаёт в конец. После создания — сразу в
	 * карточку нового направления (переход делает сервер).
	 */
	let {
		open = $bindable(false),
		create
	}: {
		open?: boolean;
		create: NonNullable<PageData['create']>;
	} = $props();

	const superform = superForm<CreateDirectionInput, DirectoryMessage>(
		// superforms берёт начальную форму один раз и дальше следит за
		// обновлениями страницы сам, поэтому чтение не является зависимостью.
		untrack(() => create.form),
		{
			validators: zod4Client(createDirectionSchema),
			// Сохранённое окно уводит в карточку: список под ним обновлять незачем.
			invalidateAll: false
		}
	);

	const { enhance, submitting, message, tainted, reset } = superform;
</script>

<CreateDialog
	bind:open
	title="Новое направление"
	description="ИТ-направление оператора: по нему назначают ответственных и собирают разрезы отчёта."
	formId="create-direction-form"
	submitLabel="Создать направление"
	submitting={$submitting}
	dirty={$tainted !== undefined}
	onclose={() => reset()}
>
	<form
		id="create-direction-form"
		method="POST"
		action="?/create"
		use:enhance
		novalidate
		class="flex flex-col gap-4"
	>
		<FormAlert message={$message} />
		<DirectionFields {superform} />
	</form>
</CreateDialog>
