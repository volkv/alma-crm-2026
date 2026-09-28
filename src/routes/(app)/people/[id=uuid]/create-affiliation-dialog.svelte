<script lang="ts">
	import { untrack } from 'svelte';
	import { superForm } from 'sveltekit-superforms';
	import { zod4Client } from 'sveltekit-superforms/adapters';
	import { resolve } from '$app/paths';
	import CreateDialog from '$lib/components/create-dialog/create-dialog.svelte';
	import { CREATE_PARAM } from '$lib/components/create-dialog/open-param';
	import AffiliationFields from '$lib/components/directory/affiliation-fields.svelte';
	import FormAlert from '$lib/components/directory/form-alert.svelte';
	import type { DirectoryMessage } from '$lib/components/directory/messages';
	import EmptyState from '$lib/components/empty-state.svelte';
	import InlineHint from '$lib/components/inline-hint.svelte';
	import { createAffiliationSchema, type CreateAffiliationInput } from '$lib/contracts/directory';
	import type { PageData } from './$types';

	/**
	 * Окно «Добавить роль» на карточке человека. После сохранения сервер
	 * возвращает на ту же карточку с `?done`: окно закрывается, роль появляется
	 * в таблице, тост говорит, что она добавлена.
	 */
	let {
		open = $bindable(false),
		create,
		fullName
	}: {
		open?: boolean;
		create: NonNullable<PageData['createAffiliation']>;
		fullName: string;
	} = $props();

	const FORM_ID = 'create-person-affiliation-form';

	const superform = superForm<CreateAffiliationInput, DirectoryMessage>(
		// superforms берёт начальную форму один раз и дальше следит за
		// обновлениями страницы сам, поэтому чтение намеренно не зависимость.
		untrack(() => create.form),
		{
			validators: zod4Client(createAffiliationSchema),
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

	const empty = $derived(create.organizations.length === 0);
</script>

<!-- Без организаций роль не из чего собрать: окно объясняет это, а кнопка
	ведёт туда, где организацию заводят. -->
<CreateDialog
	bind:open
	title="Новая роль"
	description={fullName}
	formId={FORM_ID}
	submitLabel={empty ? 'Добавить организацию' : 'Добавить роль'}
	submitting={$submitting}
	dirty={$tainted !== undefined}
	onclose={reset}
>
	{#if empty}
		<EmptyState
			title="Нет ни одной действующей организации"
			description="Роль связывает человека с организацией, поэтому сначала заводят организацию."
		/>
		<form id={FORM_ID} method="GET" action={resolve('/(app)/organizations')} hidden>
			<input type="hidden" name={CREATE_PARAM} value="" />
		</form>
	{:else}
		<form
			id={FORM_ID}
			method="POST"
			action="?/createAffiliation"
			use:enhance
			novalidate
			class="flex flex-col gap-4"
		>
			<FormAlert message={$message} />
			<AffiliationFields {superform} mode="for-person" organizations={create.organizations} />
			<InlineHint>
				Площадку у роли назначают в карточке организации: она обязана принадлежать именно этой
				организации.
			</InlineHint>
		</form>
	{/if}
</CreateDialog>
