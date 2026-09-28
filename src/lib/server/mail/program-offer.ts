/**
 * Письмо «информация о программах» контактному лицу вуза.
 *
 * Чистая функция: факты собирает вызывающий, здесь — только слова и вёрстка.
 * Так шаблон проверяется без базы, а тестовое письмо себе и настоящее
 * контактному лицу гарантированно выглядят одинаково.
 *
 * Вёрстка почтовая и общая с другими письмами вузу (`layout.ts`): таблицы,
 * стили только в атрибутах, цвета темы приложения.
 *
 * Всё, что пришло из справочника и от людей, экранируется: название программы
 * или описание с `<` — это текст, а не разметка, и в чужом почтовом ящике
 * особенно.
 */
import { formatBytes } from '$lib/format';
import {
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
	trimmedOrNull
} from './layout';

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

function html(facts: ProgramOfferFacts): string {
	const programs =
		facts.programs.length === 0
			? ''
			: `<tr><td style="padding:8px 32px 8px 32px;">` +
				`<p style="${SECTION_TITLE}">Программы</p>` +
				facts.programs.map(programHtml).join('') +
				`</td></tr>`;

	return mailDocumentHtml({
		title: subject(facts),
		preheader: facts.programs.map((program) => program.name.trim()).join(', '),
		kicker: 'Информация о программах',
		heading: facts.institutionName.trim(),
		before: facts.isTest ? testBannerHtml(TEST_NOTICE_TITLE, TEST_NOTICE_BODY) : '',
		body:
			// Приветствие и вступление
			`<tr><td style="padding:28px 32px 8px 32px;">` +
			`<p style="${P}">${escapeHtml(greeting(facts))}</p>` +
			`<p style="${P}">${escapeHtml(introText(facts))}</p>` +
			`</td></tr>` +
			programs +
			productsHtml(facts.products) +
			signatureHtml(facts.sender),
		after:
			trimmedOrNull(facts.sender.email) === null
				? ''
				: footnoteHtml('Чтобы задать вопрос или уточнить условия, просто ответьте на это письмо.')
	});
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

	lines.push(...signatureText(facts.sender));

	return `${lines.join('\n')}\n`;
}

export function programOfferEmail(facts: ProgramOfferFacts): {
	subject: string;
	html: string;
	text: string;
} {
	return { subject: subject(facts), html: html(facts), text: text(facts) };
}
