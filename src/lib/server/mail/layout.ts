/**
 * Общая почтовая вёрстка писем людям вне системы: цвета темы, шрифт,
 * экранирование, абзацы, кнопка и подпись.
 *
 * Вёрстка почтовая, а не веб-страничная: таблицы, стили только в атрибутах,
 * ни одной внешней картинки, шрифта или скрипта. Почтовые клиенты вырезают
 * `<style>` и не грузят внешнее без спроса, и письмо, которое держится на них,
 * у адресата развалится. Шаблоны писем (`program-offer.ts`,
 * `meeting-invite.ts`) берут отсюда одно и то же, чтобы письма вузу выглядели
 * одной рукой.
 */

/** Цвета темы приложения (`src/app.css`), сплошными значениями: переменных почта не знает. */
export const COLOR = {
	brand: '#7700ff',
	brandSoft: '#f1e6ff',
	brandText: '#6500d9',
	brandMuted: '#ddbfff',
	accent: '#ff4f12',
	text: '#101828',
	muted: '#585d69',
	border: '#e8e8ee',
	page: '#f4f4f5',
	surface: '#ffffff',
	surfaceSoft: '#f9f9fa',
	warningSoft: '#fff6e7',
	warningBorder: '#fed388',
	warningText: '#593a06'
} as const;

export const FONT = 'Arial, Helvetica, sans-serif';

export const P = `margin:0 0 12px 0;font-family:${FONT};font-size:15px;line-height:22px;color:${COLOR.text};`;
export const P_MUTED = `margin:0 0 8px 0;font-family:${FONT};font-size:14px;line-height:20px;color:${COLOR.muted};`;
export const SECTION_TITLE = `margin:0 0 12px 0;font-family:${FONT};font-size:13px;line-height:18px;font-weight:bold;letter-spacing:0.06em;text-transform:uppercase;color:${COLOR.muted};`;

export function escapeHtml(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;');
}

/** Абзацы текста: пустая строка делит абзацы, перевод строки остаётся переводом. */
export function paragraphs(text: string | null): string[] {
	if (text === null) {
		return [];
	}

	return text
		.replaceAll('\r\n', '\n')
		.split(/\n\s*\n/)
		.map((part) => part.trim())
		.filter((part) => part !== '');
}

export function paragraphsHtml(text: string | null, style: string): string {
	return paragraphs(text)
		.map((part) => `<p style="${style}">${escapeHtml(part).replaceAll('\n', '<br>')}</p>`)
		.join('');
}

export function trimmedOrNull(value: string | null | undefined): string | null {
	const trimmed = value?.trim() ?? '';

	return trimmed === '' ? null : trimmed;
}

/**
 * Кнопка-ссылка: ячейка таблицы с заливкой, а не `<button>` и не стиль
 * `display:inline-block` на ссылке — так она кнопкой остаётся и в Outlook.
 * Адрес экранируется как значение атрибута: в нём бывают `&` и кавычки.
 */
export function buttonHtml(href: string, label: string, tone: 'brand' | 'outline'): string {
	const cell =
		tone === 'brand'
			? `background-color:${COLOR.brand};border:1px solid ${COLOR.brand};`
			: `background-color:${COLOR.surface};border:1px solid ${COLOR.brandMuted};`;
	const color = tone === 'brand' ? '#ffffff' : COLOR.brandText;

	return (
		`<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 8px 8px 0;border-collapse:separate;display:inline-table;">` +
		`<tr><td style="${cell}border-radius:6px;">` +
		`<a href="${escapeHtml(href)}" style="display:block;padding:10px 18px;font-family:${FONT};font-size:14px;line-height:20px;font-weight:bold;color:${color};text-decoration:none;">${escapeHtml(label)}</a>` +
		`</td></tr></table>`
	);
}

export type MailSender = { name: string; email: string | null; position?: string | null };

