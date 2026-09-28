<script lang="ts">
	import { untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import CalendarXIcon from '@lucide/svelte/icons/calendar-x';
	import DownloadIcon from '@lucide/svelte/icons/download';
	import MailIcon from '@lucide/svelte/icons/mail';
	import SendIcon from '@lucide/svelte/icons/send';
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
	import type { StageEntryView } from '$lib/contracts/interactions';
	import { getCardCommands, type CardCommand } from '$lib/platform/card';
	import type { CardDialogProps } from '$lib/platform/card-ui';
	import type { MeetingSendOutcome, MeetingsCardData } from '../data';

	/**
	 * Назначение встречи и приглашение участникам письмом.
	 *
	 * «Назначить и отправить приглашение» (действие модуля `meetingInvite`)
	 * сохраняет дату, длительность и место в деле и отправляет каждому
	 * участнику письмо с событием календаря: Gmail, Outlook, Apple и Яндекс
	 * показывают его приглашением с кнопками ответа. Встреча, которая ещё
	 * впереди, так переносится — участникам уходит обновление того же события.
	 * «Тест себе» — то же письмо только тому, кто нажал; встреча не сохраняется.
	 * Почтового сервера окно не ждёт: письма уходят в фоне, встреча ложится в
	 * дело, когда они ушли, а кому не ушло — скажет колокольчик.
	 *
	 * Участники — контакты основной стороны и коллеги, которые видят дело;
	 * отметка уходит идентификатором, а адрес подставляет сервер по
	 * действующему праву. Ответственный — организатор: ответы придут ему, и
	 * копию письма он получает сам.
	 *
	 * «Скачать .ics» — запасной путь без писем (почта установки закрыта или
	 * приглашение рассылают сами): встреча сохраняется (`meetingSchedule`), и
	 * следом скачивается файл `meeting.ics`. Сам пункт чек-листа отмечает
	 * человек, когда время согласовано: отправленное приглашение ещё не
	 * согласие.
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
	const contacts = $derived(loaded?.contacts ?? []);
	/** Нет права видеть людей организации: список пуст поэтому, а не потому что их нет. */
	const contactsDenied = $derived(loaded?.contactsDenied ?? false);
	const colleagues = $derived(loaded?.colleagues ?? []);
	const policy = $derived(
		loaded?.policy ?? { allowed: false, sandboxed: true, reason: 'Почта установки недоступна' }
	);
	/** Назначенная встреча дела; `null` — ещё не назначали. */
	const saved = $derived(loaded?.meeting ?? null);
	/** Новое назначение переносит встречу, которая ещё впереди. */
	const rescheduling = $derived(saved?.upcoming === true);

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
	let selectedColleagueIds = $state<string[]>([]);
	/** Что сейчас уходит на сервер — у той кнопки и надпись «Отправляем…». */
	let pending = $state<'invite' | 'test' | 'download' | 'cancel' | null>(null);
	/** Почему не ушло или не сохранилось — словами сервера, у самой формы. */
	let refusal = $state<string | null>(null);
	/** Отмена встречи ждёт подтверждения вторым нажатием. */
	let confirmingCancel = $state(false);

	// Поля заводятся чистыми при каждом открытии — тем, что нужно прямо сейчас, а
	// не тем, что осталось от прошлого раза.
	$effect(() => {
		const current = commands.current;

		untrack(() => {
			if (!isInvite(current)) {
				return;
			}

			start = saved?.upcoming === true ? saved.start : '';
			durationMinutes = saved?.upcoming === true ? saved.durationMinutes : 60;
			location = saved?.upcoming === true ? (saved.location ?? '') : '';
			agenda = defaultAgenda(entry);
			// Контактное лицо дела — участник по умолчанию, если его видно в списке.
			const preset = loaded?.defaultContactId ?? null;
			selectedContactIds =
				preset !== null && contacts.some((contact) => contact.id === preset) ? [preset] : [];
			selectedColleagueIds = [];
			pending = null;
			refusal = null;
			confirmingCancel = false;
		});
	});

	function toggle(list: string[], id: string, checked: boolean): string[] {
		return checked ? [...new Set([...list, id])] : list.filter((item) => item !== id);
	}

	const hasUnreachable = $derived(
		contacts.some(
			(contact) => selectedContactIds.includes(contact.id) && contact.unavailableReason !== null
		)
	);

	function query(name: string, value: string): string {
		return `${encodeURIComponent(name)}=${encodeURIComponent(value)}`;
	}

	/**
	 * Ссылка на файл: дату, длительность и место сервер берёт у сохранённой
	 * встречи, из формы — повестка и участники-контакты. Строка запроса собрана
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

		const params = [query('agenda', agenda)];

		for (const id of selectedContactIds) {
			params.push(query('attendee', id));
		}

		return `${path}?${params.join('&')}`;
	});

	const filled = $derived(start !== '' && durationMinutes > 0);
	const participantCount = $derived(selectedContactIds.length + selectedColleagueIds.length);
	/** Почему главная кнопка недоступна — словами у самой кнопки; `null` — доступна. */
	const inviteBlocked = $derived(
		!policy.allowed
			? 'Почта не настроена — скачайте файл приглашения и разошлите его сами'
			: interaction.ownerUserId === null
				? 'У дела нет ответственного — некому быть организатором'
				: null
	);

	function failureText(data: unknown, fallback: string): string {
		const body = (data ?? {}) as { message?: unknown; issues?: unknown };
		const issues = Array.isArray(body.issues) ? body.issues.join('; ') : '';

		return [typeof body.message === 'string' ? body.message : fallback, issues]
			.filter((part) => part !== '')
			.join(': ');
	}

	const QUEUED_TITLE: Record<'invite' | 'update' | 'cancel', string> = {
		invite: 'Приглашение отправляется',
		update: 'Обновление встречи отправляется',
		cancel: 'Встреча отменена, участникам уходит отмена'
	};

	/**
	 * Итог нажатия. Письма уходят в фоне: окно не ждёт почтового сервера и
	 * закрывается сразу; кому не ушло, скажет колокольчик.
	 */
	function report(outcome: MeetingSendOutcome) {
		if (outcome.status === 'refused') {
			if (outcome.recorded) {
				toast.warning('Встреча отменена в деле, письма об отмене не ушли', {
					description: `${outcome.error}. Предупредите участников сами.`
				});
				commands.close();
			} else {
				refusal = outcome.error;
			}

			return;
		}

		if (outcome.test) {
			toast.success('Тестовое приглашение отправляется вам на почту');

			return;
		}

		toast.success(QUEUED_TITLE[outcome.kind], {
			description:
				outcome.kind === 'cancel'
					? 'Кому отмена не уйдёт, скажет колокольчик — предупредите их сами.'
					: 'Встреча появится в деле, когда письма уйдут. Если не уйдут — скажет колокольчик.'
		});
		commands.close();
	}

	/** Отправка приглашения и отмена: исход — значение действия, а не редирект. */
	const send =
		(kind: 'invite' | 'cancel'): SubmitFunction =>
		({ submitter }) => {
			const test = kind === 'invite' && submitter?.getAttribute('value') === '1';

			pending = kind === 'cancel' ? 'cancel' : test ? 'test' : 'invite';
			refusal = null;

			return async ({ result, update }) => {
				pending = null;
				confirmingCancel = false;

				if (result.type === 'success') {
					const outcome = result.data as MeetingSendOutcome | undefined;

					if (outcome !== undefined) {
						if (!outcome.test) {
							await update();
						}

						report(outcome);
					}
				} else if (result.type === 'failure') {
					refusal = failureText(result.data, 'Приглашение не отправлено');
				} else {
					await applyAction(result);
				}
			};
		};

	/**
	 * Сохранить встречу и следом скачать приглашение: файл уходит только за
	 * сохранённой встречей, иначе в календаре участников оказалась бы встреча,
	 * которой в деле нет.
	 */
	const download: SubmitFunction = () => {
		const href = icsHref;

		refusal = null;
		pending = 'download';

		return async ({ result, update }) => {
			pending = null;

			if (result.type === 'success') {
				await update();
				commands.close();
				window.location.assign(href);
			} else if (result.type === 'failure') {
				refusal = failureText(result.data, 'Встреча не сохранена');
			} else {
				await applyAction(result);
			}
		};
	};
</script>

<FormDialog
	bind:open={opened.get, opened.set}
	title="Пригласить на встречу"
	description="Встреча сохранится в деле, участникам уйдёт письмо с приглашением в календарь: дата, место и повестка."
	width="lg"
>
	<div class="flex flex-col gap-4">
		{#if !policy.allowed}
			<InlineHint tone="warning">
				Письма не отправить: {policy.reason}. Встречу можно сохранить и скачать файл приглашения
				(.ics), чтобы разослать его самим.
			</InlineHint>
		{:else if policy.sandboxed}
			<InlineHint tone="info">
				Письма попадут в почтовую ловушку стенда (Mailpit), наружу не уйдут.
			</InlineHint>
		{/if}

		{#if rescheduling}
			<InlineHint>
				Встреча уже назначена — поля ниже показывают её. Сохранение перенесёт её: участникам уйдёт
				обновление того же события календаря, а не вторая встреча.
			</InlineHint>
		{:else if saved?.cancelled}
			<InlineHint>Прошлую встречу отменили — эта будет новой.</InlineHint>
		{/if}

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
			<p class="text-xs text-muted-foreground">
				Ссылка на видеовстречу станет в письме кнопкой «Подключиться».
			</p>
		</div>

		<div class="flex flex-col gap-1">
			<p class="text-sm font-medium">Организатор</p>
			<p class="text-sm">
				{interaction.ownerName ?? 'Ответственный не назначен'}
				<span class="text-xs text-muted-foreground">
					· ответственный за дело: участвует всегда, ответы на приглашение и копия письма придут ему
				</span>
			</p>
		</div>

		<fieldset class="flex flex-col gap-2">
			<legend class="mb-1 text-sm font-medium">Контакты вуза</legend>

			{#if contactsDenied}
				<InlineHint tone="warning">
					Контакты стороны скрыты: нет права видеть людей организации. Позвать можно коллег.
				</InlineHint>
			{:else if contacts.length === 0}
				<p class="text-xs text-muted-foreground">У стороны не заведено ни одного контакта.</p>
			{:else}
				{#each contacts as contact (contact.id)}
					<Label class="flex items-start gap-2 font-normal">
						<Checkbox
							checked={selectedContactIds.includes(contact.id)}
							onCheckedChange={(checked) =>
								(selectedContactIds = toggle(selectedContactIds, contact.id, checked === true))}
						/>
						<span class="flex flex-col gap-0.5">
							<span>
								{contact.name}{contact.position ? ` — ${contact.position}` : ''}
								{#if contact.isCaseContact}
									<span class="text-xs text-muted-foreground">· контактное лицо дела</span>
								{/if}
							</span>
							{#if contact.unavailableReason !== null}
								<span class="text-xs text-muted-foreground">
									{contact.unavailableReason} — приглашение не придёт, в событии останется имя
								</span>
							{/if}
						</span>
					</Label>
				{/each}
			{/if}

			{#if hasUnreachable}
				<InlineHint tone="warning">
					У отмеченного контакта нет открытой почты: письмо ему не уйдёт, в событии календаря он
					останется только по имени.
				</InlineHint>
			{/if}
		</fieldset>

		<fieldset class="flex flex-col gap-2">
			<legend class="mb-1 text-sm font-medium">Коллеги</legend>
			{#if colleagues.length === 0}
				<p class="text-xs text-muted-foreground">
					Дело больше никто не видит — звать из коллег некого.
				</p>
			{:else}
				{#each colleagues as colleague (colleague.userId)}
					<Label class="flex items-start gap-2 font-normal">
						<Checkbox
							checked={selectedColleagueIds.includes(colleague.userId)}
							onCheckedChange={(checked) =>
								(selectedColleagueIds = toggle(
									selectedColleagueIds,
									colleague.userId,
									checked === true
								))}
						/>
						<span>{colleague.name}</span>
					</Label>
				{/each}
				<p class="text-xs text-muted-foreground">
					В списке — сотрудники, которые видят это дело. Файл для скачивания коллег не включает.
				</p>
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

		{#if rescheduling}
			{#if confirmingCancel}
				<InlineHint tone="warning">
					<span class="flex flex-1 flex-wrap items-center justify-between gap-2">
						Отменить встречу? Приглашённым{saved !== null && saved.invitedCount > 0
							? ` (${saved.invitedCount})`
							: ''} уйдёт отмена, календари уберут событие.
						<span class="flex gap-2">
							<Button
								type="button"
								size="sm"
								variant="outline"
								onclick={() => (confirmingCancel = false)}
							>
								Не отменять
							</Button>
							<Button
								type="submit"
								size="sm"
								variant="destructive"
								form="card-meeting-cancel"
								disabled={pending !== null}
							>
								{pending === 'cancel' ? 'Отменяем…' : 'Да, отменить'}
							</Button>
						</span>
					</span>
				</InlineHint>
			{:else}
				<div>
					<Button
						type="button"
						size="sm"
						variant="outline"
						disabled={pending !== null}
						onclick={() => (confirmingCancel = true)}
					>
						<CalendarXIcon aria-hidden="true" />
						Отменить встречу
					</Button>
				</div>
			{/if}
		{/if}

		{#if refusal !== null}
			<InlineHint tone="warning">{refusal}</InlineHint>
		{/if}

		<form
			id="card-meeting-invite"
			method="POST"
			action="?/meetingInvite"
			use:enhance={send('invite')}
			class="hidden"
		>
			<input type="hidden" name="start" value={start} />
			<input type="hidden" name="duration" value={String(durationMinutes)} />
			<input type="hidden" name="location" value={location} />
			<input type="hidden" name="agenda" value={agenda} />
			{#each selectedContactIds as id (id)}
				<input type="hidden" name="contact" value={id} />
			{/each}
			{#each selectedColleagueIds as id (id)}
				<input type="hidden" name="colleague" value={id} />
			{/each}
		</form>

		<form
			id="card-meeting-schedule"
			method="POST"
			action="?/meetingSchedule"
			use:enhance={download}
			class="hidden"
		>
			<input type="hidden" name="start" value={start} />
			<input type="hidden" name="duration" value={String(durationMinutes)} />
			<input type="hidden" name="location" value={location} />
		</form>

		<form
			id="card-meeting-cancel"
			method="POST"
			action="?/meetingCancel"
			use:enhance={send('cancel')}
			class="hidden"
		></form>
	</div>

	{#snippet footer({ close })}
		<div class="flex flex-col items-end gap-2">
			<div class="flex flex-wrap justify-end gap-2">
				<Button type="button" variant="outline" onclick={close}>Закрыть</Button>
				<Button type="button" variant="outline" onclick={() => commands.open({ kind: 'result' })}>
					Записать результат стадии
				</Button>
				<Button
					type="submit"
					variant="outline"
					form="card-meeting-schedule"
					disabled={!filled || pending !== null}
					title="Сохранить встречу без писем и скачать файл для календаря"
				>
					<DownloadIcon aria-hidden="true" />
					{pending === 'download' ? 'Сохраняем…' : 'Скачать .ics'}
				</Button>
				<Button
					type="submit"
					variant="outline"
					form="card-meeting-invite"
					name="test"
					value="1"
					disabled={!filled || inviteBlocked !== null || pending !== null}
					title="Письмо только вам: так его увидят участники. Встреча не сохранится"
				>
					<MailIcon aria-hidden="true" />
					{pending === 'test' ? 'Отправляем…' : 'Тест себе'}
				</Button>
				<Button
					type="submit"
					form="card-meeting-invite"
					disabled={!filled || inviteBlocked !== null || participantCount === 0 || pending !== null}
				>
					<SendIcon aria-hidden="true" />
					{pending === 'invite'
						? 'Отправляем…'
						: rescheduling
							? 'Перенести и отправить обновление'
							: 'Назначить и отправить приглашение'}
				</Button>
			</div>
			{#if inviteBlocked !== null}
				<p class="text-xs text-muted-foreground">{inviteBlocked}</p>
			{:else if participantCount === 0}
				<p class="text-xs text-muted-foreground">
					Отметьте хотя бы одного участника: контакт вуза или коллегу.
				</p>
			{/if}
		</div>
	{/snippet}
</FormDialog>
