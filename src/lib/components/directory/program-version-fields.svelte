<script lang="ts">
	import { untrack } from 'svelte';
	import type { SuperForm } from 'sveltekit-superforms';
	import FieldInput from '$lib/components/form/field-input.svelte';
	import FieldTextarea from '$lib/components/form/field-textarea.svelte';
	import type { CreateProgramVersionInput } from '$lib/contracts/directory';

	/**
	 * Новая версия программы. Номер не спрашивают: его выдаёт сервис по порядку,
	 * иначе две одновременные версии получили бы один номер.
	 */
	let { superform }: { superform: SuperForm<CreateProgramVersionInput> } = $props();

	// Набор сторов у формы один на всё её время жизни: берём его один раз.
	const { form, errors } = untrack(() => superform);
</script>

<input type="hidden" name="programId" value={$form.programId} />

<FieldTextarea
	name="summary"
	label="Что изменилось"
	required
	rows={4}
	description="Одним абзацем: по нему поймут, чем эта версия отличается от прошлой."
	errors={$errors.summary}
	bind:value={$form.summary}
/>

<FieldInput
	name="effectiveFrom"
	label="Действует с"
	type="date"
	required
	errors={$errors.effectiveFrom}
	bind:value={$form.effectiveFrom}
/>
