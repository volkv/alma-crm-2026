<script lang="ts">
	import { untrack } from 'svelte';
	import CalendarIcon from '@lucide/svelte/icons/calendar';
	import { resolve } from '$app/paths';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Checkbox } from '$lib/components/ui/checkbox/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import FormDialog from '$lib/components/form-dialog.svelte';
	import InlineHint from '$lib/components/inline-hint.svelte';
	import type { AffiliationView } from '$lib/contracts/directory';
	import type { InteractionView, StageEntryView } from '$lib/contracts/interactions';
	import { getCardCommands } from './commands.svelte';

	/**
	 * Приглашение на встречу файлом календаря.
	 *
	 * Диалог только собирает параметры — дату, длительность, место, участников и
	 * повестку — в ссылку на серверный маршрут `meeting.ics`: сам файл, права на
	 * контакты участников и запись в журнал остаются за маршрутом, диалог их не
	 * решает. Кнопка «Скачать» — обычная ссылка на файл, а не форма: так проще
	 * держать её адрес в силе, пока человек донабирает повестку.
	 *
	 * Итог встречи не заводит своей сущности: диалог только напоминает записать
	 * его командой «Результат стадии» и сам её открывает.
	 */
	let {
		interaction,
		entry,
		contacts,
		contactsDenied,
		workspaceKey
	}: {
		interaction: InteractionView;
		/** Текущая стадия; повестка по умолчанию собирается из её незакрытых пунктов. */
		entry: StageEntryView | null;
		/** Контакты основной стороны с почтой — чекбоксами в списке участников. */
		contacts: readonly AffiliationView[];
		/** Нет права видеть людей организации: список пуст поэтому, а не потому что их нет. */
		contactsDenied: boolean;
		workspaceKey: string;
	} = $props();

	const commands = getCardCommands();

	const opened = {
		get: () => commands.is('invite-meeting'),
		set: (next: boolean) => {
			if (!next) commands.close();
		}
	};

	function contactName(contact: AffiliationView): string {
		return [contact.person.lastName, contact.person.firstName, contact.person.middleName]
			.filter(Boolean)
			.join(' ');
	}

	/** Повестка по умолчанию: незакрытые пункты чек-листа текущей стадии. */
	function defaultAgenda(source: StageEntryView | null): string {
		if (source === null) {
			return '';
		}

		return source.snapshot.checklist
			.filter((item) => source.checklistState[item.key] !== true)
			.map((item) => `– ${item.label}`)
			.join('\n');
	}

	let start = $state('');
	let durationMinutes = $state(60);
	let location = $state('');
	let agenda = $state('');
	let selectedContactIds = $state<string[]>([]);

	// Поля заводятся чистыми при каждом открытии — тем, что нужно прямо сейчас, а
	// не тем, что осталось от прошлого раза.
	$effect(() => {
		const current = commands.current;

		untrack(() => {
			if (current === null || current.kind !== 'invite-meeting') {
				return;
			}

			start = '';
			durationMinutes = 60;
			location = '';
			agenda = defaultAgenda(entry);
			selectedContactIds = [];
		});
	});

	function toggleContact(id: string, checked: boolean) {
		selectedContactIds = checked
			? [...new Set([...selectedContactIds, id])]
			: selectedContactIds.filter((item) => item !== id);
	}

	const hasHiddenEmail = $derived(
		contacts.some(
			(contact) =>
				selectedContactIds.includes(contact.id) &&
				(contact.person.contactsMasked || contact.person.email === null)
		)
	);

	function query(name: string, value: string): string {
		return `${encodeURIComponent(name)}=${encodeURIComponent(value)}`;
	}

	/**
	 * Ссылка на файл собирается из набранного в форме: `Button` со ссылкой, а не
	 * форма с отправкой, — так адрес меняется вместе с полями, а закрыть диалог
	 * можно ровно тем же крестиком, что и любой другой. Строка запроса собрана
	 * вручную, а не `URLSearchParams`: здесь это одноразовое значение внутри
	 * `$derived`, а не долгоживущее изменяемое состояние.
	 */
	const icsHref = $derived.by(() => {
		const path = resolve('/(app)/w/[workspace]/interactions/[id=uuid]/meeting.ics', {
			workspace: workspaceKey,
			id: interaction.id
		});

		const params = [query('start', start), query('duration', String(durationMinutes))];

		if (location.trim() !== '') {
			params.push(query('location', location.trim()));
		}

		params.push(query('agenda', agenda));

		for (const id of selectedContactIds) {
			params.push(query('attendee', id));
		}

		return `${path}?${params.join('&')}`;
	});

	const canDownload = $derived(start !== '' && durationMinutes > 0);
