<script lang="ts">
	import { untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import FileSignatureIcon from '@lucide/svelte/icons/file-pen-line';
	import MailIcon from '@lucide/svelte/icons/mail';
	import SendIcon from '@lucide/svelte/icons/send';
	import { invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Checkbox } from '$lib/components/ui/checkbox/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import FormDialog from '$lib/components/form-dialog.svelte';
	import InlineHint from '$lib/components/inline-hint.svelte';
	import type {
		PackageSendDraftView,
		PackageSendOutcome
	} from '$lib/contracts/document-package-send';
	import type { DocumentTemplateKey } from '$lib/contracts/documents';
	import type { OrganizationKind } from '$lib/contracts/directory';
	import type { InteractionView } from '$lib/contracts/interactions';
	import { formatBytes, formatDate, formatDateTime, pluralize } from '$lib/format';
	import { getCardCommands } from './commands.svelte';

	/**
	 * Пакет документов вузу: письмо контактным лицам основной стороны с
	 * файлами собранного пакета. Открывается командой карточки
	 * (`package-send`) — кнопкой панели «Документы» и у пункта «Пакет
	 * документов отправлен».
	 *
	 * Окно подтверждает, что именно уйдёт: файлы пакета (текущие редакции в
	 * PDF) отмечены все, лишнее снимают; получатели — контактное лицо дела по
	 * умолчанию; превью — само письмо в песочнице без скриптов.
	 *
	 * «Отправить тестовое себе» уходит на почту того, кто нажал, и в деле
	 * ничего не меняет. «Отправить контактным лицам» — каждому отмеченному своё
	 * письмо; после отправки пункт «Пакет документов отправлен» отмечается сам,
	 * в ленте появляется запись.
	 */
	let {
		interaction,
		templates,
		counterpartyKind,
		canGenerate
	}: {
		interaction: InteractionView;
		/** Шаблоны пакета дела: без собранного пакета окно ведёт к сборке. */
		templates: readonly DocumentTemplateKey[];
		counterpartyKind: OrganizationKind;
		canGenerate: boolean;
	} = $props();

	const commands = getCardCommands();
	const open = $derived(commands.is('package-send'));

	function setOpen(next: boolean) {
		if (!next) commands.close();
	}

	const url = $derived(
		resolve('/(app)/w/[workspace]/interactions/[id=uuid]/package-send', {
			workspace: page.params.workspace ?? '',
			id: interaction.id
		})
	);

	let draft = $state<PackageSendDraftView | null>(null);
	let loading = $state(false);
	let loadError = $state<string | null>(null);
	let recipients = $state<string[]>([]);
	let files = $state<string[]>([]);
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

			const next = (await response.json()) as PackageSendDraftView;

			if (current !== generation) return;

			draft = next;
			recipients = next.recipients
				.filter((recipient) => recipient.isCaseContact && recipient.available)
				.map((recipient) => recipient.affiliationId);
			files = next.documents.map((document) => document.documentId);
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
			recipients = [];
			files = [];
			refusal = null;
			sending = null;
			void load(generation);
		});

		return () => {
			generation += 1;
		};
	});

	function toggle(list: string[], id: string, checked: boolean): string[] {
		return checked ? [...new Set([...list, id])] : list.filter((item) => item !== id);
	}

	const noPackage = $derived(draft !== null && draft.documents.length === 0);
	const chosenBytes = $derived(
		(draft?.documents ?? [])
			.filter((document) => files.includes(document.documentId))
			.reduce((total, document) => total + document.sizeBytes, 0)
	);
	const tooLarge = $derived(draft !== null && chosenBytes > draft.attachmentsLimitBytes);
	/** Общий запрет обеих кнопок: письма нет, файлов нет или почта установки закрыта. */
	const blocked = $derived(
		draft === null || files.length === 0 || tooLarge || !draft.policy.allowed || sending !== null
	);

	function recipientName(id: string): string {
		return draft?.recipients.find((recipient) => recipient.affiliationId === id)?.name ?? id;
	}

	function openPackage() {
		commands.open({ kind: 'package', templates: [...templates], counterpartyKind });
	}

	async function send(test: boolean) {
		sending = test ? 'test' : 'contacts';
		refusal = null;

		try {
			const response = await fetch(url, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ recipientIds: recipients, documentIds: files, test })
			});

			if (!response.ok) {
				refusal = await failureText(response, 'Письмо не отправлено');
				return;
			}

			const outcome = (await response.json()) as PackageSendOutcome;

			if (outcome.status !== 'sent') {
				refusal = outcome.error;
				return;
			}

			if (outcome.test) {
				toast.success(`Тестовое письмо отправлено на ${draft?.sender.email ?? 'вашу почту'}`);
				return;
			}

			const sent = `Пакет документов отправлен: ${pluralize(outcome.sentCount, ['получатель', 'получателя', 'получателей'])}`;
			const marked = outcome.checklistMarked
				? 'Пункт «Пакет документов отправлен» отмечен.'
				: undefined;

			if (outcome.failed.length > 0) {
				toast.warning(sent, {
					description: [
						`Не ушло: ${outcome.failed
							.map((item) => `${recipientName(item.affiliationId)} — ${item.error}`)
							.join('; ')}`,
						marked
					]
						.filter(Boolean)
						.join(' ')
				});
			} else {
				toast.success(sent, { description: marked });
			}

			commands.close();
			await invalidateAll();
		} catch {
			refusal = 'Письмо не отправлено: нет связи с сервером';
		} finally {
			sending = null;
		}
	}
