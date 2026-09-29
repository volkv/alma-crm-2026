/**
 * Единственная страница имитатора: что сервис знает о своих объектах, кнопки,
 * которыми запускают сцену обмена, и под «Техническими подробностями» — то же,
 * что отдаёт `GET /__state`.
 *
 * Страницу показывают зрителю стенда, поэтому она оформлена как кабинет чужой
 * системы и с первого взгляда помечена демо-имитатором. Оформление — встроенный
 * CSS без внешних файлов и шрифтов: стенд работает в закрытом контуре. Формы —
 * обычные `<form method="post">` без единой строки скрипта, и адреса у них
 * относительные: на стенде имитатор живёт под префиксом пути (`/mock-cms/`), а
 * на машине разработчика — в корне своего порта, и абсолютный путь верен ровно
 * в одном из двух случаев.
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

export function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

/**
 * Оформление страниц имитатора: светлая тема в палитре ДС продукта (нейтральная
 * шкала, фиолетовый статусный цвет), системная гарнитура, если фирменной на
 * машине нет. Классы общие для страницы состояния, карточек результата и
 * страницы отказа триггера.
 */
export const PAGE_STYLE = `<style>
:root {
	--bg: #f4f4f5; --surface: #fff; --surface-2: #f9f9fa; --border: #e8e8ee; --border-strong: #b5b7c0;
	--fg: #101828; --muted: #434b5a; --faint: #585d69;
	--accent: #7700ff; --accent-strong: #6500d9; --accent-soft: #f1e6ff; --accent-on: #fff;
	--ok: #00782f; --ok-soft: #e6f7ec; --err: #b31b1b; --err-soft: #ffe9e9; --warn: #8a5a00; --warn-soft: #fff6e7;
	--radius: 12px;
	color-scheme: light;
}
* { box-sizing: border-box; }
body {
	margin: 0; background: var(--bg); color: var(--fg);
	font: 15px/1.5 'Rostelecom Basis', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'Noto Sans', sans-serif;
}
a { color: var(--accent); }
code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px; }
.top { background: var(--surface); border-bottom: 1px solid var(--border); }
.top-inner { max-width: 1120px; margin: 0 auto; padding: 20px 24px; display: flex; gap: 16px; align-items: flex-start; }
.mark {
	flex: none; width: 48px; height: 48px; border-radius: 12px; background: var(--accent); color: var(--accent-on);
	display: grid; place-items: center; font-weight: 700; font-size: 14px; letter-spacing: .04em;
}
.badge {
	display: inline-block; padding: 2px 10px; border-radius: 999px; background: var(--warn-soft); color: var(--warn);
	font-size: 12px; font-weight: 600; letter-spacing: .02em;
}
h1 { margin: 6px 0 4px; font-size: 24px; line-height: 1.25; }
h2 { margin: 0 0 12px; font-size: 18px; line-height: 1.3; }
h3 { margin: 0 0 6px; font-size: 16px; }
.lead { margin: 0; color: var(--muted); max-width: 72ch; }
main { max-width: 1120px; margin: 0 auto; padding: 24px; display: grid; gap: 20px; }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 20px; min-width: 0; }
.card > p:last-child, .card > ul:last-child { margin-bottom: 0; }
.muted { color: var(--muted); }
.small { font-size: 13px; color: var(--faint); }
.spotlight { border-left: 4px solid var(--accent); }
.spotlight.ok { border-left-color: var(--ok); }
.spotlight.error { border-left-color: var(--err); }
.status { display: inline-block; white-space: nowrap; padding: 2px 8px; border-radius: 6px; font-size: 13px; font-weight: 600; background: var(--surface-2); color: var(--muted); border: 1px solid var(--border); }
.status.ok { background: var(--ok-soft); color: var(--ok); border-color: transparent; }
.status.error { background: var(--err-soft); color: var(--err); border-color: transparent; }
.status.accent { background: var(--accent-soft); color: var(--accent-strong); border-color: transparent; }
.facts { list-style: none; padding: 0; margin: 12px 0; display: grid; gap: 4px; }
.numbers { display: flex; flex-wrap: wrap; gap: 12px; margin: 12px 0; }
.number { background: var(--surface-2); border: 1px solid var(--border); border-radius: 10px; padding: 8px 14px; min-width: 110px; }
.number b { display: block; font-size: 22px; line-height: 1.2; }
.number span { font-size: 13px; color: var(--muted); }
.table-wrap { overflow-x: auto; border: 1px solid var(--border); border-radius: 10px; }
table { border-collapse: collapse; width: 100%; font-size: 14px; }
th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--border); vertical-align: top; }
th { background: var(--surface-2); font-weight: 600; color: var(--muted); font-size: 13px; white-space: nowrap; }
tbody tr:last-child td { border-bottom: 0; }
td.num { text-align: right; font-variant-numeric: tabular-nums; }
.nowrap { white-space: nowrap; }
.empty { margin: 0; padding: 16px; background: var(--surface-2); border-radius: 10px; color: var(--muted); }
form.trigger { display: grid; gap: 16px; }
.field { display: grid; gap: 6px; }
.field label { font-weight: 600; font-size: 14px; }
.field input, .field select {
	width: 100%; max-width: 480px; font: inherit; color: var(--fg); background: var(--surface);
	border: 1px solid var(--border-strong); border-radius: 8px; padding: 9px 12px;
}
.field input:focus, .field select:focus { outline: 2px solid var(--accent); outline-offset: 1px; border-color: var(--accent); }
.field small { color: var(--faint); font-size: 13px; max-width: 72ch; }
button {
	justify-self: start; font: inherit; font-weight: 600; color: var(--accent-on); background: var(--accent);
	border: 0; border-radius: 8px; padding: 11px 20px; cursor: pointer;
}
button:hover { background: var(--accent-strong); }
details.tech > summary { cursor: pointer; font-weight: 600; font-size: 16px; }
details.tech[open] > summary { margin-bottom: 12px; }
details.tech h3 { margin-top: 16px; }
pre { margin: 0; background: var(--surface-2); border: 1px solid var(--border); border-radius: 10px; padding: 12px; overflow-x: auto; max-height: 420px; }
@media (max-width: 640px) {
	.top-inner { padding: 16px; gap: 12px; }
	.mark { width: 40px; height: 40px; font-size: 12px; }
	h1 { font-size: 20px; }
	main { padding: 16px; gap: 16px; }
	.card { padding: 16px; }
	button { width: 100%; justify-self: stretch; }
	.number { flex: 1 1 90px; min-width: 0; }
	table.cards thead { display: none; }
	table.cards tr { display: block; padding: 10px 12px; border-bottom: 1px solid var(--border); }
	table.cards tbody tr:last-child { border-bottom: 0; }
	table.cards td { display: block; padding: 3px 0; border: 0; text-align: right; }
	table.cards td::after { content: ''; display: block; clear: both; }
	table.cards td::before { content: attr(data-label); float: left; margin-right: 12px; color: var(--faint); font-size: 13px; }
}
</style>`;

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

