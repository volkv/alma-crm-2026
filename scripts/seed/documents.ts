/**
 * Синтетические документы демонстрационного стенда, у которых нет системного
 * шаблона (`templates/`): подписанный экземпляр соглашения, его скан и
 * документ об обучении. Соглашение и акт передачи собирает настоящий шаблон
 * через `$lib/server/documents/generate` — здесь для них ничего не меняется.
 * А то, что в деле выглядит как файл, который принёс бы менеджер, набор до сих
 * пор представлял заглушкой в пару строк текста; здесь она заменена на
 * содержательный PDF с реквизитами сторон дела, номером, датой, позициями и
 * строками подписей.
 *
 * Печатает PDF та же служба, что и системные документы (Gotenberg), но другим
 * маршрутом: не конвертацией DOCX, а печатью HTML-страницы Chromium'ом — тем
 * же, которым в приложении печатаются отчёты (`$lib/server/reports/gotenberg`)
 * и документация сборки (`scripts/docs-pdf/gotenberg.ts`). Клиент здесь свой,
 * а не переиспользованный: тем двум чужой формат страницы (альбомный отчёт,
 * инструмент без окружения приложения) не подходит, а собирать третий модуль
 * ради одного вызова из каждого — лишняя связность. Внутри сида клиент общий:
 * им же печатаются описания программ (`scripts/seed/program-materials.ts`).
 *
 * Недоступный Gotenberg не должен ронять заливку — этим документом стадия
 * подтверждается, и без него набор встал бы на первом же взаимодействии,
 * прошедшем подписание. Поэтому при отказе службы файл собирается обычным
 * текстом с теми же данными: хуже как доказательство, но не хуже, чем было.
 */
import { eq } from 'drizzle-orm';
import { getConfig } from '$lib/server/config';
import { getDb } from '$lib/server/db';
import { organizations } from '$lib/server/db/schema';
import { DocumentConversionError, hideServiceAddresses } from '$lib/server/documents/errors';
import { PDF_MIME, sniffDocumentMime, type AllowedDocumentMime } from '$lib/server/documents/mime';

/** Потолок ожидания печати: одна-две страницы, служба уже поднята заливкой соглашений. */
const RENDER_TIMEOUT_MS = 30_000;

/** Имена, по которым Chromium узнаёт страницу и её подвал; менять нельзя. */
const PAGE_FILE_NAME = 'index.html';
const FOOTER_FILE_NAME = 'footer.html';

/** A4, книжная ориентация — как у документа, который распечатали для подписи. */
const PAGE_WIDTH_INCHES = '8.27';
const PAGE_HEIGHT_INCHES = '11.69';

/** Пометка, обязательная на каждой странице синтетического документа. */
export const DEMO_NOTICE = 'Демонстрационный образец — синтетические данные';

/** Подписанты, общие для всех документов набора (см. `generateAgreement`). */
export const OPERATOR_SIGNER = 'директор Школы Орлов В. С.';
export const INSTITUTION_SIGNER = 'ректор';

export type DocumentParty = {
	role: string;
	name: string;
	requisites?: string;
	/** Есть строка подписи — сторона подписывает документ. */
	signer?: string;
};

export type DocumentLine = { label: string; value: string };

export type SyntheticDocumentContent = {
	title: string;
	docNumber: string;
	docDate: string;
	/** Короткая фраза под заголовком: что это за файл и почему он в деле. */
	intro: string;
	parties: readonly DocumentParty[];
	lines?: readonly DocumentLine[];
	/** Пометка перед подписями — например, чем отличается эта редакция. */
	note?: string;
};

/** Реквизиты организации одной строкой — так их печатает пакет документов. */
export async function organizationRequisites(organizationId: string): Promise<string> {
	const [row] = await getDb()
		.select({ inn: organizations.inn, kpp: organizations.kpp, ogrn: organizations.ogrn })
		.from(organizations)
		.where(eq(organizations.id, organizationId))
		.limit(1);

	if (row === undefined) {
		throw new Error(`Организация ${organizationId} не заведена`);
	}

	return [
		row.inn === null ? null : `ИНН ${row.inn}`,
		row.kpp === null ? null : `КПП ${row.kpp}`,
		row.ogrn === null ? null : `ОГРН ${row.ogrn}`
	]
		.filter((part): part is string => part !== null)
		.join(', ');
}

