/**
 * Карточка отправленного результата на странице имитатора LMS: что ушло в CRM
 * и чем она ответила.
 *
 * Без неё ответ CRM пришлось бы искать в журнале стенда. Здесь только свой
 * результат, по ключу события из строки запроса: дата окончания, числа и
 * ответ — код, итог приёма и что CRM сделала со стадией, или почему не приняла.
 */
import { escapeHtml } from '../shared/state-page.ts';

/** Отправленный результат группы, как его помнит имитатор. */
export type SentResult = {
	at: string;
	eventId: string;
	/** Дата окончания обучения; `null` — промежуточный результат. */
	finishedOn: string | null;
	counters: { enrolled: number; completed: number; expelled: number };
	/** Код ответа CRM; `null` — ответа не было. */
	crmStatus: number | null;
	/** Тело ответа CRM, как пришло. */
	crmReply: unknown;
	/** Что помешало дойти до CRM, словами; `null` — ответ получен. */
	crmError: string | null;
};

/** Итог приёма словами. */
const RESULT_LABELS: Record<string, string> = {
	created: 'CRM приняла результат',
	updated: 'CRM приняла обновлённый результат',
	unchanged: 'CRM уже знает этот результат: ничего не изменилось'
};

function text(value: unknown): string {
	return escapeHtml(value === null || value === undefined ? '—' : String(value));
}

function record(value: unknown): Record<string, unknown> | null {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

/** Ответ CRM одной строкой: принято и что со стадией — или почему отказ. */
function crmAnswer(result: SentResult): string {
	if (result.crmError !== null) {
		return `<p><strong>Ошибка: результат до CRM не дошёл.</strong> ${text(result.crmError)}</p>`;
	}

	const reply = record(result.crmReply);
	const ok = result.crmStatus !== null && result.crmStatus >= 200 && result.crmStatus < 300;

	if (!ok) {
		const message = typeof reply?.message === 'string' ? `: ${reply.message}` : '';

		return `<p><strong>CRM не приняла результат</strong> (код ${text(result.crmStatus)})${text(message)}</p>`;
	}

	const outcome = typeof reply?.result === 'string' ? reply.result : null;
	const note = record(reply?.data)?.note;

	return [
		`<p><strong>Отправлено.</strong> ${text(outcome === null ? 'CRM ответила' : (RESULT_LABELS[outcome] ?? outcome))} (код ${text(result.crmStatus)}).</p>`,
		typeof note === 'string' ? `<p>Ответ CRM: ${text(note)}</p>` : ''
	].join('\n');
}

export function renderResultSpotlight(
	eventId: string,
	groupExternalId: string | null,
	result: SentResult | null
): string {
	if (result === null || groupExternalId === null) {
		return [
			'<section id="result">',
			`<h2>Результат ${text(eventId)}</h2>`,
			'<p>Имитатор такого результата не помнит: его не отправляли с этой страницы, или имитатор перезапускали.</p>',
			'</section>'
		].join('\n');
	}

	const { enrolled, completed, expelled } = result.counters;

	return [
		'<section id="result">',
		`<h2>Результат группы ${text(groupExternalId)}</h2>`,
		crmAnswer(result),
		'<ul>',
		`<li>${result.finishedOn === null ? 'Промежуточный: обучение идёт' : `Итог: обучение завершено ${text(result.finishedOn)}`}</li>`,
		`<li>Зачислено ${text(enrolled)}, завершили ${text(completed)}, отчислено ${text(expelled)}</li>`,
		`<li>Отправлен ${text(result.at)}, событие <code>${text(result.eventId)}</code></li>`,
		'</ul>',
		'<p><a href="./">Вся страница имитатора</a></p>',
		'</section>'
	].join('\n');
}
