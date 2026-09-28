/**
 * Письмо «пакет документов» контактному лицу вуза: документы дела,
 * собранные по шаблонам, во вложении.
 *
 * Чистая функция, как шаблон описания программ (`program-offer.ts`): факты
 * собирает вызывающий, здесь — только слова и вёрстка, общая с другими
 * письмами вузу (`layout.ts`). Названия документов пришли из дела и
 * экранируются.
 */
import { formatBytes } from '$lib/format';
import {
	COLOR,
	escapeHtml,
	FONT,
	footnoteHtml,
	mailDocumentHtml,
	P,
	SECTION_TITLE,
	signatureHtml,
	signatureText,
	testBannerHtml,
	trimmedOrNull,
	type MailSender
} from './layout';

export type DocumentPackageFacts = {
	institutionName: string;
	interactionTitle: string;
	recipientName: string | null; // для приветствия; null — «Здравствуйте!»
	documents: { title: string; fileName: string; sizeBytes: number }[];
	sender: MailSender;
	isTest: boolean; // тестовое письмо себе: пометка в теме и плашка в теле
};

function greeting(facts: DocumentPackageFacts): string {
	const name = trimmedOrNull(facts.recipientName);

	return name === null ? 'Здравствуйте!' : `Здравствуйте, ${name}!`;
}

/** Вузу нужно не «ознакомиться», а ответить: вступление называет, чего ждём. */
function introText(facts: DocumentPackageFacts): string {
	return (
		`Направляем пакет документов по взаимодействию «${facts.interactionTitle.trim()}». ` +
		`Файлы приложены к письму. Просим проверить реквизиты и условия и прислать ответный ` +
		`пакет или замечания ответом на это письмо.`
	);
}

function subject(facts: DocumentPackageFacts): string {
	const base = `Пакет документов — ${facts.institutionName.trim()}`;

	return facts.isTest ? `[Тест] ${base}` : base;
}

const TEST_NOTICE_TITLE = 'Тестовое письмо';
const TEST_NOTICE_BODY =
	'так его увидит контактное лицо вуза. Отправлено только вам, вузу оно не ушло.';

function documentsHtml(documents: DocumentPackageFacts['documents']): string {
	if (documents.length === 0) {
		return '';
	}

	const rows = documents
		.map(
			(document) =>
				`<tr>` +
				`<td style="padding:10px 0;border-top:1px solid ${COLOR.border};">` +
				`<p style="margin:0;font-family:${FONT};font-size:15px;line-height:22px;font-weight:bold;color:${COLOR.text};">${escapeHtml(document.title)}</p>` +
				`<p style="margin:2px 0 0 0;font-family:${FONT};font-size:13px;line-height:18px;color:${COLOR.muted};">${escapeHtml(document.fileName)}</p>` +
				`</td>` +
				`<td align="right" valign="top" style="padding:10px 0 10px 12px;border-top:1px solid ${COLOR.border};font-family:${FONT};font-size:13px;line-height:22px;color:${COLOR.muted};white-space:nowrap;">${escapeHtml(formatBytes(document.sizeBytes))}</td>` +
				`</tr>`
		)
		.join('');

	return (
		`<tr><td style="padding:8px 32px 8px 32px;">` +
		`<p style="${SECTION_TITLE}">Во вложении</p>` +
		`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">${rows}</table>` +
		`</td></tr>`
	);
}

function html(facts: DocumentPackageFacts): string {
	return mailDocumentHtml({
		title: subject(facts),
		preheader: facts.documents.map((document) => document.title.trim()).join(', '),
		kicker: 'Пакет документов',
		heading: facts.institutionName.trim(),
		before: facts.isTest ? testBannerHtml(TEST_NOTICE_TITLE, TEST_NOTICE_BODY) : '',
		body:
			`<tr><td style="padding:28px 32px 8px 32px;">` +
			`<p style="${P}">${escapeHtml(greeting(facts))}</p>` +
			`<p style="${P}">${escapeHtml(introText(facts))}</p>` +
			`</td></tr>` +
			documentsHtml(facts.documents) +
			signatureHtml(facts.sender),
		after:
			trimmedOrNull(facts.sender.email) === null
				? ''
				: footnoteHtml('Ответный пакет и замечания присылайте ответом на это письмо.')
	});
}

function text(facts: DocumentPackageFacts): string {
	const lines: string[] = [];

	if (facts.isTest) {
		lines.push(`${TEST_NOTICE_TITLE}: ${TEST_NOTICE_BODY}`, '');
	}

	lines.push(greeting(facts), '', introText(facts), '');

	if (facts.documents.length > 0) {
		lines.push('ВО ВЛОЖЕНИИ', '');

		for (const document of facts.documents) {
			lines.push(`— ${document.title} (${document.fileName}, ${formatBytes(document.sizeBytes)})`);
		}

		lines.push('');
	}

	lines.push(...signatureText(facts.sender));

	return `${lines.join('\n')}\n`;
}

export function documentPackageEmail(facts: DocumentPackageFacts): {
	subject: string;
	html: string;
	text: string;
} {
	return { subject: subject(facts), html: html(facts), text: text(facts) };
}