</script>

<FormDialog
	bind:open={() => open, setOpen}
	title="Отправить пакет документов"
	description="Письмо контактным лицам вуза с файлами собранного пакета. Каждому получателю — своё письмо с обращением по имени."
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

			{#if draft.lastSent !== null}
				<p class="text-xs text-muted-foreground">
					Уже отправляли {formatDateTime(draft.lastSent.sentAt)} — {pluralize(
						draft.lastSent.recipientCount,
						['получатель', 'получателя', 'получателей']
					)}, {pluralize(draft.lastSent.documentCount, ['файл', 'файла', 'файлов'])}.
				</p>
			{/if}

			<fieldset class="flex min-w-0 flex-col gap-2">
				<legend class="mb-1 text-sm font-medium">Файлы пакета</legend>
				{#if noPackage}
					<InlineHint tone="warning">
						<span class="flex flex-1 flex-wrap items-center justify-between gap-2">
							Пакет ещё не собран — отправлять нечего.
							{#if canGenerate && templates.length > 0}
								<Button size="sm" variant="outline" onclick={openPackage}>
									<FileSignatureIcon aria-hidden="true" />
									Собрать пакет документов
								</Button>
							{/if}
						</span>
					</InlineHint>
				{:else}
					{#each draft.documents as document (document.documentId)}
						<Label class="flex min-w-0 items-start gap-2 font-normal">
							<Checkbox
								checked={files.includes(document.documentId)}
								onCheckedChange={(checked) =>
									(files = toggle(files, document.documentId, checked === true))}
							/>
							<span class="flex min-w-0 flex-1 flex-col gap-0.5">
								<span class="flex min-w-0 items-baseline justify-between gap-3">
									<span class="min-w-0 truncate" title={document.fileName}>{document.title}</span>
									<span class="shrink-0 text-xs text-muted-foreground tabular-nums">
										{formatBytes(document.sizeBytes)}
									</span>
								</span>
								<span class="text-xs text-muted-foreground">
									PDF · {document.uploaded ? 'загружен' : 'собран'}
									{formatDate(document.createdAt)}
								</span>
							</span>
						</Label>
					{/each}
					<p class="text-xs text-muted-foreground">
						Отмечено {formatBytes(chosenBytes)} из {formatBytes(draft.attachmentsLimitBytes)} на письмо.
						Файлы — текущие редакции документов пакета.
					</p>
					{#if tooLarge}
						<InlineHint tone="warning">
							Отмеченные файлы весят больше, чем принимает одно письмо: снимите часть и отправьте их
							вторым письмом.
						</InlineHint>
					{/if}
				{/if}
			</fieldset>

			<fieldset class="flex min-w-0 flex-col gap-2">
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
							checked={recipients.includes(recipient.affiliationId)}
							disabled={!recipient.available}
							onCheckedChange={(checked) =>
								(recipients = toggle(recipients, recipient.affiliationId, checked === true))}
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

			<section class="flex flex-col gap-2" aria-label="Превью письма">
				<h3 class="text-sm font-medium">Письмо</h3>
				<p class="text-xs text-muted-foreground">
					Тема: {draft.subject}. {draft.previewFor === null
						? 'Обращение в превью — «Здравствуйте!»'
						: `Превью — как письмо увидит ${draft.previewFor}`}; в письме каждому получателю — его
					имя, во вложении — отмеченные файлы.
				</p>
				<!-- Песочница без разрешений: ни скриптов, ни форм, ни переходов из письма. -->
				<iframe
					title="Превью письма"
					sandbox=""
					srcdoc={draft.previewHtml}
					class="h-[24rem] w-full rounded-md border border-border bg-surface"
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
				{sending === 'test' ? 'Отправляем…' : 'Отправить тестовое себе'}
			</Button>
			<Button
				type="button"
				disabled={blocked || recipients.length === 0}
				onclick={() => send(false)}
			>
				<SendIcon aria-hidden="true" />
				{sending === 'contacts' ? 'Отправляем…' : 'Отправить контактным лицам'}
			</Button>
		</div>
	{/snippet}
</FormDialog>
