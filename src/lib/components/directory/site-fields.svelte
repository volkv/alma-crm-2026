<script lang="ts">
	import { untrack } from 'svelte';
	import type { SuperForm } from 'sveltekit-superforms';
	import FieldInput from '$lib/components/form/field-input.svelte';
	import FieldSelect from '$lib/components/form/field-select.svelte';
	import type { CreateSiteInput, SiteKind } from '$lib/contracts/directory';
	import { SITE_KIND_OPTIONS } from './labels';

	/**
	 * Поля площадки. Организация приходит из адреса карточки и уезжает скрытым
	 * полем: площадку не переносят между организациями — на пару «площадка + её
	 * организация» ссылаются роли людей.
	 */
	let { superform }: { superform: SuperForm<CreateSiteInput> } = $props();

	// Набор сторов у формы один на всё её время жизни: берём его один раз.
	const { form, errors } = untrack(() => superform);
</script>

<input type="hidden" name="organizationId" value={$form.organizationId} />

<div class="grid gap-4 sm:grid-cols-2">
	<FieldInput
		name="name"
		label="Название площадки"
		required
		placeholder="Главный корпус"
		errors={$errors.name}
		bind:value={$form.name}
	/>
	<FieldSelect
		name="kind"
		label="Вид"
		required
		options={SITE_KIND_OPTIONS}
		errors={$errors.kind}
		bind:value={() => $form.kind, (next) => ($form.kind = next as SiteKind)}
	/>
</div>

<div class="grid gap-4 sm:grid-cols-2">
	<FieldInput
		name="address"
		label="Адрес"
		errors={$errors.address}
		bind:value={() => $form.address ?? '', (next) => ($form.address = next.trim() || null)}
	/>
	<FieldInput
		name="region"
		label="Регион"
		errors={$errors.region}
		bind:value={() => $form.region ?? '', (next) => ($form.region = next.trim() || null)}
	/>
</div>
