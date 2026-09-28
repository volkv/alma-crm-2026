<script lang="ts">
	import { untrack } from 'svelte';
	import { superForm } from 'sveltekit-superforms';
	import { zod4Client } from 'sveltekit-superforms/adapters';
	import CreateDialog from '$lib/components/create-dialog/create-dialog.svelte';
	import FormAlert from '$lib/components/directory/form-alert.svelte';
	import type { DirectoryMessage } from '$lib/components/directory/messages';
	import SiteFields from '$lib/components/directory/site-fields.svelte';
	import { createSiteSchema, type CreateSiteInput } from '$lib/contracts/directory';
	import type { PageData } from './$types';

	/**
	 * Окно «Добавить площадку» на карточке организации. После сохранения сервер
	 * возвращает на ту же карточку с `?done`: окно закрывается, площадка
	 * появляется в списке, тост говорит, что она добавлена.
	 */
	let {
		open = $bindable(false),
		create,
		organizationName
	}: {
		open?: boolean;
		create: NonNullable<PageData['createSite']>;
		organizationName: string;
	} = $props();

	const FORM_ID = 'create-site-form';

	const superform = superForm<CreateSiteInput, DirectoryMessage>(
		// superforms берёт начальную форму один раз и дальше следит за
		// обновлениями страницы сам, поэтому чтение намеренно не зависимость.
		untrack(() => create.form),
		{
			validators: zod4Client(createSiteSchema),
			onResult: ({ result }) => {
				// Переход на эту же карточку не пересоздаёт страницу: окно
				// закрывается само, иначе оно осталось бы открытым над тостом.
				if (result.type === 'redirect') {
					open = false;
					reset();
				}
			}
		}
	);

	const { enhance, submitting, tainted, reset, message } = superform;
</script>

<CreateDialog
	bind:open
	title="Новая площадка"
	description={organizationName}
	formId={FORM_ID}
	submitLabel="Добавить площадку"
	submitting={$submitting}
	dirty={$tainted !== undefined}
	width="wide"
	onclose={reset}
>
	<form
		id={FORM_ID}
		method="POST"
		action="?/createSite"
		use:enhance
		novalidate
		class="flex flex-col gap-4"
	>
		<FormAlert message={$message} />
		<SiteFields {superform} />
	</form>
</CreateDialog>
