<script lang="ts">
	import { untrack } from 'svelte';
	import type { SuperForm } from 'sveltekit-superforms';
	import FieldInput from '$lib/components/form/field-input.svelte';
	import FieldSelect from '$lib/components/form/field-select.svelte';
	import FieldTextarea from '$lib/components/form/field-textarea.svelte';
	import type { CreateProductInput, LifecycleStatus, LookupOption } from '$lib/contracts/directory';
	import { LIFECYCLE_STATUS_OPTIONS, NO_OPTION, toLookupOptions } from './labels';

	/** Поля продукта: код, название, поставщик и состояние. */
	let {
		superform,
		organizations
	}: {
		superform: SuperForm<CreateProductInput>;
		/** Кого можно выбрать поставщиком — организации в области доступа. */
		organizations: readonly LookupOption[];
	} = $props();

	// Набор сторов у формы один на всё её время жизни: берём его один раз.
	const { form, errors } = untrack(() => superform);
</script>

<div class="grid gap-4 sm:grid-cols-2">
	<FieldInput
		name="code"
		label="Код продукта"
		required
		errors={$errors.code}
		bind:value={$form.code}
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

<FieldInput name="name" label="Название" required errors={$errors.name} bind:value={$form.name} />

<FieldSelect
	name="vendorOrganizationId"
	label="Правообладатель"
	description="Организация, которой принадлежит продукт, если она известна."
	options={toLookupOptions(organizations, 'Не указан')}
	errors={$errors.vendorOrganizationId}
	bind:value={
		() => $form.vendorOrganizationId ?? NO_OPTION,
		(next) => ($form.vendorOrganizationId = next === NO_OPTION ? null : next)
	}
/>

<FieldTextarea
	name="description"
	label="Описание"
	errors={$errors.description}
	bind:value={() => $form.description ?? '', (next) => ($form.description = next.trim() || null)}
/>