</script>

<FormDialog
	bind:open={opened.get, opened.set}
	title="Пригласить на встречу"
	description="Файл приглашения для календаря (.ics): дата, место, участники и повестка."
	width="lg"
>
	<div class="flex flex-col gap-4">
		<div class="grid gap-3 sm:grid-cols-2">
			<div class="flex flex-col gap-1.5">
				<Label for="card-meeting-start">Дата и время (Москва)</Label>
				<Input id="card-meeting-start" type="datetime-local" required bind:value={start} />
			</div>
			<div class="flex flex-col gap-1.5">
				<Label for="card-meeting-duration">Длительность, минут</Label>
				<Input
					id="card-meeting-duration"
					type="number"
					min="5"
					step="5"
					required
					bind:value={durationMinutes}
				/>
			</div>
		</div>

		<div class="flex flex-col gap-1.5">
			<Label for="card-meeting-location">Место или ссылка</Label>
			<Input
				id="card-meeting-location"
				placeholder="Переговорная на 4 этаже или ссылка на видеовстречу"
				bind:value={location}
			/>
		</div>

		<fieldset class="flex flex-col gap-2">
			<legend class="mb-1 text-sm font-medium">Участники</legend>
			<Label class="flex items-start gap-2 font-normal text-muted-foreground">
				<Checkbox checked disabled />
				<span>{interaction.ownerName} — ответственный, организатор, участвует всегда</span>
			</Label>

			{#if contactsDenied}
				<InlineHint tone="warning">
					Контакты стороны скрыты: нет права видеть людей организации. В приглашение попадёт только
					ответственный.
				</InlineHint>
			{:else if contacts.length === 0}
				<p class="text-xs text-muted-foreground">У стороны не заведено ни одного контакта.</p>
			{:else}
				{#each contacts as contact (contact.id)}
					<Label class="flex items-start gap-2 font-normal">
						<Checkbox
							checked={selectedContactIds.includes(contact.id)}
							onCheckedChange={(checked) => toggleContact(contact.id, checked === true)}
						/>
						<span class="flex flex-col gap-0.5">
							<span>{contactName(contact)} — {contact.position}</span>
							<span class="text-xs text-muted-foreground">
								{#if contact.person.contactsMasked}
									Почта скрыта: в файле останется только имя
								{:else if contact.person.email}
									{contact.person.email}
								{:else}
									Почта не указана: в файле останется только имя
								{/if}
							</span>
						</span>
					</Label>
				{/each}
			{/if}

			{#if hasHiddenEmail}
				<InlineHint tone="warning">
					У выбранного участника нет открытой почты: файл назовёт его по имени, без адреса, — на
					почту приглашение ему не придёт.
				</InlineHint>
			{/if}
		</fieldset>

		<div class="flex flex-col gap-1.5">
			<Label for="card-meeting-agenda">Повестка</Label>
			<Textarea id="card-meeting-agenda" rows={5} bind:value={agenda} />
			<p class="text-xs text-muted-foreground">
				По умолчанию — незакрытые пункты чек-листа текущей стадии; можно поправить.
			</p>
		</div>

		<InlineHint>
			Отдельной сущности «итог встречи» в системе нет: после встречи запишите итог обычной командой
			«{entry?.resultText ? 'Изменить результат стадии' : 'Записать результат стадии'}».
		</InlineHint>
	</div>

	{#snippet footer({ close })}
		<div class="flex flex-wrap justify-end gap-2">
			<Button type="button" variant="outline" onclick={close}>Закрыть</Button>
			<Button type="button" variant="outline" onclick={() => commands.open({ kind: 'result' })}>
				Записать результат стадии
			</Button>
			<Button
				href={canDownload ? icsHref : undefined}
				disabled={!canDownload}
				data-sveltekit-reload
			>
				<CalendarIcon aria-hidden="true" />
				Скачать приглашение (.ics)
			</Button>
		</div>
	{/snippet}
</FormDialog>
