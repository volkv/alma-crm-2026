/**
 * Единственная страница имитатора: то же, что отдаёт `GET /__state`, таблицей,
 * и кнопки, которыми запускают сцену обмена.
 *
 * Без стилей намеренно (`docs/exchange-contract.md`, раздел 9): это окно в
 * состояние стенда, а не мини-продукт. Формы — обычные `<form method="post">`
 * без единой строки скрипта, и адреса у них относительные: на стенде имитатор
 * живёт под префиксом пути (`/mock-cms/`), а на машине разработчика — в корне
 * своего порта, и абсолютный путь верен ровно в одном из двух случаев.
 *
 * Всё, что здесь показано, читается и машиной: страница ничего не знает сверх
 * того, что есть в состоянии сервиса.
 */
import type { JournalEntry } from './journal.ts';
import type { ScenarioState } from './scenario.ts';

/** Поле формы-триггера: строка или выбор из готовых значений. */
export type TriggerField = {
	name: string;
	label: string;
	/** Варианты выбора; пусто — обычное текстовое поле. */
	options?: readonly string[];
	/** Что значит незаполненное поле. */
	hint?: string;
};

/** Кнопка страницы состояния: форма, которая жмёт триггер имитатора. */
export type TriggerForm = {
	/** Путь триггера относительно страницы: `__send-application`. */
	action: string;
	title: string;
	description: string;
	fields: readonly TriggerField[];
	submit: string;
};

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

function field(input: TriggerField): string {
	const label = escapeHtml(input.label);
	const name = escapeHtml(input.name);
	const hint = input.hint === undefined ? '' : ` <small>${escapeHtml(input.hint)}</small>`;

	if (input.options === undefined) {
		return `<p><label>${label} <input type="text" name="${name}"></label>${hint}</p>`;
	}

	const options = input.options
		.map((option) => `<option value="${escapeHtml(option)}">${escapeHtml(option)}</option>`)
		.join('');

	return `<p><label>${label} <select name="${name}">${options}</select></label>${hint}</p>`;
}

function triggerForm(form: TriggerForm): string {
	return [
		`<form method="post" action="${escapeHtml(form.action)}">`,
		`<h3>${escapeHtml(form.title)}</h3>`,
		`<p>${escapeHtml(form.description)}</p>`,
		form.fields.map(field).join('\n'),
		`<p><button type="submit">${escapeHtml(form.submit)}</button></p>`,
		'</form>'
	].join('\n');
}

export function renderStatePage(state: {
	name: string;
	title: string;
	scenario: ScenarioState;
	/** Что сервис знает о своих объектах: заявки у CMS, группы у LMS. */
	objects: unknown;
	journal: JournalEntry[];
	forms: readonly TriggerForm[];
	/** Закрыты ли управляющие адреса токеном: на стенде это видно сразу. */
	controlProtected: boolean;
}): string {
	const rows = state.journal.map(journalRow).join('\n');
	const forms = state.forms.map(triggerForm).join('\n');
	const control = state.controlProtected
		? 'Управляющие адреса (<code>__state</code>, <code>__scenario</code>) закрыты токеном.'
		: 'Управляющие адреса (<code>__state</code>, <code>__scenario</code>) открыты: имитатор рассчитан на локальный запуск.';

	return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>${escapeHtml(state.title)}</title>
</head>
<body>
<h1>${escapeHtml(state.title)}</h1>
<p>Имитатор стенда, а не настоящая система: обмен с ним ничего не доказывает о работе с системой заказчика.</p>
<p>${control}</p>
<h2>Запустить сцену</h2>
${forms}
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
