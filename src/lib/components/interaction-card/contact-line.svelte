<script lang="ts">
	import MailIcon from '@lucide/svelte/icons/mail';
	import PhoneIcon from '@lucide/svelte/icons/phone';
	import type { InteractionPartyView } from '$lib/contracts/interactions';

	/**
	 * Контактное лицо стороны: имя, должность и способы связи. Контакты
	 * маскирует сервер по праву на персональные данные — здесь это сказано
	 * словами, а не пустым местом.
	 *
	 * Почта и телефон — данные, которые читают и переписывают, поэтому они
	 * набраны основным цветом со значком, а ссылкой их выдаёт подчёркивание
	 * при наведении: фиолетовая пара строк спорила с настоящими ссылками
	 * карточки.
	 */
	let { party }: { party: InteractionPartyView } = $props();

	const person = $derived(party.contact);
	const fullName = $derived(
		person === null
			? null
			: [person.lastName, person.firstName, person.middleName].filter(Boolean).join(' ')
	);
</script>

{#if person === null}
	<p class="text-sm text-muted-foreground">Контактное лицо не указано</p>
{:else}
	<div class="flex min-w-0 flex-col gap-0.5 text-sm">
		<p class="font-medium break-words">{fullName}</p>
		{#if party.contactPosition}
			<p class="text-muted-foreground">{party.contactPosition}</p>
		{/if}
		{#if person.contactsMasked}
			<p class="text-xs text-faint">Контакты скрыты: нет права на персональные данные</p>
		{:else}
			{#if person.email}
				<a
					class="inline-flex w-fit max-w-full items-center gap-1.5 rounded-sm text-foreground underline-offset-2 focus-ring hover:underline"
					href="mailto:{person.email}"
				>
					<MailIcon class="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
					<span class="truncate">{person.email}</span>
				</a>
			{/if}
			{#if person.phone}
				<a
					class="inline-flex w-fit items-center gap-1.5 rounded-sm text-foreground tabular-nums underline-offset-2 focus-ring hover:underline"
					href="tel:{person.phone}"
				>
					<PhoneIcon class="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
					{person.phone}
				</a>
			{/if}
		{/if}
	</div>
{/if}
