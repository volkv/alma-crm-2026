/**
 * Разметка страницы имитатора LMS: карточка отправленного результата — что
 * ушло в CRM и чем она ответила — и список учебных групп.
 *
 * Без неё ответ CRM пришлось бы искать в журнале стенда. Здесь только свой
 * результат, по ключу события из строки запроса: дата окончания, числа и
 * ответ — код, итог приёма и что CRM сделала со стадией, или почему не приняла.
 */
import { MOCK_COURSES } from './moodle-data.ts';
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

/** Ответ CRM: принято и что со стадией — или почему отказ; `ok` красит карточку. */
function crmAnswer(result: SentResult): { ok: boolean; html: string } {
	if (result.crmError !== null) {
		return {
			ok: false,
			html: `<p><span class="status error">Ошибка</span> <strong>Результат до CRM не дошёл.</strong> ${text(result.crmError)}</p>`
		};
	}

	const reply = record(result.crmReply);
	const ok = result.crmStatus !== null && result.crmStatus >= 200 && result.crmStatus < 300;

	if (!ok) {
		const message = typeof reply?.message === 'string' ? `: ${reply.message}` : '';

		return {
			ok: false,
			html: `<p><span class="status error">Ошибка</span> <strong>CRM не приняла результат</strong> (код ${text(result.crmStatus)})${text(message)}</p>`
		};
	}

	const outcome = typeof reply?.result === 'string' ? reply.result : null;
	const note = record(reply?.data)?.note;

	return {
		ok: true,
		html: [
			`<p><span class="status ok">Отправлено</span> <strong>${text(outcome === null ? 'CRM ответила' : (RESULT_LABELS[outcome] ?? outcome))}</strong> (код ${text(result.crmStatus)}).</p>`,
			typeof note === 'string' ? `<p>Ответ CRM: ${text(note)}</p>` : ''
		].join('\n')
	};
}

/** Три числа потока плитками. */
function numbers(counters: SentResult['counters']): string {
	return [
		'<div class="numbers">',
		`<div class="number"><b>${text(counters.enrolled)}</b><span>зачислено</span></div>`,
		`<div class="number"><b>${text(counters.completed)}</b><span>завершили</span></div>`,
		`<div class="number"><b>${text(counters.expelled)}</b><span>отчислено</span></div>`,
		'</div>'
	].join('');
}

export function renderResultSpotlight(
	eventId: string,
	groupExternalId: string | null,
	result: SentResult | null
): string {
	if (result === null || groupExternalId === null) {
		return [
			'<section id="result" class="card spotlight error">',
			`<h2>Результат ${text(eventId)}</h2>`,
			'<p>Имитатор такого результата не помнит: его не отправляли с этой страницы, или имитатор перезапускали.</p>',
			'</section>'
		].join('\n');
	}

	const answer = crmAnswer(result);

	return [
		`<section id="result" class="card spotlight ${answer.ok ? 'ok' : 'error'}">`,
		`<h2>Результат группы ${text(groupExternalId)}</h2>`,
		answer.html,
		numbers(result.counters),
		'<ul class="facts">',
		`<li>${result.finishedOn === null ? 'Промежуточный: обучение идёт' : `Итог: обучение завершено ${text(result.finishedOn)}`}</li>`,
		`<li class="small">Отправлен ${text(result.at)}, событие <code>${text(result.eventId)}</code></li>`,
		'</ul>',
		'<p><a href="./">Вся страница имитатора</a></p>',
		'</section>'
	].join('\n');
}

/** Учебная группа, как её показывает список на странице. */
export type OverviewGroup = {
	groupExternalId: string;
	requestExternalId: string;
	programCode: string | null;
	purpose: string | null;
	plannedSeats: number | null;
	startsOn: string | null;
	endsOn: string | null;
	learnerCount: number | null;
	results: readonly SentResult[];
};

/** Для кого обучение — словами. */
const PURPOSE_LABELS: Record<string, string> = {
	students: 'студенты',
	teachers: 'преподаватели',
	upskilling: 'повышение квалификации'
};

/** Состояние группы по последнему отправленному результату. */
function groupStatus(group: OverviewGroup): string {
	const last = group.results.at(-1);

	if (last === undefined) {
		return '<span class="status accent">Группа заведена</span>';
	}

	if (last.finishedOn === null) {
		return '<span class="status">Идёт обучение</span>';
	}

	return `<span class="status ok">Завершён ${text(last.finishedOn)}</span>`;
}

/** Программа: название курса площадки, если код ей знаком, и сам код. */
function program(code: string | null): string {
	const course = code === null ? undefined : MOCK_COURSES.find((item) => item.idnumber === code);

	return course === undefined
		? text(code)
		: `${text(course.fullname)}<br><span class="small">${text(code)}</span>`;
}

function period(group: OverviewGroup): string {
	return group.startsOn === null && group.endsOn === null
		? '—'
		: `${text(group.startsOn)} — ${text(group.endsOn)}`;
}

/**
 * Потоки, которые CRM заводила заявками: ключ группы, программа, даты, места,
 * состояние и числа последнего результата. Списка слушателей здесь нет — его
 * имитатор не хранит, только число.
 */
export function renderGroupsOverview(groups: readonly OverviewGroup[]): string {
	const body =
		groups.length === 0
			? '<p class="empty">Групп пока нет: их заводит CRM, когда по делу отправляют заявку на учебную группу.</p>'
			: [
					'<div class="table-wrap"><table class="cards">',
					'<thead><tr><th>Группа</th><th>Программа</th><th>Даты потока</th><th>Места</th><th>В списке</th><th>Статус</th><th>Зачислено</th><th>Завершили</th><th>Отчислено</th></tr></thead>',
					'<tbody>',
					...groups.map((group) => {
						const counters = group.results.at(-1)?.counters;
						const purpose =
							group.purpose === null
								? ''
								: ` <span class="small">· ${text(PURPOSE_LABELS[group.purpose] ?? group.purpose)}</span>`;

						return [
							'<tr>',
							`<td data-label="Группа"><b>${text(group.groupExternalId)}</b><br><span class="small nowrap">${text(group.requestExternalId)}</span></td>`,
							`<td data-label="Программа">${program(group.programCode)}${purpose}</td>`,
							`<td class="nowrap" data-label="Даты потока">${period(group)}</td>`,
							`<td class="num" data-label="Места">${text(group.plannedSeats)}</td>`,
							`<td class="num" data-label="В списке">${text(group.learnerCount)}</td>`,
							`<td data-label="Статус">${groupStatus(group)}</td>`,
							`<td class="num" data-label="Зачислено">${text(counters?.enrolled)}</td>`,
							`<td class="num" data-label="Завершили">${text(counters?.completed)}</td>`,
							`<td class="num" data-label="Отчислено">${text(counters?.expelled)}</td>`,
							'</tr>'
						].join('');
					}),
					'</tbody>',
					'</table></div>'
				].join('\n');

	return [
		'<section class="card">',
		`<h2>Учебные группы (${groups.length})</h2>`,
		'<p class="small">Заведены по заявкам CRM. Ключ группы — для формы результата ниже.</p>',
		body,
		'</section>'
	].join('\n');
}
