<script lang="ts">
	import { untrack } from 'svelte';
	import type { SuperForm } from 'sveltekit-superforms';
	import FieldInput from '$lib/components/form/field-input.svelte';
	import FieldSelect from '$lib/components/form/field-select.svelte';
	import FieldTextarea from '$lib/components/form/field-textarea.svelte';
	import type {
		CreateOrganizationInput,
		EducationLevel,
		OrganizationKind
	} from '$lib/contracts/directory';
	import { EDUCATION_LEVEL_OPTIONS, ORGANIZATION_KIND_OPTIONS } from './labels';

	/**
	 * Поля организации — один набор на создание и на изменение. Идентификатор в
	 * форму не входит: какую запись правим, говорит адрес страницы, и подменить
	 * его скрытым полем нельзя.
	 */
	let { superform }: { superform: SuperForm<CreateOrganizationInput> } = $props();

	// Набор сторов у формы один на всё её время жизни: берём его один раз.
	const { form, errors } = untrack(() => superform);

	const isSchool = $derived($form.kind === 'educational_institution');

	// Уровень образования заполняют ровно у учебных заведений — это проверяет и
	// схема, и CHECK в базе. Поэтому при смене вида поле не просто прячется:
	// иначе в форме остался бы уровень, которого по правилу быть не должно.
	$effect(() => {
		if (!isSchool && $form.educationLevel !== null) {
			$form.educationLevel = null;
		}
	});
</script>

<!-- Признак архива меняет не форма, а кнопка «В архив»: так изменение реквизитов
	 не может случайно вернуть организацию в работу. -->
<input type="hidden" name="isActive" value={$form.isActive ? 'true' : 'false'} />

<div class="grid gap-4 sm:grid-cols-2">
	<FieldSelect
		name="kind"
		label="Вид организации"
		required
		options={ORGANIZATION_KIND_OPTIONS}
		errors={$errors.kind}
		bind:value={() => $form.kind, (next) => ($form.kind = next as OrganizationKind)}
	/>

	{#if isSchool}
		<FieldSelect
			name="educationLevel"
			label="Уровень образования"
			required
			options={EDUCATION_LEVEL_OPTIONS}
			errors={$errors.educationLevel}
			bind:value={
				() => $form.educationLevel ?? '',
				(next) => ($form.educationLevel = (next || null) as EducationLevel | null)
			}
		/>
	{/if}
</div>

<FieldInput
	name="legalName"
	label="Полное наименование"
	required
	placeholder="Федеральное государственное бюджетное образовательное учреждение…"
	errors={$errors.legalName}
	bind:value={$form.legalName}
/>

<FieldInput
	name="shortName"
	label="Краткое наименование"
	required
	description="Так организация называется в списках и в документах."
	errors={$errors.shortName}
	bind:value={$form.shortName}
/>

<div class="grid gap-4 sm:grid-cols-3">
	<FieldInput
		name="inn"
		label="ИНН"
		description="10 цифр у организации, 12 — у предпринимателя."
		errors={$errors.inn}
		bind:value={() => $form.inn ?? '', (next) => ($form.inn = next.trim() || null)}
	/>
	<FieldInput
		name="kpp"
		label="КПП"
		errors={$errors.kpp}
		bind:value={() => $form.kpp ?? '', (next) => ($form.kpp = next.trim() || null)}
	/>
	<FieldInput
		name="ogrn"
		label="ОГРН"
		errors={$errors.ogrn}
		bind:value={() => $form.ogrn ?? '', (next) => ($form.ogrn = next.trim() || null)}
	/>
</div>

<div class="grid gap-4 sm:grid-cols-2">
	<FieldInput
		name="region"
		label="Регион"
		placeholder="Москва"
		errors={$errors.region}
		bind:value={() => $form.region ?? '', (next) => ($form.region = next.trim() || null)}
	/>
	<FieldInput
		name="website"
		label="Сайт"
		placeholder="https://example.ru"
		errors={$errors.website}
		bind:value={() => $form.website ?? '', (next) => ($form.website = next.trim() || null)}
	/>
</div>

<FieldTextarea
	name="notes"
	label="Заметки"
	description="Что стоит знать о работе с этой организацией."
	errors={$errors.notes}
	bind:value={() => $form.notes ?? '', (next) => ($form.notes = next.trim() || null)}
/>
