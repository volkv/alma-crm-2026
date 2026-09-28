/**
 * Письмо-приглашение на встречу: контактным лицам вуза и коллегам.
 *
 * Чистая функция, как и шаблон описания программ: факты собирает вызывающий,
 * здесь — только слова и вёрстка (`layout.ts`). Само событие календаря идёт
 * не отсюда, а файлом `.ics` при письме (`METHOD:REQUEST` или `CANCEL`): его
 * распознают Gmail, Outlook, Apple и Яндекс и показывают кнопки ответа. Кнопка
 * «Добавить в Google Календарь» — запасной путь для тех, чей клиент файл не
 * разобрал: событие по ней заводится копией и переноса уже не узнает.
 *
 * Всё, что пришло от людей, — название дела, место, повестка — экранируется.
 */
import {
	buttonHtml,
	COLOR,
	escapeHtml,
	FONT,
	footnoteHtml,
	mailDocumentHtml,
	P,
	P_MUTED,
	paragraphs,
	paragraphsHtml,
	SECTION_TITLE,
	signatureHtml,
	signatureText,
	testBannerHtml,
	trimmedOrNull,
	type MailSender
} from './layout';

/** Приглашение, обновление той же встречи после переноса или её отмена. */
export type MeetingMailKind = 'invite' | 'update' | 'cancel';

export type MeetingInviteFacts = {
	kind: MeetingMailKind;
	institutionName: string;
	/** Заголовок события — тот же, что `SUMMARY` в файле календаря. */
	summary: string;
	/** Название дела: о чём встреча, словами во вступлении письма. */
	topic: string;
	recipientName: string | null; // для приветствия; null — «Здравствуйте!»
	start: Date;
	durationMinutes: number;
	location: string | null;
	agenda: string;
	/** Организатор — ответственный за дело: письмо подписано им, ответы придут ему. */
	sender: MailSender;
	isTest: boolean; // тестовое письмо себе: пометка в теме и плашка в теле
};

const MOSCOW_WHEN = new Intl.DateTimeFormat('ru-RU', {
	timeZone: 'Europe/Moscow',
	weekday: 'long',
	day: 'numeric',
	month: 'long',
	year: 'numeric',
	hour: '2-digit',
	minute: '2-digit'
});

/** Момент встречи словами: «понедельник, 5 октября 2026 г. в 14:00 по Москве». */
export function moscowWhen(start: Date): string {
	return `${MOSCOW_WHEN.format(start)} по Москве`;
}

function durationText(minutes: number): string {
	const hours = Math.floor(minutes / 60);
	const rest = minutes % 60;

	if (hours === 0) {
		return `${rest} мин`;
	}

	return rest === 0 ? `${hours} ч` : `${hours} ч ${rest} мин`;
}

/**
 * Ссылка на видеовстречу, если место — адрес `http(s)`; иначе `null`. Только
 * эти две схемы: `javascript:` и прочее кнопкой в чужом письме не становится.
 */
export function meetingJoinUrl(location: string | null): string | null {
	const value = trimmedOrNull(location);

	if (value === null || !/^https?:\/\/\S+$/i.test(value)) {
		return null;
	}

	try {
		const url = new URL(value);

		return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
	} catch {
		return null;
	}
}

