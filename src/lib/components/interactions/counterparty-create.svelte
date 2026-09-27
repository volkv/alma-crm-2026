<script lang="ts">
	import LoaderIcon from '@lucide/svelte/icons/loader-2';
	import { untrack } from 'svelte';
	import * as Select from '$lib/components/ui/select/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import {
		EDUCATION_LEVEL_LABELS,
		EDUCATION_LEVEL_OPTIONS,
		ORGANIZATION_KIND_LABELS
	} from '$lib/components/directory/labels';
	import {
		EDUCATION_LEVELS,
		type EducationLevel,
		type LookupOption,
		type OrganizationKind
	} from '$lib/contracts/directory';
	import { lookupQueryKind } from '$lib/contracts/enrichment';

	/**
	 * Контрагент, которого нет в справочнике, — прямо из поля формы.
	 *
	 * Организацию заводит сервис справочника с теми же проверками, что форма
	 * «Организации → Новая»; здесь — только поля, без которых карточку не
	 * отличить от соседней: наименования, ИНН, регион, у вуза — уровень.
	 * Остальное дополняют в карточке организации. Физическое лицо — ФИО и
	 * способ связи: человек и его роль заводятся вместе с ним.
	 *
	 * Это не `<form>`: поле выбора стоит внутри формы дела, а вложенная форма
	 * отправила бы внешнюю. Отправка — запросом к адресу подсказок.
	 */
	let {
		kind,
		lookupPath,
		query,
		oncreated,
		oncancel
	}: {
		/** Кого заводим: вид организации или физическое лицо. */
		kind: OrganizationKind;
		lookupPath: string;
		/** Что человек набрал в поиске: из этого заполняются первые поля. */
		query: string;
		oncreated: (option: LookupOption, contactAffiliationId: string | null) => void;
		oncancel: () => void;
	} = $props();

	const idPrefix = $props.id();

	function initialOrganization(text: string) {
		const typed = lookupQueryKind(text);

		return {
			shortName: typed.kind === 'name' ? typed.query : '',
			legalName: typed.kind === 'name' ? typed.query : '',
			inn: typed.kind === 'inn' ? typed.query : '',
			region: '',
			educationLevel: '' as EducationLevel | ''
		};
	}

	function initialPerson(text: string) {
		const [lastName = '', firstName = '', middleName = ''] = text.trim().split(/\s+/);

		return { lastName, firstName, middleName, email: '', phone: '' };
	}

	// Поля заполняются из набранного один раз, при открытии: дальше они — ввод
	// человека, и поиск их не переписывает. Набранное форма получает снимком
	// при открытии, другой текст — это новое открытие формы с новыми полями.
	let organization = $state(untrack(() => initialOrganization(query)));
	let person = $state(untrack(() => initialPerson(query)));
	let saving = $state(false);
	let error = $state<string | null>(null);

	const individual = $derived(kind === 'individual');
	const levelOptions = [{ value: '', label: 'Не указан' }, ...EDUCATION_LEVEL_OPTIONS];

	const isLevel = (value: string): value is EducationLevel =>
		(EDUCATION_LEVELS as readonly string[]).includes(value);

	const blank = (value: string) => (value.trim() === '' ? null : value.trim());

	function body() {
		if (individual) {
			return {
				create: 'individual',
				person: {
					lastName: person.lastName,
					firstName: person.firstName,
					middleName: blank(person.middleName),
					email: person.email.trim(),
					phone: blank(person.phone)
				}
			};
		}

		return {
			create: 'organization',
			organization: {
				kind,
				educationLevel:
					kind === 'educational_institution' && organization.educationLevel !== ''
						? organization.educationLevel
						: null,
				shortName: organization.shortName,
				legalName: organization.legalName,
				inn: blank(organization.inn),
				kpp: null,
				ogrn: null,
				region: blank(organization.region),
				website: null,
				notes: null,
				isActive: true,
				externalSource: null,
				externalId: null
			}
		};
	}

	async function save() {
		saving = true;
		error = null;

		try {
			const response = await fetch(lookupPath, {
				method: 'POST',
				headers: { 'content-type': 'application/json', accept: 'application/json' },
				body: JSON.stringify(body())
			});
			const result: {
				item?: LookupOption;
				contactAffiliationId?: string | null;
				error?: string;
			} = await response.json().catch(() => ({}));

			if (!response.ok || result.item === undefined) {
				error = result.error ?? 'Не удалось завести контрагента';
				return;
			}

			oncreated(result.item, result.contactAffiliationId ?? null);
		} catch {
			error = 'Не удалось завести контрагента: нет связи с сервером';
		} finally {
			saving = false;
		}
	}
