/**
 * Журнал имитатора: последние N сообщений в памяти.
 *
 * Кольцом, а не растущим списком: имитатор живёт на стенде неделями, а нужны
 * от него последние два десятка строк — по ним видно, что пришло, что ушло и
 * чем ответили. Ничего не переживает перезапуск намеренно: история обмена, за
 * которую кто-то отвечает, лежит в CRM, а здесь — только след стенда.
 */

/** Одна строка журнала: входящее сообщение или наш исходящий запрос. */
export type JournalEntry = {
	/** Момент записи, ISO 8601. */
	at: string;
	direction: 'inbound' | 'outbound';
	/** Что это было: метод и путь у входящего, метод и адрес у исходящего. */
	summary: string;
	/** Код ответа; `null` — ответа не было вовсе (разрыв связи, таймаут). */
	status: number | null;
	eventId: string | null;
	eventType: string | null;
	/** Что случилось словами: отказ, повтор, разъяснение. */
	note: string | null;
	/** Тело сообщения целиком — как пришло или как ушло. */
	payload: unknown;
};

export type Journal = {
	add: (entry: Omit<JournalEntry, 'at'> & { at?: string }) => void;
	/** Записи от новых к старым: экран состояния читается сверху. */
	list: () => JournalEntry[];
	clear: () => void;
};

/** Сколько строк помним, если не сказано иное. */
export const DEFAULT_JOURNAL_SIZE = 100;

export function createJournal(size: number = DEFAULT_JOURNAL_SIZE): Journal {
	if (!Number.isInteger(size) || size < 1) {
		throw new RangeError(`Размер журнала — целое число от единицы, получено ${size}`);
	}

	const entries: JournalEntry[] = [];

	return {
		add(entry) {
			entries.push({ ...entry, at: entry.at ?? new Date().toISOString() });

			if (entries.length > size) {
				entries.splice(0, entries.length - size);
			}
		},
		list() {
			return [...entries].reverse();
		},
		clear() {
			entries.length = 0;
		}
	};
}
