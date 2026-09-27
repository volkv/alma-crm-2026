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
			'<section id="application">',
			`<h2>Заявка ${text(externalId)}</h2>`,
			'<p>Имитатор такой заявки не помнит: её не отправляли с этой страницы, или имитатор перезапускали.</p>',
			'</section>'
		].join('\n');
	}

	const sent =
		application.crmError !== null
			? `<p><strong>Ошибка: заявка до CRM не дошла.</strong> ${text(application.crmError)}</p>`
			: application.crmResult !== null
				? `<p><strong>Отправлено.</strong> ${text(RESULT_LABELS[application.crmResult] ?? application.crmResult)} (код ${text(application.crmStatus)}).</p>`
				: application.sentAt === null
					? '<p>Карточку завёл статус из CRM: с этой формы заявку не отправляли.</p>'
					: `<p>CRM ответила кодом ${text(application.crmStatus)}.</p>`;

	const statuses =
		application.statuses.length === 0
			? '<p>Статусов из CRM пока нет: CRM присылает снимок после приёма и после каждого изменения, видного заявителю. Обновите страницу через несколько секунд.</p>'
			: [
					'<table border="1" cellpadding="4">',
					'<thead><tr><th>Когда</th><th>Статус заявки</th><th>Стадия</th></tr></thead>',
					'<tbody>',
					...[...application.statuses].reverse().map((status) => {
						const code = String(status.data.applicationStatus ?? '');

						return `<tr><td>${text(status.at)}</td><td>${text(STATUS_LABELS[code] ?? code)}</td><td>${text(stageName(status.data))}</td></tr>`;
					}),
					'</tbody>',
					'</table>'
				].join('\n');

	return [
		'<section id="application">',
		`<h2>Заявка ${text(application.externalId)}</h2>`,
		sent,
		'<ul>',
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
