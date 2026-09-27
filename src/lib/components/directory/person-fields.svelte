<script lang="ts">
	import { untrack } from 'svelte';
	import type { SuperForm } from 'sveltekit-superforms';
	import FieldInput from '$lib/components/form/field-input.svelte';
	import FieldTextarea from '$lib/components/form/field-textarea.svelte';
	import InlineHint from '$lib/components/inline-hint.svelte';
	import type { CreatePersonInput, NewPersonInput } from '$lib/contracts/directory';

	/** Поля человека. Почта и телефон — персональные данные, о чём форма и говорит. */
	let {
		superform
	}: {
		/** Форма карточки человека или форма нового человека — с основанием обработки. */
		superform: SuperForm<CreatePersonInput> | SuperForm<NewPersonInput>;
	} = $props();

	// Набор сторов у формы один на всё её время жизни: берём его один раз.
	const { form, errors } = untrack(() => superform);
</script>

<div class="grid gap-4 sm:grid-cols-3">
	<FieldInput
		name="lastName"
		label="Фамилия"
		required
		errors={$errors.lastName}
		bind:value={$form.lastName}
	/>
	<FieldInput
		name="firstName"
		label="Имя"
		required
		errors={$errors.firstName}
		bind:value={$form.firstName}
	/>
	<FieldInput
		name="middleName"
		label="Отчество"
		errors={$errors.middleName}
		bind:value={() => $form.middleName ?? '', (next) => ($form.middleName = next.trim() || null)}
	/>
</div>

<div class="grid gap-4 sm:grid-cols-2">
	<FieldInput
		name="email"
		label="Электронная почта"
		type="email"
		errors={$errors.email}
		bind:value={() => $form.email ?? '', (next) => ($form.email = next.trim() || null)}
	/>
	<FieldInput
		name="phone"
		label="Телефон"
		placeholder="+7 495 000-00-00"
		errors={$errors.phone}
		bind:value={() => $form.phone ?? '', (next) => ($form.phone = next.trim() || null)}
	/>
</div>

<InlineHint>
	Контакты — персональные данные: без права «Просмотр контактов людей без маскирования» они
	показываются закрытыми, а в журнал действий не попадают вовсе.
</InlineHint>

<FieldTextarea
	name="notes"
	label="Заметки"
	errors={$errors.notes}
	bind:value={() => $form.notes ?? '', (next) => ($form.notes = next.trim() || null)}
/>
