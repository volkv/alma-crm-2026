<script lang="ts">
	import { untrack } from 'svelte';
	import type { SuperForm } from 'sveltekit-superforms';
	import { Checkbox } from '$lib/components/ui/checkbox/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import FieldInput from '$lib/components/form/field-input.svelte';
	import FieldSelect from '$lib/components/form/field-select.svelte';
	import type {
		AffiliationRoleKind,
		CreateAffiliationInput,
		LookupOption
	} from '$lib/contracts/directory';
	import { AFFILIATION_ROLE_OPTIONS, NO_OPTION, toLookupOptions } from './labels';

	/**
	 * Роль человека в организации.
	 *
	 * У формы две стороны: из карточки организации выбирают человека и площадку
	 * (организация уже известна), из карточки человека — организацию. Площадку в
	 * этом случае не спрашивают: она обязана принадлежать выбранной организации,
	 * а список площадок заранее неизвестен — её добавляют из карточки организации.
	 */
	let {
		superform,
		mode,
		people = [],
		organizations = [],
		sites = []
	}: {
		superform: SuperForm<CreateAffiliationInput>;
		mode: 'in-organization' | 'for-person';
		people?: readonly LookupOption[];
		organizations?: readonly LookupOption[];
		sites?: readonly LookupOption[];
	} = $props();

	// Набор сторов у формы один на всё её время жизни: берём его один раз.
	const { form, errors } = untrack(() => superform);
</script>

{#if mode === 'in-organization'}
	<input type="hidden" name="organizationId" value={$form.organizationId} />

	<FieldSelect
		name="personId"
		label="Человек"
		required
		options={toLookupOptions(people)}
		placeholder="Выберите человека"
		errors={$errors.personId}
		bind:value={$form.personId}
	/>

	<FieldSelect
		name="siteId"
		label="Площадка"
		description="Необязательно: роль может относиться к организации целиком."
		options={toLookupOptions(sites, 'Без площадки')}
		errors={$errors.siteId}
		bind:value={
			() => $form.siteId ?? NO_OPTION, (next) => ($form.siteId = next === NO_OPTION ? null : next)
		}
	/>
{:else}
	<input type="hidden" name="personId" value={$form.personId} />

	<FieldSelect
		name="organizationId"
		label="Организация"
		required
		options={toLookupOptions(organizations)}
		placeholder="Выберите организацию"
		errors={$errors.organizationId}
		bind:value={$form.organizationId}
	/>
{/if}

<div class="grid gap-4 sm:grid-cols-2">
	<FieldInput
		name="position"
		label="Должность"
		required
		placeholder="Проректор по цифровому развитию"
		errors={$errors.position}
		bind:value={$form.position}
	/>
	<FieldSelect
		name="roleKind"
		label="Роль в процессе"
		required
		options={AFFILIATION_ROLE_OPTIONS}
		errors={$errors.roleKind}
		bind:value={() => $form.roleKind, (next) => ($form.roleKind = next as AffiliationRoleKind)}
	/>
</div>

<div class="grid gap-4 sm:grid-cols-2">
	<FieldInput
		name="validFrom"
		label="Полномочия с"
		type="date"
		required
		errors={$errors.validFrom}
		bind:value={$form.validFrom}
	/>
	<FieldInput
		name="validTo"
		label="Полномочия по"
		type="date"
		description="Оставьте пустым, пока полномочия действуют."
		errors={$errors.validTo}
		bind:value={() => $form.validTo ?? '', (next) => ($form.validTo = next || null)}
	/>
</div>

<FieldInput
	name="channel"
	label="Как связываться"
	placeholder="Почта, телефон, портал вуза"
	errors={$errors.channel}
	bind:value={() => $form.channel ?? '', (next) => ($form.channel = next.trim() || null)}
/>

<div class="flex items-center gap-2">
	<Checkbox id="isPrimary" name="isPrimary" value="true" bind:checked={$form.isPrimary} />
	<Label for="isPrimary">Основной контакт организации по процессу</Label>
</div>