/** Момент в UTC в виде `20261005T110000Z` — так его ждёт шаблон события Google. */
function utcStamp(date: Date): string {
	return date
		.toISOString()
		.replace(/[-:]/g, '')
		.replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Ссылка «Добавить в Google Календарь» (шаблон события `action=TEMPLATE`).
 * Каждое значение кодируется отдельно; `dates` — два момента в UTC через
 * косую черту, и её Google ждёт как есть.
 */
export function googleCalendarUrl(input: {
	summary: string;
	start: Date;
	durationMinutes: number;
	details: string;
	location: string | null;
}): string {
	const end = new Date(input.start.getTime() + input.durationMinutes * 60_000);
	const params = [
		'action=TEMPLATE',
		`text=${encodeURIComponent(input.summary)}`,
		`dates=${utcStamp(input.start)}/${utcStamp(end)}`,
		`details=${encodeURIComponent(input.details)}`,
		...(trimmedOrNull(input.location) === null
			? []
			: [`location=${encodeURIComponent(input.location?.trim() ?? '')}`])
	];

	return `https://calendar.google.com/calendar/render?${params.join('&')}`;
}

const KICKER: Record<MeetingMailKind, string> = {
	invite: 'Приглашение на встречу',
	update: 'Перенос встречи',
	cancel: 'Встреча отменена'
};

function subject(facts: MeetingInviteFacts): string {
	const base = `${KICKER[facts.kind]} — ${facts.institutionName.trim()}`;

	return facts.isTest ? `[Тест] ${base}` : base;
}

function greeting(facts: MeetingInviteFacts): string {
	const name = trimmedOrNull(facts.recipientName);

	return name === null ? 'Здравствуйте!' : `Здравствуйте, ${name}!`;
}

function introText(facts: MeetingInviteFacts): string {
	const topic = `«${facts.topic.trim()}»`;

	switch (facts.kind) {
		case 'invite':
			return `Приглашаем вас на встречу по теме ${topic}. Подробности — ниже.`;
		case 'update':
			return `Встреча по теме ${topic} перенесена. Ниже — новое время и место; событие в календаре обновится само.`;
		case 'cancel':
			return `Встреча по теме ${topic} отменена. Календарь, получив это письмо, уберёт событие.`;
	}
}

const CALENDAR_NOTE =
	'Файл календаря приложен — подходит для Outlook, Apple и Яндекс Календаря; в Gmail приглашение откроется прямо в письме.';

const TEST_NOTICE_TITLE = 'Тестовое письмо';
const TEST_NOTICE_BODY = 'так его увидят участники встречи. Отправлено только вам.';

/** Строки «Когда / Длительность / Место» — пары подписи и значения. */
function detailRows(facts: MeetingInviteFacts): [string, string][] {
	const location = trimmedOrNull(facts.location);

	return [
		['Когда', moscowWhen(facts.start)],
		['Длительность', durationText(facts.durationMinutes)],
		...(location === null ? [] : ([['Место', location]] as [string, string][]))
	];
}

/* ---------------------------------------------------------------- HTML --- */

function detailsHtml(facts: MeetingInviteFacts): string {
	const cancelled = facts.kind === 'cancel';
	const rows = detailRows(facts)
		.map(
			([label, value]) =>
				`<tr>` +
				`<td style="padding:6px 16px 6px 0;font-family:${FONT};font-size:14px;line-height:20px;color:${COLOR.muted};white-space:nowrap;vertical-align:top;">${escapeHtml(label)}</td>` +
				`<td style="padding:6px 0;font-family:${FONT};font-size:15px;line-height:22px;color:${COLOR.text};font-weight:bold;${cancelled ? 'text-decoration:line-through;' : ''}">${escapeHtml(value)}</td>` +
				`</tr>`
		)
		.join('');

	return (
		`<tr><td style="padding:8px 32px 8px 32px;">` +
		`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;border:1px solid ${COLOR.border};border-left:4px solid ${COLOR.accent};border-radius:8px;background-color:${COLOR.surface};">` +
		`<tr><td style="padding:14px 20px;">` +
		`<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">${rows}</table>` +
		`</td></tr></table>` +
		`</td></tr>`
	);
}

function buttonsHtml(facts: MeetingInviteFacts): string {
	if (facts.kind === 'cancel') {
		return '';
	}

	const join = meetingJoinUrl(facts.location);
	const google = googleCalendarUrl({
		summary: facts.summary,
		start: facts.start,
		durationMinutes: facts.durationMinutes,
		details: facts.agenda,
		location: facts.location
	});

	return (
		`<tr><td style="padding:8px 32px 0 32px;">` +
		(join === null ? '' : buttonHtml(join, 'Подключиться', 'brand')) +
		buttonHtml(google, 'Добавить в Google Календарь', join === null ? 'brand' : 'outline') +
		`<p style="margin:4px 0 0 0;font-family:${FONT};font-size:13px;line-height:18px;color:${COLOR.muted};">${escapeHtml(CALENDAR_NOTE)}</p>` +
		`</td></tr>`
	);
}

function agendaHtml(facts: MeetingInviteFacts): string {
	if (facts.kind === 'cancel' || paragraphs(facts.agenda).length === 0) {
		return '';
	}

	return (
		`<tr><td style="padding:16px 32px 0 32px;">` +
		`<p style="${SECTION_TITLE}">Повестка</p>` +
		paragraphsHtml(facts.agenda, P_MUTED) +
		`</td></tr>`
	);
}

function html(facts: MeetingInviteFacts): string {
	return mailDocumentHtml({
		title: subject(facts),
		preheader: `${KICKER[facts.kind]}: ${moscowWhen(facts.start)}`,
		kicker: KICKER[facts.kind],
		heading: facts.institutionName.trim(),
		before: facts.isTest ? testBannerHtml(TEST_NOTICE_TITLE, TEST_NOTICE_BODY) : '',
		body:
			`<tr><td style="padding:28px 32px 8px 32px;">` +
			`<p style="${P}">${escapeHtml(greeting(facts))}</p>` +
			`<p style="${P}">${escapeHtml(introText(facts))}</p>` +
			`</td></tr>` +
			detailsHtml(facts) +
			buttonsHtml(facts) +
			agendaHtml(facts) +
			signatureHtml(facts.sender),
		after:
			trimmedOrNull(facts.sender.email) === null
				? ''
				: footnoteHtml(
						'Ответ на приглашение из календаря и ответ на это письмо придут организатору встречи.'
					)
	});
}

/* ---------------------------------------------------------------- текст --- */

function text(facts: MeetingInviteFacts): string {
	const lines: string[] = [];

	if (facts.isTest) {
		lines.push(`${TEST_NOTICE_TITLE}: ${TEST_NOTICE_BODY}`, '');
	}

	lines.push(greeting(facts), '', introText(facts), '');

	for (const [label, value] of detailRows(facts)) {
		lines.push(`${label}: ${value}`);
	}

	lines.push('');

	if (facts.kind !== 'cancel') {
		const join = meetingJoinUrl(facts.location);

		if (join !== null) {
			lines.push(`Подключиться: ${join}`);
		}

		lines.push(
			`Добавить в Google Календарь: ${googleCalendarUrl({
				summary: facts.summary,
				start: facts.start,
				durationMinutes: facts.durationMinutes,
				details: facts.agenda,
				location: facts.location
			})}`,
			CALENDAR_NOTE,
			''
		);

		const agenda = paragraphs(facts.agenda);

		if (agenda.length > 0) {
			lines.push('ПОВЕСТКА', '', ...agenda, '');
		}
	}

	lines.push(...signatureText(facts.sender));

	return `${lines.join('\n')}\n`;
}

export function meetingInviteEmail(facts: MeetingInviteFacts): {
	subject: string;
	html: string;
	text: string;
} {
	return { subject: subject(facts), html: html(facts), text: text(facts) };
}
