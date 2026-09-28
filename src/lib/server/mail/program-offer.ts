/**
 * Письмо «информация о программах» контактному лицу вуза.
 *
 * Чистая функция: факты собирает вызывающий, здесь — только слова и вёрстка.
 * Так шаблон проверяется без базы, а тестовое письмо себе и настоящее
 * контактному лицу гарантированно выглядят одинаково.
 *
 * Вёрстка почтовая, а не веб-страничная: таблицы, стили только в атрибутах,
 * ширина 600 пикселей, ни одной внешней картинки, шрифта или скрипта. Почтовые
 * клиенты вырезают `<style>` и не грузят внешнее без спроса, и письмо, которое
 * держится на них, у адресата развалится. Цвета — из темы приложения: тот же
 * фиолетовый и оранжевый, что в интерфейсе.
 *
 * Всё, что пришло из справочника и от людей, экранируется: название программы
 * или описание с `<` — это текст, а не разметка, и в чужом почтовом ящике
 * особенно.
 */
import { formatBytes } from '$lib/format';

export type ProgramOfferFacts = {
	institutionName: string;
	interactionTitle: string;
	recipientName: string | null; // для приветствия; null — «Здравствуйте!»
	programs: {
		code: string;
		name: string;
		levelLabel: string;
		description: string | null;
		versionSummary: string | null; // что предлагаем по привязанной к делу версии
		materials: { fileName: string; sizeBytes: number }[];
	}[];
	products: { name: string; description: string | null }[];
	sender: { name: string; email: string | null; position?: string | null };
	isTest: boolean; // тестовое письмо себе: пометка в теме и плашка в теле
};

