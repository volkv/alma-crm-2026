<script lang="ts">
	import { untrack } from 'svelte';
	import type { SuperForm } from 'sveltekit-superforms';
	import FieldInput from '$lib/components/form/field-input.svelte';
	import FieldSelect from '$lib/components/form/field-select.svelte';
	import type { CreateProgramInput, LifecycleStatus, ProgramLevel } from '$lib/contracts/directory';
	import { LIFECYCLE_STATUS_OPTIONS, PROGRAM_LEVEL_OPTIONS } from './labels';

	/** Поля образовательной программы. Версии заводятся отдельно, из карточки. */
	let { superform }: { superform: SuperForm<CreateProgramInput> } = $props();

	// Набор сторов у формы один на всё её время жизни: берём его один раз.
	const { form, errors } = untrack(() => superform);
</script>

<div class="grid gap-4 sm:grid-cols-2">
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
</div>

<FieldInput name="name" label="Название" required errors={$errors.name} bind:value={$form.name} />

<div class="grid gap-4 sm:grid-cols-2">
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
</div>
