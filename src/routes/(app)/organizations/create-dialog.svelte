<script lang="ts">
	import { untrack } from 'svelte';
	import { superForm } from 'sveltekit-superforms';
	import { zod4Client } from 'sveltekit-superforms/adapters';
	import { Button } from '$lib/components/ui/button/index.js';
	import CreateDialog from '$lib/components/create-dialog/create-dialog.svelte';
	import FormAlert from '$lib/components/directory/form-alert.svelte';
	import type { DirectoryMessage } from '$lib/components/directory/messages';
	import OrganizationFields from '$lib/components/directory/organization-fields.svelte';
	import { createOrganizationSchema, type CreateOrganizationInput } from '$lib/contracts/directory';
	import { lookupQueryKind, type PassportAcceptance } from '$lib/contracts/enrichment';
	import PassportPanel from './passport/passport-panel.svelte';
	import RegistryStart from './registry-start.svelte';
	import type { PageData } from './$types';

	/**
	 * Окно «Новая организация». Начинается с поиска по ЕГРЮЛ: выбранная строка
	 * заводится сразу и открывает карточку (переход делает сервер). Ручная форма
	 * с паспортом из источников — запасной путь, на неё переключает «Добавить
	 * вручную», и набранная в поиске строка переезжает в её поля.
	 *
	 * Кнопка внизу окна одна: в поиске она переводит к ручной форме, в ручной
	 * форме — создаёт.
	 */
	let {
		open = $bindable(false),
		create
	}: {
		open?: boolean;
		create: NonNullable<PageData['create']>;
	} = $props();

	const FORM_ID = 'create-organization-form';

	const superform = superForm<CreateOrganizationInput, DirectoryMessage>(
		// superforms берёт начальную форму один раз и дальше следит за обновлениями
		// страницы сам, поэтому чтение намеренно не становится зависимостью.
		untrack(() => create.form),
		{
			validators: zod4Client(createOrganizationSchema),
			// Сохранённое окно уводит в карточку: список под ним обновлять незачем.
			invalidateAll: false
		}
	);

	const { form, enhance, submitting, tainted, reset, message } = superform;

	let manual = $state(untrack(() => create.startManual));
	/** Строка поиска по ЕГРЮЛ: пока она набрана, закрыть окно без вопроса нельзя. */
	let query = $state('');
	/** Поля, принятые из паспорта: уходят с формой, чтобы сервер записал их происхождение. */
	let accepted = $state<PassportAcceptance>([]);

	/**
	 * Набранная строка переезжает в ручную форму: ИНН — в поле ИНН, остальное —
	 * в наименования. Подстановка не считается вводом: её никто не набирал в
	 * этих полях, и крестик из-за неё не спрашивает подтверждения.
	 */
	function prefill(typed: string) {
		if (typed === '') return;

		const { kind, query: value } = lookupQueryKind(typed);

		form.update(
			($form) =>
				kind === 'inn'
					? { ...$form, inn: value }
					: { ...$form, legalName: value, shortName: value },
			{ taint: false }
		);
	}

	// Строка из ссылки `?create&manual&name=…` — ручная форма открывается с ней.
	if (untrack(() => create.startManual)) {
		prefill(untrack(() => create.typed));
	}

	function toManual(typed: string) {
		prefill(typed);
		query = '';
		manual = true;
	}

	/** Есть ли что терять: крестик тогда спросит подтверждение. */
	const dirty = $derived(
		manual ? $tainted !== undefined || accepted.length > 0 : query.trim() !== ''
	);

	/** Закрытое окно забывает набранное: следующее открытие — новая запись. */
	function clear() {
		reset();
		accepted = [];
		query = '';
		manual = !create.registry;
	}
</script>

<CreateDialog
	bind:open
	title="Новая организация"
	description={manual
		? 'Реквизиты, вид и сайт. Площадки, контакты и роли людей дополняют в карточке.'
		: 'Найдите организацию в ЕГРЮЛ — карточка создастся с реквизитами из реестра.'}
	formId={FORM_ID}
	submitLabel="Создать организацию"
	actions={manual ? undefined : toManualAction}
	submitting={$submitting}
	{dirty}
	width="wide"
	onclose={clear}
>
	{#if manual}
		<div class="flex flex-col gap-4">
			{#if create.registry}
				<p class="text-sm text-muted-foreground">
					Заполните карточку вручную или
					<button
						type="button"
						class="underline underline-offset-2 focus-ring hover:text-foreground"
						onclick={() => (manual = false)}>вернитесь к поиску в ЕГРЮЛ</button
					>.
				</p>
			{/if}

			<PassportPanel {superform} availability={create.passport} bind:accepted />

			<form
				id={FORM_ID}
				method="POST"
				action="?/create"
				use:enhance
				novalidate
				class="flex flex-col gap-form"
			>
				<FormAlert message={$message} confirmLabel="Создать всё равно" />
				<input type="hidden" name="passport" value={JSON.stringify(accepted)} />
				<OrganizationFields {superform} allowVendor={create.allowVendor} />
			</form>
		</div>
	{:else}
		<RegistryStart allowVendor={create.allowVendor} bind:query onmanual={toManual} />
	{/if}
</CreateDialog>

{#snippet toManualAction()}
	<div class="flex justify-end">
		<Button variant="outline" onclick={() => toManual(query.trim())}>Добавить вручную</Button>
	</div>
{/snippet}
