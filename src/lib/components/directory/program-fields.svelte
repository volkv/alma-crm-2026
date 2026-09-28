<script lang="ts">
	import { untrack } from 'svelte';
	import type { SuperForm } from 'sveltekit-superforms';
	import FieldInput from '$lib/components/form/field-input.svelte';
	import FieldSelect from '$lib/components/form/field-select.svelte';
	import FieldTextarea from '$lib/components/form/field-textarea.svelte';
	import FormGrid from '$lib/components/form/form-grid.svelte';
	import {
		PROGRAM_DESCRIPTION_MAX_LENGTH,
		type CreateProgramInput,
		type LifecycleStatus,
		type ProgramLevel
	} from '$lib/contracts/directory';
	import { LIFECYCLE_STATUS_OPTIONS, PROGRAM_LEVEL_OPTIONS } from './labels';

	/** Поля образовательной программы. Версии заводятся отдельно, из карточки. */
	let { superform }: { superform: SuperForm<CreateProgramInput> } = $props();

	// Набор сторов у формы один на всё её время жизни: берём его один раз.
	const { form, errors } = untrack(() => superform);
</script>

<FormGrid>
	<FieldInput
		name="code"
		label="Код программы"
		required
		description="Код в номенклатуре оператора; по нему сверяют планы и отчёты."
		errors={$errors.code}
		bind:value={$form.code}
	/>
	<FieldInput
		name="directionCode"
		label="Код направления подготовки"
		placeholder="09.03.01"
		errors={$errors.directionCode}
		bind:value={
			() => $form.directionCode ?? '', (next) => ($form.directionCode = next.trim() || null)
		}
	/>
</FormGrid>

<FieldInput name="name" label="Название" required errors={$errors.name} bind:value={$form.name} />

<!-- Абзац-другой для карточки и письма вузу; подробное описание прикладывают
     файлами в блоке «Материалы» карточки. Пробелы по краям срезает контракт при
     разборе, а не поле на каждом нажатии: иначе перенос строки между абзацами
     исчезал бы, едва его набрали. -->
<FieldTextarea
	name="description"
	label="Описание"
	rows={4}
	description="Коротко, до {PROGRAM_DESCRIPTION_MAX_LENGTH} символов. Полное описание прикладывают файлами на карточке программы."
	errors={$errors.description}
	bind:value={
		() => $form.description ?? '', (next) => ($form.description = next === '' ? null : next)
	}
/>

<FormGrid>
	<FieldSelect
		name="level"
		label="Уровень"
		required
		options={PROGRAM_LEVEL_OPTIONS}
		errors={$errors.level}
		bind:value={() => $form.level, (next) => ($form.level = next as ProgramLevel)}
	/>
	<FieldSelect
		name="status"
		label="Состояние"
		required
		options={LIFECYCLE_STATUS_OPTIONS}
		errors={$errors.status}
		bind:value={() => $form.status, (next) => ($form.status = next as LifecycleStatus)}
	/>
</FormGrid>

<!-- Пустое поле — это «приоритет не назначен», а не ноль: такие программы
     идут в списке после всех, кому его проставили. -->
<FieldInput
	name="priority"
	label="Приоритет"
	type="number"
	description="Ручной порядок показа: 1 — то, что предлагают вузу первым. Пусто — приоритет не назначен."
	errors={$errors.priority}
	bind:value={
		() => ($form.priority === null ? '' : String($form.priority)),
		(next) => ($form.priority = next.trim() === '' ? null : Number(next))
	}
/>
