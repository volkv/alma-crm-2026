<script lang="ts">
	import { untrack } from 'svelte';
	import type { SuperForm } from 'sveltekit-superforms';
	import FieldInput from '$lib/components/form/field-input.svelte';
	import type { CreateDirectionInput } from '$lib/contracts/directory';

	/**
	 * Поля ИТ-направления: код и название.
	 *
	 * Позиции в списке здесь нет намеренно: её назначает сервис — новое
	 * направление встаёт в конец, — а позиция уникальна, и правка одной строки
	 * задевала бы соседние.
	 */
	let { superform }: { superform: SuperForm<CreateDirectionInput> } = $props();

	// Набор сторов у формы один на всё её время жизни: берём его один раз.
	const { form, errors } = untrack(() => superform);
</script>

<FieldInput
	name="code"
	label="Код направления"
	required
	description="Короткий код, которым направление узнают в выгрузках: OPS, QA, WEB."
	errors={$errors.code}
	bind:value={$form.code}
/>

<FieldInput
	name="name"
	label="Название"
	required
	description="Как направление называют в работе: DevOps, Аналитика данных и ИИ."
	errors={$errors.name}
	bind:value={$form.name}
/>
