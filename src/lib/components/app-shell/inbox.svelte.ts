/*
 * Колокольчик — упоминания и новые дела с сайта: состояние на весь документ.
 *
 * Колокольчиков два — в шапке страницы на широком экране и в нижней панели
 * телефона, — а спрашивать сервер и помнить ответ должен один. Перечитывается
 * он на каждом переходе между страницами (`app-shell.svelte` зовёт
 * `refresh`): своего канала у пользователя в живом потоке нет — поток открыт
 * по карточке дела, — и навигация оказывается тем моментом, когда свежее
 * число нужно. Открытая карточка отмечает свои строки прочитанными:
 * человек пришёл туда, куда его звали.
 *
 * На сервере состояние не меняется никогда: меняют его только обработчики
 * браузера, поэтому поделённый между запросами модуль остаётся пустым — то же
 * соглашение, что у палитры поиска (`search.svelte.ts`).
 */
import { resolve } from '$app/paths';
import {
	inboxSchema,
	type Inbox,
	type InboxItem,
	type MarkInboxReadInput
} from '$lib/contracts/inbox';

let loaded = $state<Inbox | null>(null);
let failure = $state<string | null>(null);
let issued = 0;

const CARD_PATH = /^\/w\/[^/]+\/interactions\/([0-9a-f-]{36})(?:\/|$)/i;

async function refusal(response: Response): Promise<string> {
	const body: unknown = await response.json().catch(() => null);

	return typeof body === 'object' && body !== null && 'error' in body
		? String(body.error)
		: `Сервер ответил ${response.status}`;
}

async function post(input: MarkInboxReadInput): Promise<void> {
	const response = await fetch(resolve('/(app)/inbox'), {
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
	const response = await fetch(resolve('/(app)/inbox'), {
		headers: { accept: 'application/json' }
	});

	if (!response.ok) {
		throw new Error(await refusal(response));
	}

	const next = inboxSchema.parse(await response.json());

	// Ответ ложится, только если его ещё ждут: два быстрых перехода подряд не
	// должны вернуть число первого поверх второго.
	if (token === issued) {
		loaded = next;
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
				? `Уведомления не загрузились: ${error.message}`
				: 'Уведомления не загрузились. Проверьте связь.';
	}
}

export const inbox = {
	get current(): Inbox | null {
		return loaded;
	},
	get failure(): string | null {
		return failure;
	},
	get unread(): number {
		return loaded?.unread ?? 0;
	},
	/**
	 * Перечитать после перехода. Если открыта карточка дела — сначала отметить
	 * его строки прочитанными.
	 */
	refresh(pathname: string): Promise<void> {
		const card = CARD_PATH.exec(pathname);

		return run(async () => {
			if (card !== null) {
				await post({ scope: 'interaction', interactionId: card[1].toLowerCase() });
			}
		});
	},
	markRead(item: InboxItem): Promise<void> {
		return run(() => post({ scope: item.kind, id: item.id }));
	},
	markAllRead(): Promise<void> {
		return run(() => post({ scope: 'all' }));
	}
};