/** Подпись строкой таблицы письма: «С уважением», имя, должность, почта. */
export function signatureHtml(sender: MailSender): string {
	const position = trimmedOrNull(sender.position);
	const email = trimmedOrNull(sender.email);

	return (
		`<tr><td style="padding:16px 32px 28px 32px;">` +
		`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;"><tr><td style="padding:16px 0 0 0;border-top:1px solid ${COLOR.border};">` +
		`<p style="margin:0 0 4px 0;font-family:${FONT};font-size:15px;line-height:22px;color:${COLOR.text};">С уважением,</p>` +
		`<p style="margin:0;font-family:${FONT};font-size:15px;line-height:22px;font-weight:bold;color:${COLOR.text};">${escapeHtml(sender.name)}</p>` +
		(position === null
			? ''
			: `<p style="margin:0;font-family:${FONT};font-size:14px;line-height:20px;color:${COLOR.muted};">${escapeHtml(position)}</p>`) +
		(email === null
			? ''
			: `<p style="margin:4px 0 0 0;font-family:${FONT};font-size:14px;line-height:20px;"><a href="mailto:${escapeHtml(email)}" style="color:${COLOR.brand};text-decoration:none;">${escapeHtml(email)}</a></p>`) +
		`</td></tr></table>` +
		`</td></tr>`
	);
}

/** Подпись текстовой версии письма. */
export function signatureText(sender: MailSender): string[] {
	const lines = ['С уважением,', sender.name];
	const position = trimmedOrNull(sender.position);
	const email = trimmedOrNull(sender.email);

	if (position !== null) {
		lines.push(position);
	}

	if (email !== null) {
		lines.push(email);
	}

	return lines;
}

/** Плашка тестового письма строкой таблицы над карточкой письма. */
export function testBannerHtml(title: string, body: string): string {
	return (
		`<tr><td style="padding:0 0 12px 0;">` +
		`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;"><tr>` +
		`<td style="padding:12px 16px;background-color:${COLOR.warningSoft};border:1px solid ${COLOR.warningBorder};border-radius:8px;font-family:${FONT};font-size:14px;line-height:20px;color:${COLOR.warningText};">` +
		`<strong>${escapeHtml(title)}:</strong> ${escapeHtml(body)}` +
		`</td></tr></table>` +
		`</td></tr>`
	);
}

/**
 * Каркас письма: страница, карточка шириной 600 пикселей, фиолетовая шапка с
 * надзаголовком и заголовком, оранжевая полоса под ней. `body` — строки
 * таблицы карточки, `before` и `after` — строки над и под карточкой.
 */
export function mailDocumentHtml(input: {
	title: string;
	preheader: string;
	kicker: string;
	heading: string;
	before?: string;
	body: string;
	after?: string;
}): string {
	return (
		`<!DOCTYPE html>` +
		`<html lang="ru"><head>` +
		`<meta charset="utf-8">` +
		`<meta name="viewport" content="width=device-width, initial-scale=1">` +
		`<meta name="color-scheme" content="light">` +
		`<title>${escapeHtml(input.title)}</title>` +
		`</head>` +
		`<body style="margin:0;padding:0;background-color:${COLOR.page};">` +
		// Первая строка в списке писем: без неё клиент покажет начало вёрстки.
		`<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">${escapeHtml(input.preheader)}</div>` +
		`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${COLOR.page};">` +
		`<tr><td align="center" style="padding:24px 12px;">` +
		`<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;">` +
		(input.before ?? '') +
		`<tr><td style="background-color:${COLOR.surface};border-radius:12px;overflow:hidden;">` +
		`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">` +
		`<tr><td style="padding:28px 32px 24px 32px;background-color:${COLOR.brand};border-radius:12px 12px 0 0;">` +
		`<p style="margin:0 0 6px 0;font-family:${FONT};font-size:12px;line-height:16px;font-weight:bold;letter-spacing:0.08em;text-transform:uppercase;color:${COLOR.brandMuted};">${escapeHtml(input.kicker)}</p>` +
		`<p style="margin:0;font-family:${FONT};font-size:22px;line-height:28px;font-weight:bold;color:#ffffff;">${escapeHtml(input.heading)}</p>` +
		`</td></tr>` +
		`<tr><td style="height:4px;line-height:4px;font-size:0;background-color:${COLOR.accent};">&nbsp;</td></tr>` +
		input.body +
		`</table>` +
		`</td></tr>` +
		(input.after ?? '') +
		`</table>` +
		`</td></tr></table>` +
		`</body></html>`
	);
}

/** Строка под карточкой: «ответьте на это письмо» и прочие пояснения мелким шрифтом. */
export function footnoteHtml(text: string): string {
	return (
		`<tr><td style="padding:16px 24px 0 24px;font-family:${FONT};font-size:12px;line-height:18px;color:${COLOR.muted};text-align:center;">` +
		escapeHtml(text) +
		`</td></tr>`
	);
}
