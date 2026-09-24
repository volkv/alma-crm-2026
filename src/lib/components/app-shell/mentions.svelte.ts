/*
 * Колокольчик упоминаний: состояние на весь документ.
 *
 * Колокольчиков два — в шапке страницы на широком экране и в нижней панели
 * телефона, — а спрашивать сервер и помнить ответ должен один. Перечитывается
 * он на каждом переходе между страницами (`app-shell.svelte` зовёт
 * `refresh`): своего канала у пользователя в живом потоке нет — поток открыт
 * по карточке дела, — и навигация оказывается тем моментом, когда свежее
 * число нужно. Открытая карточка отмечает свои упоминания прочитанными:
 * человек пришёл туда, куда его звали.
 *
 * На сервере состояние не меняется никогда: меняют его только обработчики
 * браузера, поэтому поделённый между запросами модуль остаётся пустым — то же
 * соглашение, что у палитры поиска (`search.svelte.ts`).
 */
import { resolve } from '$app/paths';
import {
	mentionInboxSchema,
	type MarkMentionsReadInput,
	type MentionInbox
} from '$lib/contracts/mentions';

let inbox = $state<MentionInbox | null>(null);
let failure = $state<string | null>(null);
let issued = 0;

const CARD_PATH = /^\/w\/[^/]+\/interactions\/([0-9a-f-]{36})(?:\/|$)/i;

async function refusal(response: Response): Promise<string> {
	const body: unknown = await response.json().catch(() => null);

	return typeof body === 'object' && body !== null && 'error' in body
		? String(body.error)
		: `Сервер ответил ${response.status}`;
}

async function post(input: MarkMentionsReadInput): Promise<void> {
	const response = await fetch(resolve('/(app)/mentions'), {
		method: 'POST',
		headers: { 'content-type': 'application/json', accept: 'application/json' },
		body: JSON.stringify(input)
	});

	if (!response.ok) {
		throw new Error(await refusal(response));
	}
}

async function load(): Promise<void> {
	const token = ++issued;
	const response = await fetch(resolve('/(app)/mentions'), {
		headers: { accept: 'application/json' }
	});

	if (!response.ok) {
		throw new Error(await refusal(response));
	}

	const next = mentionInboxSchema.parse(await response.json());

	// Ответ ложится, только если его ещё ждут: два быстрых перехода подряд не
	// должны вернуть число первого поверх второго.
	if (token === issued) {
		inbox = next;
		failure = null;
	}
}

/** Сделать и перечитать; сбой — словами под колокольчиком, а не пустым списком. */
async function run(step: () => Promise<void>): Promise<void> {
	try {
		await step();
		await load();
	} catch (error) {
		failure =
			error instanceof Error
				? `Упоминания не загрузились: ${error.message}`
				: 'Упоминания не загрузились. Проверьте связь.';
	}
}

export const mentions = {
	get inbox(): MentionInbox | null {
		return inbox;
	},
	get failure(): string | null {
		return failure;
	},
	get unread(): number {
		return inbox?.unread ?? 0;
	},
	/**
	 * Перечитать после перехода. Если открыта карточка дела — сначала отметить
	 * его упоминания прочитанными.
	 */
	refresh(pathname: string): Promise<void> {
		const card = CARD_PATH.exec(pathname);

		return run(async () => {
			if (card !== null) {
				await post({ scope: 'interaction', interactionId: card[1].toLowerCase() });
			}
		});
	},
	markRead(mentionId: string): Promise<void> {
		return run(() => post({ scope: 'mention', mentionId }));
	},
	markAllRead(): Promise<void> {
		return run(() => post({ scope: 'all' }));
	}
};
