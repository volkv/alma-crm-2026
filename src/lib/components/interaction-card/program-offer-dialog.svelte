<script lang="ts">
	import { untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import MailIcon from '@lucide/svelte/icons/mail';
	import SendIcon from '@lucide/svelte/icons/send';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Checkbox } from '$lib/components/ui/checkbox/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import FormDialog from '$lib/components/form-dialog.svelte';
	import InlineHint from '$lib/components/inline-hint.svelte';
	import type { InteractionView } from '$lib/contracts/interactions';
	import type { ProgramOfferDraftView, ProgramOfferOutcome } from '$lib/contracts/program-offer';
	import { formatBytes, formatDateTime, pluralize } from '$lib/format';
	import { getCardCommands } from './commands.svelte';

	/**
	 * Описание программ вузу в один клик: письмо контактным лицам основной
	 * стороны с программами и продуктами дела и материалами программ во
	 * вложении. Открывается командой карточки (`program-offer`) — кнопкой
	 * панели «Программы и продукты» и у пункта «Отправлено описание программ».
	 *
	 * Всё, что показывает окно, сервер собирает при каждом открытии: контакты
	 * могли завести минуту назад, материалы — приложить к программе. Адресов
	 * окно не видит и не присылает: получатели — имена и должности, отметка
	 * уходит идентификатором роли, а почту подставляет сервер. Превью — то самое
	 * письмо, в песочнице без скриптов.
	 *
	 * «Тестовое письмо себе» уходит на почту того, кто нажал, и в деле ничего не
	 * меняет. «Отправить контактам» — каждому отмеченному своё письмо. Почтового
	 * сервера окно не ждёт: письма встают в очередь и уходят в фоне, окно сразу
	 * закрывается. Когда письма уйдут, в ленте появится запись, а пункт
	 * чек-листа закроется сам — живая карточка перечитается; не ушло — строка в
	 * колокольчике.
	 */
	let {
		interaction,
		canCompose
	}: {
		interaction: InteractionView;
		/** На странице есть диалог состава: без программ окно ведёт туда. */
		canCompose: boolean;
	} = $props();

	const commands = getCardCommands();
	const open = $derived(commands.is('program-offer'));

	function setOpen(next: boolean) {
		if (!next) commands.close();
	}

	const url = $derived(
		resolve('/(app)/w/[workspace]/interactions/[id=uuid]/program-offer', {
			workspace: page.params.workspace ?? '',
			id: interaction.id
		})
	);

	let draft = $state<ProgramOfferDraftView | null>(null);
	let loading = $state(false);
	let loadError = $state<string | null>(null);
	let selected = $state<string[]>([]);
	let sending = $state<'test' | 'contacts' | null>(null);
	/** Почему письмо не ушло — словами сервера, у самих кнопок. */
	let refusal = $state<string | null>(null);
	/** Номер открытия: ответ, пришедший после закрытия окна, не должен лечь в новое. */
	let generation = 0;

	type Failure = { error?: string; issues?: string[] };

	async function failureText(response: Response, fallback: string): Promise<string> {
		const body: Failure = await response.json().catch(() => ({}));

		return [body.error ?? fallback, ...(body.issues ?? [])].join(': ');
	}

	async function load(current: number) {
		loading = true;
		loadError = null;

		try {
			const response = await fetch(url);

			if (current !== generation) return;

			if (!response.ok) {
				loadError = await failureText(response, 'Не удалось собрать письмо');
				return;
			}

			const next = (await response.json()) as ProgramOfferDraftView;

			if (current !== generation) return;

			draft = next;
			// Контактное лицо дела отмечено сразу, если ему можно написать.
			selected = next.recipients
				.filter((recipient) => recipient.isCaseContact && recipient.available)
				.map((recipient) => recipient.affiliationId);
		} catch {
			if (current === generation) loadError = 'Не удалось собрать письмо: нет связи с сервером';
		} finally {
			if (current === generation) loading = false;
		}
	}

	$effect(() => {
		if (!open) return;

		untrack(() => {
			generation += 1;
			draft = null;
			selected = [];
			refusal = null;
			sending = null;
			void load(generation);
		});

		return () => {
			generation += 1;
		};
	});

	function toggle(id: string, checked: boolean) {
		selected = checked ? [...new Set([...selected, id])] : selected.filter((item) => item !== id);
	}

	const noPrograms = $derived(interaction.programs.length === 0);
	const tooLarge = $derived(draft !== null && draft.attachmentsBytes > draft.attachmentsLimitBytes);
	/** Общий запрет обеих кнопок: письма нет или почта установки закрыта. */
	const blocked = $derived(
		draft === null || noPrograms || tooLarge || !draft.policy.allowed || sending !== null
	);

	async function send(test: boolean) {
		sending = test ? 'test' : 'contacts';
		refusal = null;

		try {
			const response = await fetch(url, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				// У тестового — чьё обращение показать: так же, как в превью.
				body: JSON.stringify({ recipientIds: selected, test })
			});

			if (!response.ok) {
				refusal = await failureText(response, 'Письмо не отправлено');
				return;
			}

			const outcome = (await response.json()) as ProgramOfferOutcome;

			if (outcome.status !== 'queued') {
				refusal = outcome.error;
				return;
			}

			if (outcome.test) {
				// Окно остаётся открытым: после теста обычно отправляют по-настоящему.
				toast.success(`Тестовое письмо отправляется на ${draft?.sender.email ?? 'вашу почту'}`);
				return;
			}

			toast.success(
				`Описание программ отправляется: ${pluralize(selected.length, ['получатель', 'получателя', 'получателей'])}`,
				{ description: 'Появится в ленте, когда уйдёт. Если не уйдёт — скажет колокольчик.' }
			);
			commands.close();
		} catch {
			refusal = 'Письмо не отправлено: нет связи с сервером';
		} finally {
			sending = null;
		}
	}