/** Цвета темы приложения (`src/app.css`), сплошными значениями: переменных почта не знает. */
const COLOR = {
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

const FONT = 'Arial, Helvetica, sans-serif';

function escapeHtml(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;');
}

/** Абзацы текста из справочника: пустая строка делит абзацы, перевод строки остаётся переводом. */
function paragraphs(text: string | null): string[] {
	if (text === null) {
		return [];
	}

	return text
		.replaceAll('\r\n', '\n')
		.split(/\n\s*\n/)
		.map((part) => part.trim())
		.filter((part) => part !== '');
}

function paragraphsHtml(text: string | null, style: string): string {
	return paragraphs(text)
		.map((part) => `<p style="${style}">${escapeHtml(part).replaceAll('\n', '<br>')}</p>`)
		.join('');
}

function trimmedOrNull(value: string | null | undefined): string | null {
	const trimmed = value?.trim() ?? '';

	return trimmed === '' ? null : trimmed;
}

function greeting(facts: ProgramOfferFacts): string {
	const name = trimmedOrNull(facts.recipientName);

	return name === null ? 'Здравствуйте!' : `Здравствуйте, ${name}!`;
}

function hasMaterials(facts: ProgramOfferFacts): boolean {
	return facts.programs.some((program) => program.materials.length > 0);
}

/**
 * Вступление без склонений: название вуза стоит в шапке именительным, а не
 * внутри фразы, — «предлагаем МГТУ им. Н. Э. Баумана» по шаблону не склонить.
 */
function introText(facts: ProgramOfferFacts): string {
	const materials = hasMaterials(facts) ? ', подробные материалы приложены к письму' : '';

	return (
		`Направляем информацию об образовательных программах, которые предлагаем вашей организации ` +
		`в рамках взаимодействия «${facts.interactionTitle.trim()}». ` +
		`Ниже — краткое описание каждой программы${materials}.`
	);
}

function subject(facts: ProgramOfferFacts): string {
	const base = `Информация о программах — ${facts.institutionName.trim()}`;

	return facts.isTest ? `[Тест] ${base}` : base;
}

const TEST_NOTICE_TITLE = 'Тестовое письмо';
const TEST_NOTICE_BODY =
	'так его увидит контактное лицо вуза. Отправлено только вам, вузу оно не ушло.';

/* ---------------------------------------------------------------- HTML --- */

const P = `margin:0 0 12px 0;font-family:${FONT};font-size:15px;line-height:22px;color:${COLOR.text};`;
const P_MUTED = `margin:0 0 8px 0;font-family:${FONT};font-size:14px;line-height:20px;color:${COLOR.muted};`;
const SECTION_TITLE = `margin:0 0 12px 0;font-family:${FONT};font-size:13px;line-height:18px;font-weight:bold;letter-spacing:0.06em;text-transform:uppercase;color:${COLOR.muted};`;

function materialsHtml(materials: ProgramOfferFacts['programs'][number]['materials']): string {
	if (materials.length === 0) {
		return '';
	}

	const rows = materials
		.map(
			(material) =>
				`<tr>` +
				`<td style="padding:6px 0;border-top:1px solid ${COLOR.border};font-family:${FONT};font-size:14px;line-height:20px;color:${COLOR.text};">${escapeHtml(material.fileName)}</td>` +
				`<td align="right" style="padding:6px 0 6px 12px;border-top:1px solid ${COLOR.border};font-family:${FONT};font-size:13px;line-height:20px;color:${COLOR.muted};white-space:nowrap;">${escapeHtml(formatBytes(material.sizeBytes))}</td>` +
				`</tr>`
		)
		.join('');

	return (
		`<p style="margin:16px 0 4px 0;font-family:${FONT};font-size:13px;line-height:18px;font-weight:bold;color:${COLOR.muted};">Во вложении</p>` +
		`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">${rows}</table>`
	);
}

function programHtml(program: ProgramOfferFacts['programs'][number]): string {
	const level = trimmedOrNull(program.levelLabel);
	const version = trimmedOrNull(program.versionSummary);

	const versionBlock =
		version === null
			? ''
			: `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:12px 0 0 0;border-collapse:separate;">` +
				`<tr><td style="padding:12px 14px;background-color:${COLOR.surfaceSoft};border-radius:6px;">` +
				`<p style="margin:0 0 4px 0;font-family:${FONT};font-size:13px;line-height:18px;font-weight:bold;color:${COLOR.brandText};">Что предлагаем</p>` +
				paragraphsHtml(
					version,
					`margin:0;font-family:${FONT};font-size:14px;line-height:20px;color:${COLOR.text};`
				) +
				`</td></tr></table>`;

	return (
		`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px 0;border-collapse:separate;border:1px solid ${COLOR.border};border-left:4px solid ${COLOR.accent};border-radius:8px;background-color:${COLOR.surface};">` +
		`<tr><td style="padding:18px 20px;">` +
		`<p style="margin:0 0 8px 0;font-family:${FONT};font-size:12px;line-height:18px;">` +
		`<span style="display:inline-block;padding:2px 8px;border-radius:4px;background-color:${COLOR.brandSoft};color:${COLOR.brandText};font-weight:bold;letter-spacing:0.02em;">${escapeHtml(program.code)}</span>` +
		(level === null
			? ''
			: `<span style="color:${COLOR.muted};">&nbsp;&nbsp;${escapeHtml(level)}</span>`) +
		`</p>` +
		`<p style="margin:0 0 10px 0;font-family:${FONT};font-size:18px;line-height:24px;font-weight:bold;color:${COLOR.text};">${escapeHtml(program.name)}</p>` +
		paragraphsHtml(program.description, P_MUTED) +
		versionBlock +
		materialsHtml(program.materials) +
		`</td></tr></table>`
	);
}

function productsHtml(products: ProgramOfferFacts['products']): string {
	if (products.length === 0) {
		return '';
	}

	const items = products
		.map(
			(product) =>
				`<tr><td style="padding:10px 0;border-top:1px solid ${COLOR.border};">` +
				`<p style="margin:0 0 4px 0;font-family:${FONT};font-size:15px;line-height:22px;font-weight:bold;color:${COLOR.text};">${escapeHtml(product.name)}</p>` +
				paragraphsHtml(product.description, P_MUTED) +
				`</td></tr>`
		)
		.join('');

	return (
		`<tr><td style="padding:8px 32px 8px 32px;">` +
		`<p style="${SECTION_TITLE}">Продукты</p>` +
		`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">${items}</table>` +
		`</td></tr>`
	);
}

function signatureHtml(sender: ProgramOfferFacts['sender']): string {
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

function html(facts: ProgramOfferFacts): string {
	const title = escapeHtml(subject(facts));
	const preheader = facts.programs.map((program) => program.name.trim()).join(', ');

	const testBanner = facts.isTest
		? `<tr><td style="padding:0 0 12px 0;">` +
			`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;"><tr>` +
			`<td style="padding:12px 16px;background-color:${COLOR.warningSoft};border:1px solid ${COLOR.warningBorder};border-radius:8px;font-family:${FONT};font-size:14px;line-height:20px;color:${COLOR.warningText};">` +
			`<strong>${TEST_NOTICE_TITLE}:</strong> ${TEST_NOTICE_BODY}` +
			`</td></tr></table>` +
			`</td></tr>`
		: '';

	const programs =
		facts.programs.length === 0
			? ''
			: `<tr><td style="padding:8px 32px 8px 32px;">` +
				`<p style="${SECTION_TITLE}">Программы</p>` +
				facts.programs.map(programHtml).join('') +
				`</td></tr>`;

	const footer =
		trimmedOrNull(facts.sender.email) === null
			? ''
			: `<tr><td style="padding:16px 24px 0 24px;font-family:${FONT};font-size:12px;line-height:18px;color:${COLOR.muted};text-align:center;">` +
				`Чтобы задать вопрос или уточнить условия, просто ответьте на это письмо.` +
				`</td></tr>`;

	return (
		`<!DOCTYPE html>` +
		`<html lang="ru"><head>` +
		`<meta charset="utf-8">` +
		`<meta name="viewport" content="width=device-width, initial-scale=1">` +
		`<meta name="color-scheme" content="light">` +
		`<title>${title}</title>` +
		`</head>` +
		`<body style="margin:0;padding:0;background-color:${COLOR.page};">` +
		// Первая строка в списке писем: без неё клиент покажет начало вёрстки.
		`<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">${escapeHtml(preheader)}</div>` +
		`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${COLOR.page};">` +
		`<tr><td align="center" style="padding:24px 12px;">` +
		`<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;">` +
		testBanner +
		`<tr><td style="background-color:${COLOR.surface};border-radius:12px;overflow:hidden;">` +
		`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">` +
		// Шапка
		`<tr><td style="padding:28px 32px 24px 32px;background-color:${COLOR.brand};border-radius:12px 12px 0 0;">` +
		`<p style="margin:0 0 6px 0;font-family:${FONT};font-size:12px;line-height:16px;font-weight:bold;letter-spacing:0.08em;text-transform:uppercase;color:${COLOR.brandMuted};">Информация о программах</p>` +
		`<p style="margin:0;font-family:${FONT};font-size:22px;line-height:28px;font-weight:bold;color:#ffffff;">${escapeHtml(facts.institutionName.trim())}</p>` +
		`</td></tr>` +
		`<tr><td style="height:4px;line-height:4px;font-size:0;background-color:${COLOR.accent};">&nbsp;</td></tr>` +
		// Приветствие и вступление
		`<tr><td style="padding:28px 32px 8px 32px;">` +
		`<p style="${P}">${escapeHtml(greeting(facts))}</p>` +
		`<p style="${P}">${escapeHtml(introText(facts))}</p>` +
		`</td></tr>` +
		programs +
		productsHtml(facts.products) +
		signatureHtml(facts.sender) +
		`</table>` +
		`</td></tr>` +
		footer +
		`</table>` +
		`</td></tr></table>` +
		`</body></html>`
	);
}

/* ---------------------------------------------------------------- текст --- */

function text(facts: ProgramOfferFacts): string {
	const lines: string[] = [];

	if (facts.isTest) {
		lines.push(`${TEST_NOTICE_TITLE}: ${TEST_NOTICE_BODY}`, '');
	}

	lines.push(greeting(facts), '', introText(facts), '');

	if (facts.programs.length > 0) {
		lines.push('ПРОГРАММЫ', '');

		facts.programs.forEach((program, index) => {
			const level = trimmedOrNull(program.levelLabel);
			const version = trimmedOrNull(program.versionSummary);

			lines.push(`${index + 1}. ${program.code} — ${program.name}`);

			if (level !== null) {
				lines.push(`Уровень: ${level}`);
			}

			for (const part of paragraphs(program.description)) {
				lines.push('', part);
			}

			if (version !== null) {
				lines.push('', 'Что предлагаем:', ...paragraphs(version));
			}

			if (program.materials.length > 0) {
				lines.push('', 'Во вложении:');

				for (const material of program.materials) {
					lines.push(`  — ${material.fileName} (${formatBytes(material.sizeBytes)})`);
				}
			}

			lines.push('');
		});
	}

	if (facts.products.length > 0) {
		lines.push('ПРОДУКТЫ', '');

		for (const product of facts.products) {
			lines.push(`— ${product.name}`);

			for (const part of paragraphs(product.description)) {
				lines.push(`  ${part.replaceAll('\n', '\n  ')}`);
			}
		}

		lines.push('');
	}

	lines.push('С уважением,', facts.sender.name);

	const position = trimmedOrNull(facts.sender.position);
	const email = trimmedOrNull(facts.sender.email);

	if (position !== null) {
		lines.push(position);
	}

	if (email !== null) {
		lines.push(email);
	}

	return `${lines.join('\n')}\n`;
}

export function programOfferEmail(facts: ProgramOfferFacts): {
	subject: string;
	html: string;
	text: string;
} {
	return { subject: subject(facts), html: html(facts), text: text(facts) };
}
