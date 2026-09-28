<script lang="ts">
	import { untrack } from 'svelte';
	import { superForm } from 'sveltekit-superforms';
	import { zod4Client } from 'sveltekit-superforms/adapters';
	import CreateDialog from '$lib/components/create-dialog/create-dialog.svelte';
	import FormAlert from '$lib/components/directory/form-alert.svelte';
	import type { DirectoryMessage } from '$lib/components/directory/messages';
	import ProgramVersionFields from '$lib/components/directory/program-version-fields.svelte';
	import InlineHint from '$lib/components/inline-hint.svelte';
	import {
		createProgramVersionSchema,
		type CreateProgramVersionInput
	} from '$lib/contracts/directory';
	import type { PageData } from './$types';

	/**
	 * Окно «Новая версия» над карточкой программы. После добавления сервер
	 * возвращает на ту же карточку: таблица версий перечитывается, а окно
	 * закрывается само — страница под ним не сменилась.
	 */
	let {
		open = $bindable(false),
		create,
		programName,
		nextVersion
	}: {
		open?: boolean;
		create: NonNullable<PageData['createVersion']>;
		programName: string;
		/** Номер, который получит версия: его выдаёт сервис, здесь он только называется. */
		nextVersion: number;
	} = $props();

	const superform = superForm<CreateProgramVersionInput, DirectoryMessage>(
		// superforms берёт начальную форму один раз и дальше следит за
		// обновлениями страницы сам, поэтому чтение не является зависимостью.
		untrack(() => create.form),
		{
			validators: zod4Client(createProgramVersionSchema),
			// Карточка под окном та же, и после добавления её надо перечитать —
			// поэтому `invalidateAll` остаётся включённым.
			onResult({ result }) {
				// Закрытие отсюда идёт мимо крестика, поэтому набранное забывается
				// здесь же: следующее открытие — новая версия.
				if (result.type === 'redirect') {
					open = false;
					reset();
				}
			}
		}
	);

	const { enhance, submitting, message, tainted, reset } = superform;
</script>

<CreateDialog
	bind:open
	title="Новая версия"
	description={programName}
	formId="create-program-version-form"
	submitLabel="Добавить версию"
	submitting={$submitting}
	dirty={$tainted !== undefined}
	onclose={() => reset()}
>
	<form
		id="create-program-version-form"
		method="POST"
		action="?/createVersion"
		use:enhance
		novalidate
		class="flex flex-col gap-form"
	>
		<FormAlert message={$message} />
		<InlineHint>
			Версия получит номер {nextVersion}: номера выдаёт сервис по порядку, вручную их не назначают.
		</InlineHint>
		<ProgramVersionFields {superform} />
	</form>
</CreateDialog>