</script>

<FormDialog
	bind:open={() => open, setOpen}
	title="Отправить описание программ"
	description="Письмо контактным лицам вуза: программы и продукты дела, материалы программ во вложении. Каждому получателю — своё письмо с обращением по имени."
	width="xl"
>
	<div class="flex flex-col gap-4">
		{#if loading && draft === null}
			<p class="text-sm text-muted-foreground">Собираем письмо…</p>
		{:else if loadError !== null}
			<InlineHint tone="warning">{loadError}</InlineHint>
		{:else if draft !== null}
			{#if !draft.policy.allowed}
				<InlineHint tone="warning">{draft.policy.reason}</InlineHint>
			{:else if draft.policy.sandboxed}
				<InlineHint tone="info">
					Письмо попадёт в почтовую ловушку стенда (Mailpit), наружу не уйдёт.
				</InlineHint>
			{/if}

			{#if noPrograms}
				<InlineHint tone="warning">
					<span class="flex flex-1 flex-wrap items-center justify-between gap-2">
						В деле нет программ — описывать нечего.
						{#if canCompose}
							<Button
								size="sm"
								variant="outline"
								onclick={() => commands.openComposition('offering')}
							>
								Выбрать программы
							</Button>
						{/if}
					</span>
				</InlineHint>
			{/if}

			{#if draft.lastSent !== null}
				<p class="text-xs text-muted-foreground">
					Уже отправляли {formatDateTime(draft.lastSent.sentAt)} — {pluralize(
						draft.lastSent.recipientCount,
						['получатель', 'получателя', 'получателей']
					)}.
				</p>
			{/if}
			{#if draft.inFlight !== null}
				<p class="text-xs text-muted-foreground">
					Предыдущее описание ещё отправляется — поставлено {formatDateTime(
						draft.inFlight.queuedAt
					)}.
				</p>
			{/if}

			<fieldset class="flex flex-col gap-2">
				<legend class="mb-1 text-sm font-medium">Получатели</legend>
				{#if draft.recipientsNotice !== null}
					<InlineHint tone="warning">{draft.recipientsNotice}</InlineHint>
				{/if}
				{#each draft.recipients as recipient (recipient.affiliationId)}
					<Label
						class="flex items-start gap-2 font-normal {recipient.available
							? ''
							: 'text-muted-foreground'}"
					>
						<Checkbox
							checked={selected.includes(recipient.affiliationId)}
							disabled={!recipient.available}
							onCheckedChange={(checked) => toggle(recipient.affiliationId, checked === true)}
						/>
						<span class="flex flex-col gap-0.5">
							<span>
								{recipient.name}{recipient.position ? ` — ${recipient.position}` : ''}
								{#if recipient.isCaseContact}
									<span class="text-xs text-muted-foreground">· контактное лицо дела</span>
								{/if}
							</span>
							{#if recipient.unavailableReason !== null}
								<span class="text-xs">{recipient.unavailableReason}</span>
							{/if}
						</span>
					</Label>
				{/each}
			</fieldset>

			<section class="flex flex-col gap-2" aria-label="Вложения">
				<h3 class="text-sm font-medium">Вложения</h3>
				{#if draft.attachments.length === 0}
					<p class="text-xs text-muted-foreground">
						У программ дела нет материалов — письмо уйдёт только текстом. Материалы прикладывают на
						карточке программы.
					</p>
				{:else}
					<ul class="flex flex-col gap-1 text-sm">
						{#each draft.attachments as attachment (attachment.documentId)}
							<li class="flex min-w-0 items-baseline justify-between gap-3">
								<span class="min-w-0 truncate" title={attachment.fileName}>
									{attachment.fileName}
									<span class="text-xs text-muted-foreground">· {attachment.programName}</span>
								</span>
								<span class="shrink-0 text-xs text-muted-foreground tabular-nums">
									{formatBytes(attachment.sizeBytes)}
								</span>
							</li>
						{/each}
					</ul>
					<p class="text-xs text-muted-foreground">
						Всего {formatBytes(draft.attachmentsBytes)} из {formatBytes(
							draft.attachmentsLimitBytes
						)}
						на письмо.
					</p>
				{/if}
				{#if tooLarge}
					<InlineHint tone="warning">
						Материалы весят {formatBytes(draft.attachmentsBytes)} — больше, чем принимает одно письмо
						({formatBytes(draft.attachmentsLimitBytes)}). Уберите часть материалов с карточек
						программ.
					</InlineHint>
				{/if}
			</section>

			<section class="flex flex-col gap-2" aria-label="Превью письма">
				<h3 class="text-sm font-medium">Письмо</h3>
				<p class="text-xs text-muted-foreground">
					Тема: {draft.subject}. {draft.previewFor === null
						? 'Обращение в превью — «Здравствуйте!»'
						: `Превью — как письмо увидит ${draft.previewFor}`}; в письме каждому получателю — его
					имя.
				</p>
				<!-- Песочница без разрешений: ни скриптов, ни форм, ни переходов из письма. -->
				<iframe
					title="Превью письма"
					sandbox=""
					srcdoc={draft.previewHtml}
					class="h-[28rem] w-full rounded-md border border-border bg-surface"
				></iframe>
			</section>

			{#if refusal !== null}
				<InlineHint tone="warning">{refusal}</InlineHint>
			{/if}
		{/if}
	</div>

	{#snippet footer({ close })}
		<div class="flex flex-wrap justify-end gap-2">
			<Button type="button" variant="outline" onclick={close}>Закрыть</Button>
			<Button
				type="button"
				variant="outline"
				disabled={blocked}
				title={draft === null ? undefined : `На ${draft.sender.email}`}
				onclick={() => send(true)}
			>
				<MailIcon aria-hidden="true" />
				{sending === 'test' ? 'Отправляем…' : 'Тестовое письмо себе'}
			</Button>
			<Button type="button" disabled={blocked || selected.length === 0} onclick={() => send(false)}>
				<SendIcon aria-hidden="true" />
				{sending === 'contacts' ? 'Отправляем…' : 'Отправить контактам'}
			</Button>
		</div>
	{/snippet}
</FormDialog>
