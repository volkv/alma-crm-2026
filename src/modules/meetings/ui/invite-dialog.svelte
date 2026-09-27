<script lang="ts">
	import { untrack } from 'svelte';
	import CalendarIcon from '@lucide/svelte/icons/calendar';
	import type { SubmitFunction } from '@sveltejs/kit';
	import { applyAction, enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Checkbox } from '$lib/components/ui/checkbox/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import FormDialog from '$lib/components/form-dialog.svelte';
	import InlineHint from '$lib/components/inline-hint.svelte';
	import type { AffiliationView } from '$lib/contracts/directory';
	import type { StageEntryView } from '$lib/contracts/interactions';
	import { getCardCommands, type CardCommand } from '$lib/platform/card';
	import type { CardDialogProps } from '$lib/platform/card-ui';
	import type { MeetingsCardData } from '../data';

	/**
	 * Назначение встречи и приглашение файлом календаря.
	 *
	 * «Назначить» делает две вещи по очереди: сохраняет дату, длительность и
	 * место в деле (действие модуля `meetingSchedule`) — встреча видна в ленте и
	 * у пункта «Встреча назначена», — а затем скачивает файл приглашения
	 * `meeting.ics` (`card.server.ts`) с участниками и повесткой. Файл, права на
	 * контакты участников и запись в журнал остаются за сервером, диалог их не
	 * решает. Сам пункт чек-листа отмечает человек, когда время согласовано:
	 * отправленное приглашение ещё не согласие.
	 *
	 * Итог встречи не заводит своей сущности: диалог напоминает записать его
	 * командой «Результат стадии» и сам её открывает.
	 */
	let { source, data, workspaceKey }: CardDialogProps = $props();

	const interaction = $derived(source.interaction);
	/** Текущая стадия; повестка по умолчанию собирается из её незакрытых пунктов. */
	const entry = $derived(source.status.current);
	// Данные кладёт `load` модуля (`card.server.ts`): пока модуль действует, он
	// зовётся на каждой загрузке карточки.
	const loaded = $derived(data as MeetingsCardData | undefined);
	/** Контакты основной стороны с почтой — чекбоксами в списке участников. */
	const contacts = $derived(loaded?.contacts ?? []);
	/** Нет права видеть людей организации: список пуст поэтому, а не потому что их нет. */
	const contactsDenied = $derived(loaded?.contactsDenied ?? false);

	const commands = getCardCommands();

	/** Своя команда — действие «Пригласить» модуля «Встречи» из манифеста. */
	function isInvite(command: CardCommand | null): boolean {
		return (
			command?.kind === 'module' && command.module === 'meetings' && command.action === 'invite'
		);
	}

	const opened = {
		get: () => isInvite(commands.current),
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
	function defaultAgenda(stage: StageEntryView | null): string {
		if (stage === null) {
			return '';
		}

		// Пункт-факт закрывают данные дела, ручной — отметка: в повестку идёт
		// то, что не закрыто ни тем, ни другим.
		return stage.snapshot.checklist
			.filter(
				(item) => stage.checklistState[item.key] !== true && stage.facts[item.key]?.done !== true
			)
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
			if (!isInvite(current)) {
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
		const path = resolve('/(app)/w/[workspace]/interactions/[id=uuid]/files/[module]/[file]', {
			workspace: workspaceKey,
			id: interaction.id,
			module: 'meetings',
			file: 'meeting.ics'
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

	/** Почему встречу не сохранили — словами сервера, у самой формы. */
	let refusal = $state<string | null>(null);
	let saving = $state(false);

	/**
	 * Сохранить встречу и следом скачать приглашение: файл уходит только за
	 * сохранённой встречей, иначе в календаре участников оказалась бы встреча,
	 * которой в деле нет.
	 */
	const schedule: SubmitFunction = () => {
		const href = icsHref;

		refusal = null;
		saving = true;

		return async ({ result, update }) => {
			saving = false;

			if (result.type === 'success') {
				await update();
				commands.close();
				window.location.assign(href);
			} else if (result.type === 'failure') {
				const data = (result.data ?? {}) as { message?: unknown; issues?: unknown };
				const issues = Array.isArray(data.issues) ? data.issues.join('; ') : '';

				refusal = [typeof data.message === 'string' ? data.message : 'Встреча не сохранена', issues]
					.filter((part) => part !== '')
					.join(': ');
			} else {
				await applyAction(result);
			}
		};
	};
</script>

<FormDialog
	bind:open={opened.get, opened.set}
	title="Пригласить на встречу"
	description="Встреча сохранится в деле, участникам — файл для календаря (.ics) с датой, местом и повесткой."
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

		{#if refusal !== null}
			<InlineHint tone="warning">{refusal}</InlineHint>
		{/if}

		<form
			id="card-meeting-schedule"
			method="POST"
			action="?/meetingSchedule"
			use:enhance={schedule}
			class="hidden"
		>
			<input type="hidden" name="start" value={start} />
			<input type="hidden" name="duration" value={String(durationMinutes)} />
			<input type="hidden" name="location" value={location} />
		</form>
	</div>

	{#snippet footer({ close })}
		<div class="flex flex-wrap justify-end gap-2">
			<Button type="button" variant="outline" onclick={close}>Закрыть</Button>
			<Button type="button" variant="outline" onclick={() => commands.open({ kind: 'result' })}>
				Записать результат стадии
			</Button>
			<Button type="submit" form="card-meeting-schedule" disabled={!canDownload || saving}>
				<CalendarIcon aria-hidden="true" />
				Назначить и скачать приглашение (.ics)
			</Button>
		</div>
	{/snippet}
</FormDialog>
