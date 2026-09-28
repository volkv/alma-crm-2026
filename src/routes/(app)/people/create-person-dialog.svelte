<script lang="ts">
	import { untrack } from 'svelte';
	import { superForm } from 'sveltekit-superforms';
	import { zod4Client } from 'sveltekit-superforms/adapters';
	import CreateDialog from '$lib/components/create-dialog/create-dialog.svelte';
	import FormAlert from '$lib/components/directory/form-alert.svelte';
	import type { DirectoryMessage } from '$lib/components/directory/messages';
	import PersonFields from '$lib/components/directory/person-fields.svelte';
	import FieldSelect from '$lib/components/form/field-select.svelte';
	import { CONSENT_BASIS_LABELS } from '$lib/components/directory/labels';
	import {
		CONSENT_BASES,
		newPersonSchema,
		type ConsentBasis,
		type NewPersonInput
	} from '$lib/contracts/directory';
	import { FOR_ORGANIZATION_PARAM } from './create-params';
	import type { PageData } from './$types';

	/**
	 * Окно «Добавить контакт». После создания — в карточку человека, а если
	 * окно открыли из формы контакта организации — обратно в неё, уже с ним
	 * (переход делает сервер).
	 */
	let {
		open = $bindable(false),
		create
	}: {
		open?: boolean;
		create: NonNullable<PageData['createPerson']>;
	} = $props();

	const FORM_ID = 'create-person-form';

	const superform = superForm<NewPersonInput, DirectoryMessage>(
		// superforms берёт начальную форму один раз и дальше следит за
		// обновлениями страницы сам, поэтому чтение намеренно не зависимость.
		untrack(() => create.form),
		{
			validators: zod4Client(newPersonSchema),
			// Сохранённое окно уводит со списка: обновлять его незачем.
			invalidateAll: false
		}
	);

	const { form, errors, enhance, submitting, tainted, reset, message } = superform;

	// Организация, в форму контакта которой вернуться, относится к первому
	// открытию: закрытое окно открывают снова уже как обычное.
	let forOrganization = $state<string | null>(untrack(() => create.forOrganization));

	/**
	 * Организация едет в адресе действия, а не полем: форма людей её не знает,
	 * и в данные человека она попадать не должна.
	 */
	const action = $derived(
		forOrganization === null
			? '?/createPerson'
			: `?/createPerson&${FOR_ORGANIZATION_PARAM}=${encodeURIComponent(forOrganization)}`
	);

	const BASIS_OPTIONS = CONSENT_BASES.map((basis) => ({
		value: basis,
		label: CONSENT_BASIS_LABELS[basis]
	}));

	/** Закрытое окно забывает набранное: следующее открытие — новая запись. */
	function clear() {
		reset();
		forOrganization = null;
	}
</script>

<CreateDialog
	bind:open
	title="Новый контакт"
	description="Человек, с которым идёт работа. Роль в организации ему назначают следом."
	formId={FORM_ID}
	submitLabel="Добавить контакт"
	submitting={$submitting}
	dirty={$tainted !== undefined}
	onclose={clear}
>
	<form id={FORM_ID} method="POST" {action} use:enhance novalidate class="flex flex-col gap-form">
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
	</form>
</CreateDialog>