</script>

<section
	class="flex flex-col gap-3 border-t border-border bg-surface-muted p-3"
	aria-label={individual ? 'Новое физическое лицо' : 'Новая организация'}
>
	<p class="text-xs text-muted-foreground">
		{#if individual}
			Физическое лицо появится в справочнике вместе с карточкой человека: он же контактное лицо.
		{:else}
			Организация появится в справочнике с типом «{ORGANIZATION_KIND_LABELS[kind]}», вы станете за
			неё ответственным. Остальные реквизиты дополняют в её карточке.
		{/if}
	</p>

	{#if individual}
		<div class="grid gap-3 sm:grid-cols-3">
			<div class="flex flex-col gap-1.5">
				<Label for="{idPrefix}-last">Фамилия</Label>
				<Input id="{idPrefix}-last" bind:value={person.lastName} />
			</div>
			<div class="flex flex-col gap-1.5">
				<Label for="{idPrefix}-first">Имя</Label>
				<Input id="{idPrefix}-first" bind:value={person.firstName} />
			</div>
			<div class="flex flex-col gap-1.5">
				<Label for="{idPrefix}-middle">Отчество</Label>
				<Input id="{idPrefix}-middle" bind:value={person.middleName} />
			</div>
		</div>
		<div class="grid gap-3 sm:grid-cols-2">
			<div class="flex flex-col gap-1.5">
				<Label for="{idPrefix}-email">Почта</Label>
				<Input id="{idPrefix}-email" type="email" bind:value={person.email} />
			</div>
			<div class="flex flex-col gap-1.5">
				<Label for="{idPrefix}-phone">Телефон</Label>
				<Input id="{idPrefix}-phone" type="tel" bind:value={person.phone} />
			</div>
		</div>
	{:else}
		<div class="grid gap-3 sm:grid-cols-2">
			<div class="flex flex-col gap-1.5">
				<Label for="{idPrefix}-short">Краткое наименование</Label>
				<Input id="{idPrefix}-short" bind:value={organization.shortName} />
			</div>
			<div class="flex flex-col gap-1.5">
				<Label for="{idPrefix}-inn">ИНН</Label>
				<Input id="{idPrefix}-inn" inputmode="numeric" bind:value={organization.inn} />
			</div>
		</div>
		<div class="flex flex-col gap-1.5">
			<Label for="{idPrefix}-legal">Полное наименование</Label>
			<Input id="{idPrefix}-legal" bind:value={organization.legalName} />
		</div>
		<div class="grid gap-3 sm:grid-cols-2">
			<div class="flex flex-col gap-1.5">
				<Label for="{idPrefix}-region">Регион</Label>
				<Input id="{idPrefix}-region" bind:value={organization.region} />
			</div>
			{#if kind === 'educational_institution'}
				<div class="flex flex-col gap-1.5">
					<Label for="{idPrefix}-level">Уровень образования</Label>
					<Select.Root
						type="single"
						bind:value={
							() => organization.educationLevel,
							(next: string) => (organization.educationLevel = isLevel(next) ? next : '')
						}
					>
						<Select.Trigger id="{idPrefix}-level" class="w-full">
							{organization.educationLevel === ''
								? 'Не указан'
								: EDUCATION_LEVEL_LABELS[organization.educationLevel]}
						</Select.Trigger>
						<Select.Content>
							{#each levelOptions as option (option.value)}
								<Select.Item value={option.value} label={option.label} />
							{/each}
						</Select.Content>
					</Select.Root>
				</div>
			{/if}
		</div>
	{/if}

	{#if error !== null}
		<p class="text-xs text-destructive" role="alert">{error}</p>
	{/if}

	<div class="flex justify-end gap-2">
		<Button type="button" variant="outline" size="sm" onclick={oncancel}>Отмена</Button>
		<Button type="button" size="sm" disabled={saving} onclick={() => void save()}>
			{#if saving}
				<LoaderIcon class="animate-spin" aria-hidden="true" />
			{/if}
			{individual ? 'Завести человека' : 'Завести организацию'}
		</Button>
	</div>
</section>