function field(input: TriggerField, form: string): string {
	const id = escapeHtml(`${form}-${input.name}`);
	const label = `<label for="${id}">${escapeHtml(input.label)}</label>`;
	const name = escapeHtml(input.name);
	const hint = input.hint === undefined ? '' : `<small>${escapeHtml(input.hint)}</small>`;

	if (input.options === undefined) {
		return `<div class="field">${label}<input type="text" id="${id}" name="${name}">${hint}</div>`;
	}

	const options = input.options
		.map((option) => `<option value="${escapeHtml(option)}">${escapeHtml(option)}</option>`)
		.join('');

	return `<div class="field">${label}<select id="${id}" name="${name}">${options}</select>${hint}</div>`;
}

function triggerForm(form: TriggerForm): string {
	return [
		'<section class="card">',
		`<form class="trigger" method="post" action="${escapeHtml(form.action)}">`,
		`<div><h2>${escapeHtml(form.title)}</h2><p class="lead">${escapeHtml(form.description)}</p></div>`,
		form.fields.map((input) => field(input, form.action)).join('\n'),
		`<button type="submit">${escapeHtml(form.submit)}</button>`,
		'</form>',
		'</section>'
	].join('\n');
}

export function renderStatePage(state: {
	name: string;
	title: string;
	/** Что делает имитатор, одной-двумя фразами для зрителя. */
	intro: string;
	/** Короткая метка системы в шапке: `LMS`, `CMS`. */
	mark: string;
	scenario: ScenarioState;
	/** Что сервис знает о своих объектах: заявки у CMS, группы у LMS. */
	objects: unknown;
	/**
	 * Те же объекты для человека — готовая разметка сервиса (таблица групп,
	 * заявок); `null` — только JSON в технических подробностях.
	 */
	overview: string | null;
	journal: JournalEntry[];
	forms: readonly TriggerForm[];
	/** Закрыты ли управляющие адреса токеном: на стенде это видно сразу. */
	controlProtected: boolean;
	/**
	 * Карточка одного объекта над формами — готовая разметка сервиса; `null` —
	 * без неё. Так страница после нажатия кнопки показывает, чем кончилось
	 * именно это нажатие.
	 */
	spotlight: string | null;
}): string {
	const rows = state.journal.map(journalRow).join('\n');
	const forms = state.forms.map(triggerForm).join('\n');
	const control = state.controlProtected
		? 'Управляющие адреса (<code>__state</code>, <code>__scenario</code>) закрыты токеном.'
		: 'Управляющие адреса (<code>__state</code>, <code>__scenario</code>) открыты: имитатор рассчитан на локальный запуск.';
	const journal =
		state.journal.length === 0
			? '<p class="empty">Обменов пока не было.</p>'
			: [
					'<div class="table-wrap"><table>',
					'<thead><tr><th>Момент</th><th>Направление</th><th>Что</th><th>Код</th><th>Событие</th><th>eventId</th><th>Примечание</th></tr></thead>',
					`<tbody>\n${rows}\n</tbody>`,
					'</table></div>'
				].join('\n');

	return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(state.title)}</title>
${PAGE_STYLE}
</head>
<body>
<header class="top">
<div class="top-inner">
<div class="mark" aria-hidden="true">${escapeHtml(state.mark)}</div>
<div>
<span class="badge">Демо-имитатор стенда · не система заказчика</span>
<h1>${escapeHtml(state.title)}</h1>
<p class="lead">${escapeHtml(state.intro)}</p>
</div>
</div>
</header>
<main>
${state.spotlight ?? ''}
${state.overview ?? ''}
${forms}
<section class="card">
<details class="tech">
<summary>Технические подробности</summary>
<p class="small">Имитатор стенда, а не настоящая система: обмен с ним ничего не доказывает о работе с системой заказчика. ${control}</p>
<h3>Журнал обмена (последние ${state.journal.length})</h3>
${journal}
<h3>Сценарий</h3>
<pre>${escapeHtml(JSON.stringify(state.scenario, null, 2))}</pre>
<h3>Что известно сервису</h3>
<pre>${escapeHtml(JSON.stringify(state.objects, null, 2))}</pre>
</details>
</section>
</main>
</body>
</html>
`;
}
