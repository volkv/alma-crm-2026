/**
 * Единственная страница имитатора: то же, что отдаёт `GET /__state`, таблицей.
 *
 * Без стилей и без форм намеренно (`docs/exchange-contract.md`, раздел 9): это
 * окно в состояние стенда, а не мини-продукт. Всё, что здесь показано, читается
 * и машиной — страница ничего не знает сверх того, что есть в JSON.
 */
import type { JournalEntry } from './journal.ts';
import type { ScenarioState } from './scenario.ts';

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

function cell(value: string | number | null): string {
	return `<td>${value === null ? '—' : escapeHtml(String(value))}</td>`;
}

function journalRow(entry: JournalEntry): string {
	return [
		'<tr>',
		cell(entry.at),
		cell(entry.direction === 'inbound' ? 'входящее' : 'исходящее'),
		cell(entry.summary),
		cell(entry.status),
		cell(entry.eventType),
		cell(entry.eventId),
		cell(entry.note),
		'</tr>'
	].join('');
}

export function renderStatePage(state: {
	name: string;
	title: string;
	scenario: ScenarioState;
	/** Что сервис знает о своих объектах: заявки у CMS, группы у LMS. */
	objects: unknown;
	journal: JournalEntry[];
}): string {
	const rows = state.journal.map(journalRow).join('\n');

	return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>${escapeHtml(state.title)}</title>
</head>
<body>
<h1>${escapeHtml(state.title)}</h1>
<p>Имитатор стенда, а не настоящая система: обмен с ним ничего не доказывает о работе с системой заказчика.</p>
<h2>Сценарий</h2>
<pre>${escapeHtml(JSON.stringify(state.scenario, null, 2))}</pre>
<h2>Что известно сервису</h2>
<pre>${escapeHtml(JSON.stringify(state.objects, null, 2))}</pre>
<h2>Журнал обмена (последние ${state.journal.length})</h2>
<table border="1" cellpadding="4">
<thead>
<tr><th>Момент</th><th>Направление</th><th>Что</th><th>Код</th><th>Событие</th><th>eventId</th><th>Примечание</th></tr>
</thead>
<tbody>
${rows}
</tbody>
</table>
</body>
</html>
`;
}