/**
 * Номер документа набора: детерминированный хвост интерактивного
 * идентификатора взаимодействия — тот же при каждом сиде, но разный у разных
 * дел и разных видов документа одного дела.
 */
export function syntheticDocumentNumber(interactionId: string, prefix: string): string {
	const tail = interactionId.replace(/-/g, '').slice(-8).toUpperCase();

	return `№ ${prefix}-${tail}`;
}

export function escapeHtml(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;');
}

function partyRowHtml(party: DocumentParty): string {
	const requisites =
		party.requisites === undefined
			? ''
			: `<br /><span class="muted">${escapeHtml(party.requisites)}</span>`;

	return `<tr><th>${escapeHtml(party.role)}</th><td>${escapeHtml(party.name)}${requisites}</td></tr>`;
}

function signatureBlockHtml(party: DocumentParty, docDate: string): string {
	return `
		<div class="signature-block">
			<div class="signature-role">${escapeHtml(party.role)}</div>
			<div>${escapeHtml(party.signer ?? '')}</div>
			<div class="signature-line"><span>Подпись</span><span>${escapeHtml(docDate)}</span></div>
		</div>`;
}

function renderContentHtml(content: SyntheticDocumentContent): string {
	const linesHtml =
		content.lines === undefined || content.lines.length === 0
			? ''
			: `<table class="lines"><tbody>${content.lines
					.map(
						(line) =>
							`<tr><td>${escapeHtml(line.label)}</td><td>${escapeHtml(line.value)}</td></tr>`
					)
					.join('')}</tbody></table>`;

	const noteHtml =
		content.note === undefined ? '' : `<p class="note">${escapeHtml(content.note)}</p>`;

	const signers = content.parties.filter(
		(party): party is DocumentParty & { signer: string } => party.signer !== undefined
	);

	return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8" />
<style>
	* { box-sizing: border-box; }
	body {
		font-family: Georgia, "Times New Roman", serif;
		color: #1a1a1a;
		font-size: 13px;
		line-height: 1.5;
		margin: 0;
	}
	.doc-header { text-align: center; margin-bottom: 20px; }
	.doc-header h1 { font-size: 16px; text-transform: uppercase; letter-spacing: 0.02em; margin: 0 0 8px; }
	.doc-meta { font-size: 12px; color: #333; }
	.intro { margin: 16px 0; }
	table { width: 100%; border-collapse: collapse; margin: 16px 0; }
	.parties th, .parties td { border: 1px solid #999; padding: 8px 10px; text-align: left; vertical-align: top; font-size: 12px; }
	.parties th { background: #f0f0f0; width: 28%; }
	.muted { color: #555; }
	.lines td { border: 1px solid #ccc; padding: 6px 10px; font-size: 12px; }
	.lines td:first-child { width: 40%; color: #444; }
	.note { margin: 16px 0; font-style: italic; }
	.signatures { margin-top: 32px; }
	.signature-row { display: flex; justify-content: space-between; page-break-inside: avoid; }
	.signature-block { width: 46%; margin-bottom: 28px; }
	.signature-role { font-size: 11px; text-transform: uppercase; color: #555; margin-bottom: 4px; }
	.signature-line { margin-top: 24px; border-top: 1px solid #333; font-size: 11px; padding-top: 4px; display: flex; justify-content: space-between; }
	.stamp { margin-top: 36px; border: 2px solid #b00020; color: #b00020; padding: 10px 14px; text-align: center; font-weight: 700; letter-spacing: 0.03em; text-transform: uppercase; font-size: 12px; }
</style>
</head>
<body>
	<div class="doc-header">
		<h1>${escapeHtml(content.title)}</h1>
		<div class="doc-meta">${escapeHtml(content.docNumber)} · ${escapeHtml(content.docDate)}</div>
	</div>
	<p class="intro">${escapeHtml(content.intro)}</p>
	<table class="parties"><tbody>${content.parties.map(partyRowHtml).join('')}</tbody></table>
	${linesHtml}
	${noteHtml}
	<div class="signatures">
		${signers.map((party) => `<div class="signature-row">${signatureBlockHtml(party, content.docDate)}</div>`).join('')}
	</div>
	<div class="stamp">${escapeHtml(DEMO_NOTICE)}</div>
</body>
</html>`;
}

function renderPlainText(content: SyntheticDocumentContent): string {
	const lines: string[] = [
		content.title.toUpperCase(),
		`${content.docNumber} · ${content.docDate}`,
		''
	];

	lines.push(content.intro, '');
	lines.push('Стороны:');

	for (const party of content.parties) {
		const requisites = party.requisites === undefined ? '' : ` (${party.requisites})`;

		lines.push(`- ${party.role}: ${party.name}${requisites}`);
	}

	if (content.lines !== undefined && content.lines.length > 0) {
		lines.push('', 'Позиции:');

		for (const line of content.lines) {
			lines.push(`- ${line.label}: ${line.value}`);
		}
	}

	if (content.note !== undefined) {
		lines.push('', content.note);
	}

	const signers = content.parties.filter((party) => party.signer !== undefined);

	if (signers.length > 0) {
		lines.push('', 'Подписи:');

		for (const party of signers) {
			lines.push(`- ${party.role} (${party.signer}): ____________________  ${content.docDate}`);
		}
	}

	lines.push('', DEMO_NOTICE.toUpperCase());

	return lines.join('\n') + '\n';
}

/** Адрес маршрута службы: `GOTENBERG_URL` бывает и со слешем на конце, и без. */
function serviceEndpoint(serviceUrl: string, route: string): URL {
	return new URL(route, serviceUrl.endsWith('/') ? serviceUrl : `${serviceUrl}/`);
}

/**
 * Печатает готовую HTML-страницу в PDF. Ходит по сети, транзакции не держит.
 * Отказ службы — `DocumentConversionError`: что делать без PDF, решает
 * вызывающий (`renderSyntheticDocument` ниже, описания программ —
 * `scripts/seed/program-materials.ts`).
 */
export async function renderHtmlToPdf(html: string): Promise<Buffer> {
	const serviceUrl = getConfig().GOTENBERG_URL;
	const endpoint = serviceEndpoint(serviceUrl, 'forms/chromium/convert/html');

	const form = new FormData();

	form.append('files', new Blob([html], { type: 'text/html' }), PAGE_FILE_NAME);
	// Подвал не нужен, но маршрут ждёт его файл вместе со страницей.
	form.append(
		'files',
		new Blob(['<!doctype html><html><body></body></html>'], { type: 'text/html' }),
		FOOTER_FILE_NAME
	);
	form.append('paperWidth', PAGE_WIDTH_INCHES);
	form.append('paperHeight', PAGE_HEIGHT_INCHES);
	form.append('marginTop', '0.6');
	form.append('marginBottom', '0.6');
	form.append('marginLeft', '0.7');
	form.append('marginRight', '0.7');
	form.append('printBackground', 'true');

	let response: Response;

	try {
		response = await fetch(endpoint, {
			method: 'POST',
			body: form,
			signal: AbortSignal.timeout(RENDER_TIMEOUT_MS)
		});
	} catch (error) {
		throw new DocumentConversionError(
			`Служба печати в PDF недоступна или не ответила за ${RENDER_TIMEOUT_MS / 1000} с`,
			{ status: null, cause: error }
		);
	}

	if (!response.ok) {
		throw new DocumentConversionError(
			`Служба печати в PDF ответила ошибкой ${response.status}: ` +
				hideServiceAddresses(await response.text(), serviceUrl),
			{ status: response.status }
		);
	}

	const pdf = Buffer.from(await response.arrayBuffer());

	if (sniffDocumentMime(pdf) !== PDF_MIME) {
		throw new DocumentConversionError('Служба печати вернула не PDF', { status: response.status });
	}

	return pdf;
}

/**
 * Готовит байты синтетического документа: печатает содержательный PDF, а при
 * недоступной службе — тот же текст обычным файлом (`onFallback` получает
 * причину для лога заливки, как и у `generateAgreement`).
 */
export async function renderSyntheticDocument(
	content: SyntheticDocumentContent,
	onFallback: (message: string) => void
): Promise<{ mime: AllowedDocumentMime; bytes: Uint8Array }> {
	try {
		return { mime: PDF_MIME, bytes: await renderHtmlToPdf(renderContentHtml(content)) };
	} catch (error) {
		if (!(error instanceof DocumentConversionError)) {
			throw error;
		}

		onFallback(error.message);

		return { mime: 'text/plain', bytes: new TextEncoder().encode(renderPlainText(content)) };
	}
}
