<script lang="ts">
	import { untrack } from 'svelte';
	import { superForm } from 'sveltekit-superforms';
	import { zod4Client } from 'sveltekit-superforms/adapters';
	import { resolve } from '$app/paths';
	import type { ResolvedPathname } from '$app/types';
	import CreateDialog from '$lib/components/create-dialog/create-dialog.svelte';
	import { CREATE_PARAM, createHref } from '$lib/components/create-dialog/open-param';
	import AffiliationFields from '$lib/components/directory/affiliation-fields.svelte';
	import FormAlert from '$lib/components/directory/form-alert.svelte';
	import type { DirectoryMessage } from '$lib/components/directory/messages';
	import EmptyState from '$lib/components/empty-state.svelte';
	import { createAffiliationSchema, type CreateAffiliationInput } from '$lib/contracts/directory';
	import { FOR_ORGANIZATION_PARAM } from '../../people/create-params';
	import type { PageData } from './$types';

	/**
	 * Окно «Добавить контакт» на карточке организации. После сохранения сервер
	 * возвращает на ту же карточку с `?done`: окно закрывается, контакт
	 * появляется в списке, тост говорит, что он добавлен.
	 */
	let {
		open = $bindable(false),
		create,
		organizationId,
		organizationName
	}: {
		open?: boolean;
		create: NonNullable<PageData['createAffiliation']>;
		organizationId: string;
		organizationName: string;
	} = $props();

	const FORM_ID = 'create-organization-affiliation-form';

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

	const empty = $derived(create.people.length === 0);

	/**
	 * Новый человек из этого окна: окно «Добавить контакт» на списке людей,
	 * после сохранения он вернётся сюда уже выбранным. Путь собран `resolve`;
	 * добавлена только строка запроса, а её типа в `ResolvedPathname` нет.
	 */
	const newPersonHref = $derived(
		createHref(resolve('/(app)/people'), {
			[FOR_ORGANIZATION_PARAM]: organizationId
		}) as ResolvedPathname
	);
</script>

<!-- Без людей контакт не из чего собрать: окно объясняет это, а кнопка ведёт
	туда, где человека заводят, — с возвратом сюда. -->
<CreateDialog
	bind:open
	title="Новый контакт"
	description={organizationName}
	formId={FORM_ID}
	submitLabel={empty ? 'Добавить человека' : 'Добавить контакт'}
	submitting={$submitting}
	dirty={$tainted !== undefined}
	onclose={reset}
>
	{#if empty}
		<EmptyState
			title="В справочнике пока нет людей"
			description="Контакт — это роль человека в организации, поэтому сначала заводят человека."
		/>
		<form id={FORM_ID} method="GET" action={resolve('/(app)/people')} hidden>
			<input type="hidden" name={CREATE_PARAM} value="" />
			<input type="hidden" name={FOR_ORGANIZATION_PARAM} value={organizationId} />
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
			<AffiliationFields
				{superform}
				mode="in-organization"
				people={create.people}
				sites={create.siteOptions}
			/>
			<p class="-mt-2 text-xs text-muted-foreground">
				Нужного человека нет в списке?
				<a class="text-link hover:text-link-hover" href={newPersonHref}>Добавить нового</a> — после сохранения
				он вернётся в эту форму выбранным.
			</p>
		</form>
	{/if}
</CreateDialog>
