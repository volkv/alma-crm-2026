/**
 * Карточка своей заявки на странице имитатора CMS: то, что посетитель сайта
 * видит после отправки формы, — дошла ли заявка до CRM и что с ней там
 * происходит.
 *
 * Без неё ответ CRM и снимки статуса пришлось бы искать в JSON всего стенда на
 * сотни строк. Здесь только своя заявка, по ключу из строки запроса. Имя
 * ответственного из снимка статуса не показывается — по той же причине, что и
 * в общем списке страницы (`docs/security.md`): страница открыта наружу.
 * Комментариев сотрудников в снимке нет вовсе: внутренняя работа на сайт не
 * уходит (`docs/exchange-contract.md`, раздел 4).
 */
import { escapeHtml } from '../shared/state-page.ts';

/** То из заявки, что показывает карточка. */
export type SpotlightApplication = {
	externalId: string;
	form: string | null;
	revision: number | null;
	sentAt: string | null;
	crmStatus: number | null;
	crmResult: string | null;
	interactionId: string | null;
	crmError: string | null;
	applicant: string | null;
	statuses: { at: string; data: Record<string, unknown> }[];
};

/** Итог приёма словами — как его поймёт человек, отправивший форму. */
const RESULT_LABELS: Record<string, string> = {
	created: 'CRM приняла заявку и завела по ней дело',
	updated: 'CRM приняла изменение заявки и обновила дело',
	unchanged: 'CRM уже знает эту редакцию заявки: ничего не изменилось'
};

/** Статус заявки из снимка CRM — словами (`docs/exchange-contract.md`, раздел 4). */
const STATUS_LABELS: Record<string, string> = {
	received: 'получена, работа ещё не началась',
	in_progress: 'в работе',
	on_hold: 'приостановлена',
	completed: 'завершена',
	cancelled: 'отменена'
};

function text(value: unknown): string {
	return escapeHtml(value === null || value === undefined ? '—' : String(value));
}

function stageName(data: Record<string, unknown>): string | null {
	const stage = data.stage;

	return typeof stage === 'object' && stage !== null && 'name' in stage
		? String((stage as { name: unknown }).name)
		: null;
}

export function renderApplicationSpotlight(
	externalId: string,
	application: SpotlightApplication | null
): string {
	if (application === null) {
		return [
			'<section id="application" class="card spotlight error">',
			`<h2>Заявка ${text(externalId)}</h2>`,
			'<p>Имитатор такой заявки не помнит: её не отправляли с этой страницы, или имитатор перезапускали.</p>',
			'</section>'
		].join('\n');
	}

	const sent =
		application.crmError !== null
			? `<p><span class="status error">Ошибка</span> <strong>Заявка до CRM не дошла.</strong> ${text(application.crmError)}</p>`
			: application.crmResult !== null
				? `<p><span class="status ok">Отправлено</span> <strong>${text(RESULT_LABELS[application.crmResult] ?? application.crmResult)}</strong> (код ${text(application.crmStatus)}).</p>`
				: application.sentAt === null
					? '<p>Карточку завёл статус из CRM: с этой формы заявку не отправляли.</p>'
					: `<p>CRM ответила кодом ${text(application.crmStatus)}.</p>`;

	const statuses =
		application.statuses.length === 0
			? '<p class="empty">Статусов из CRM пока нет: CRM присылает снимок после приёма и после каждого изменения, видного заявителю. Обновите страницу через несколько секунд.</p>'
			: [
					'<div class="table-wrap"><table>',
					'<thead><tr><th>Когда</th><th>Статус заявки</th><th>Стадия</th></tr></thead>',
					'<tbody>',
					...[...application.statuses].reverse().map((status) => {
						const code = String(status.data.applicationStatus ?? '');

						return `<tr><td>${text(status.at)}</td><td>${text(STATUS_LABELS[code] ?? code)}</td><td>${text(stageName(status.data))}</td></tr>`;
					}),
					'</tbody>',
					'</table></div>'
				].join('\n');

	return [
		`<section id="application" class="card spotlight ${application.crmError === null ? 'ok' : 'error'}">`,
		`<h2>Заявка ${text(application.externalId)}</h2>`,
		sent,
		'<ul class="facts">',
		`<li>Заявитель: ${application.applicant === null ? 'из набора формы' : text(application.applicant)}</li>`,
		`<li>Набор: ${text(application.form)}, ревизия ${text(application.revision)}, отправлена ${text(application.sentAt)}</li>`,
		application.interactionId === null
			? ''
			: `<li>Дело в CRM: <code>${text(application.interactionId)}</code></li>`,
		'</ul>',
		'<h3>Статус на сайте</h3>',
		statuses,
		`<p><a href="./?application=${encodeURIComponent(application.externalId)}">Обновить</a> · <a href="./">Вся страница имитатора</a></p>`,
		'</section>'
	].join('\n');
}

/** Заявка в списке страницы: без имени заявителя — страница открыта всем. */
export type OverviewApplication = {
	externalId: string;
	form: string | null;
	revision: number | null;
	sentAt: string | null;
	crmStatus: number | null;
	crmResult: string | null;
	crmError: string | null;
	statuses: readonly { data: Record<string, unknown> }[];
};

function delivery(application: OverviewApplication): string {
	if (application.crmError !== null) {
		return '<span class="status error">Не дошла</span>';
	}

	if (application.crmResult !== null) {
		return `<span class="status ok">Принята</span> <span class="small">код ${text(application.crmStatus)}</span>`;
	}

	return application.sentAt === null
		? '<span class="status">Заведена статусом CRM</span>'
		: `<span class="status">Код ${text(application.crmStatus)}</span>`;
}

/** Заявки сайта: ключ, набор, дошла ли до CRM и последний статус из неё. */
export function renderApplicationsOverview(applications: readonly OverviewApplication[]): string {
	const body =
		applications.length === 0
			? '<p class="empty">Заявок пока нет: отправьте форму ниже.</p>'
			: [
					'<div class="table-wrap"><table class="cards">',
					'<thead><tr><th>Заявка</th><th>Набор</th><th>Ревизия</th><th>Отправлена</th><th>В CRM</th><th>Статус на сайте</th><th>Стадия</th></tr></thead>',
					'<tbody>',
					...[...applications].reverse().map((application) => {
						const last = application.statuses.at(-1)?.data;
						const code = last === undefined ? null : String(last.applicationStatus ?? '');
						const key = encodeURIComponent(application.externalId);

						return [
							'<tr>',
							`<td data-label="Заявка"><a href="./?application=${key}"><b>${text(application.externalId)}</b></a></td>`,
							`<td data-label="Набор">${text(application.form)}</td>`,
							`<td class="num" data-label="Ревизия">${text(application.revision)}</td>`,
							`<td class="nowrap" data-label="Отправлена">${text(application.sentAt)}</td>`,
							`<td data-label="В CRM">${delivery(application)}</td>`,
							`<td data-label="Статус на сайте">${code === null ? '—' : text(STATUS_LABELS[code] ?? code)}</td>`,
							`<td data-label="Стадия">${last === undefined ? '—' : text(stageName(last))}</td>`,
							'</tr>'
						].join('');
					}),
					'</tbody>',
					'</table></div>'
				].join('\n');

	return [
		'<section class="card">',
		`<h2>Заявки с сайта (${applications.length})</h2>`,
		'<p class="small">Свежие сверху. Ключ заявки открывает её карточку со статусами из CRM.</p>',
		body,
		'</section>'
	].join('\n');
}
