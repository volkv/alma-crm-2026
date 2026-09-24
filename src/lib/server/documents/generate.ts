/**
 * Генерация документов по шаблонам.
 *
 * DOCX собирается docxtemplater'ом прямо в памяти, PDF получается из него
 * конвертацией в Gotenberg — LibreOffice в контейнере. Своего рендерера PDF
 * здесь нет намеренно: документ обязан выглядеть одинаково в обоих форматах,
 * а единственный способ это обеспечить — печатать PDF из того же DOCX.
 *
 * Порядок шагов важен: сначала рендер и конвертация, и только потом
 * транзакция. Конвертация ходит по сети и может занять секунды — держать всё
 * это время открытую транзакцию значит держать блокировки из-за чужой службы.
 */
import { and, eq, inArray } from 'drizzle-orm';
import Docxtemplater from 'docxtemplater';
import PizZip from 'pizzip';
import type { AuditDetails } from '$lib/contracts/audit';
import type { DocumentView } from '$lib/contracts/documents';
import type { ActorContext } from '../actor';
import { recordAuditEvent } from '../audit';
import { getConfig } from '../config';
import { getDb } from '../db';
import { documentContractItems, documents, interactionContractItems } from '../db/schema';
import { withTransaction, type Tx } from '../db/transaction';
import { publishAfterCommit } from '../live/publish';
import { ValidationError } from '../errors';
import { requirePermission } from '../rbac';
import { assertTemplateOffered } from '../stages/card';
import { touchInteraction } from '../stages/commands';
import { DocumentConversionError, hideServiceAddresses } from './errors';
import { DOCX_MIME, PDF_MIME, sniffDocumentMime, type AllowedDocumentMime } from './mime';
import { assertInteractionAccessible, toDocumentView } from './read';
import { discardStaged, promoteBlob, stageBlob, type StagedBlob } from './storage';
import { isDocumentTemplateKey, loadTemplate } from './templates';

/**
 * Значение, которое можно подставить в шаблон. Список (`readonly TemplateValue[]`)
 * — это цикл `{#key}…{/key}`, вложенный объект — область внутри цикла.
 */
export type TemplateValue =
	string | number | boolean | readonly TemplateValue[] | { readonly [key: string]: TemplateValue };

export type TemplateData = { readonly [key: string]: TemplateValue };

export const DOCUMENT_FORMATS = ['docx', 'pdf'] as const;

export type DocumentFormat = (typeof DOCUMENT_FORMATS)[number];

export type GenerateDocumentCommand = {
	/** Ключ шаблона из `BUILT_IN_TEMPLATES`. */
	templateKey: string;
	/** Документ может жить и вне взаимодействия — например, типовая форма. */
	interactionId?: string | null;
	/** Значения тегов шаблона. */
	data: TemplateData;
	title: string;
	/** Какие форматы нужны; на каждый создаётся своя запись документа. */
	formats: readonly DocumentFormat[];
	/**
	 * Позиции договора, которые передаёт документ (акт передачи). Связь ложится
	 * на каждую созданную запись; позиции обязаны быть выбраны взаимодействием.
	 */
	contractItemIds?: readonly string[];
};

/** Вид документа, который записывается в `documents.kind` для сгенерированных файлов. */
const GENERATED_KIND = 'generated';

/** Потолок ожидания Gotenberg. LibreOffice запускается не мгновенно, но и не полминуты. */
const CONVERSION_TIMEOUT_MS = 30_000;

/** Имя, под которым файл уходит в Gotenberg: по расширению он выбирает конвертер. */
const CONVERSION_FILE_NAME = 'document.docx';

/** Претензия из ошибки docxtemplater в виде, пригодном для показа человеку. */
function describeTemplateIssue(issue: unknown): string {
	const explanation = (issue as { properties?: { explanation?: unknown } } | null)?.properties
		?.explanation;

	if (typeof explanation === 'string' && explanation !== '') {
		return explanation;
	}

	const message = (issue as { message?: unknown } | null)?.message;

	return typeof message === 'string' ? message : String(issue);
}

function templateIssues(error: unknown): string[] {
	const nested = (error as { properties?: { errors?: unknown } } | null)?.properties?.errors;

	if (Array.isArray(nested) && nested.length > 0) {
		return nested.map(describeTemplateIssue);
	}

	return [describeTemplateIssue(error)];
}

/**
 * Обёртка вокруг docxtemplater: его ошибки — это ошибки шаблона или данных,
 * то есть `ValidationError`, а не отказ сервера.
 */
function runTemplateEngine<TResult>(action: () => TResult): TResult {
	try {
		return action();
	} catch (error) {
		throw new ValidationError('Шаблон документа не удалось заполнить', templateIssues(error));
	}
}

/**
 * Заполняет шаблон. Тег, которому не нашлось значения, — ошибка: пустая строка
 * в договоре выглядит как осознанное «не применимо», хотя на деле это потеря
 * данных.
 */
function renderTemplate(template: Buffer, data: TemplateData): Buffer {
	const unresolved = new Set<string>();

	const rendered = runTemplateEngine(() => {
		const document = new Docxtemplater(new PizZip(template), {
			// Цикл, занимающий целые абзацы, не оставляет после себя пустых строк.
			paragraphLoop: true,
			// Переводы строк в значениях становятся переводами строк в документе.
			linebreaks: true,
			errorLogging: false,
			nullGetter: (part) => {
				// У простого тега нет модуля. У цикла он есть, и пустое значение для
				// цикла — это законные ноль повторений, а не потерянные данные.
				if (!part.module) {
					unresolved.add(part.value);
				}

				return '';
			}
		});

		document.render(data);

		return document.toBuffer();
	});

	if (unresolved.size > 0) {
		throw new ValidationError('В данных нет значений для тегов шаблона', [...unresolved].sort());
	}

	return rendered;
}

/** Преобразует DOCX в PDF через Gotenberg. Ходит по сети, транзакции не держит. */
async function convertToPdf(docx: Buffer): Promise<Buffer> {
	const serviceUrl = getConfig().GOTENBERG_URL;
	const endpoint = new URL(
		'forms/libreoffice/convert',
		serviceUrl.endsWith('/') ? serviceUrl : `${serviceUrl}/`
	);

	const form = new FormData();
	// `Buffer` берёт память из общего пула, поэтому его `ArrayBuffer` шире самого
	// значения; `Blob` требует буфер, равный данным, — отсюда копия.
	form.append('files', new Blob([new Uint8Array(docx)], { type: DOCX_MIME }), CONVERSION_FILE_NAME);

	let response: Response;

	try {
		response = await fetch(endpoint, {
			method: 'POST',
			body: form,
			signal: AbortSignal.timeout(CONVERSION_TIMEOUT_MS)
		});
	} catch (error) {
		throw new DocumentConversionError(
			`Служба преобразования в PDF недоступна или не ответила за ${CONVERSION_TIMEOUT_MS / 1000} с`,
			{ status: null, cause: error }
		);
	}

	if (!response.ok) {
		throw new DocumentConversionError(
			`Служба преобразования в PDF ответила ошибкой ${response.status}: ` +
				hideServiceAddresses(await response.text(), serviceUrl),
			{ status: response.status }
		);
	}

	const pdf = Buffer.from(await response.arrayBuffer());

	if (sniffDocumentMime(pdf) !== PDF_MIME) {
		throw new DocumentConversionError('Служба преобразования вернула не PDF', {
			status: response.status
		});
	}

	return pdf;
}

/**
 * Позиции, которые документ передаёт, должны быть выбраны самим
 * взаимодействием: акт по чужой позиции перевёл бы в «передан» продукт другого
 * дела. Проверка в транзакции записи — выбор позиций правят параллельно.
 */
async function assertItemsChosen(
	tx: Tx,
	interactionId: string,
	contractItemIds: readonly string[]
): Promise<void> {
	if (contractItemIds.length === 0) {
		return;
	}

	const chosen = await tx
		.select({ id: interactionContractItems.contractItemId })
		.from(interactionContractItems)
		.where(
			and(
				eq(interactionContractItems.interactionId, interactionId),
				inArray(interactionContractItems.contractItemId, [...contractItemIds])
			)
		);

	if (chosen.length !== contractItemIds.length) {
		throw new ValidationError('Позиции договора не выбраны в этом взаимодействии', [
			'Выберите позиции в панели «Договор» и соберите документ заново'
		]);
	}
}

/**
 * Создаёт документы по шаблону — по одному на каждый запрошенный формат.
 * Возвращает их в том же порядке, в каком перечислены форматы в
 * {@link DOCUMENT_FORMATS}.
 */
export async function generateDocument(
	ctx: ActorContext,
	input: GenerateDocumentCommand
): Promise<DocumentView[]> {
	requirePermission(ctx, 'documents.generate');

	if (!isDocumentTemplateKey(input.templateKey)) {
		throw new ValidationError('Такого шаблона нет', [
			`Шаблон «${input.templateKey}» не описан в системе`
		]);
	}

	const title = input.title.trim();

	if (title === '') {
		throw new ValidationError('Укажите название документа', [
			'Название документа не может быть пустым'
		]);
	}

	const formats = DOCUMENT_FORMATS.filter((format) => input.formats.includes(format));

	if (formats.length === 0) {
		throw new ValidationError('Выберите формат документа', [
			`Допустимые форматы: ${DOCUMENT_FORMATS.join(', ')}`
		]);
	}

	const interactionId = input.interactionId ?? null;
	const contractItemIds = [...new Set(input.contractItemIds ?? [])];

	if (contractItemIds.length > 0 && interactionId === null) {
		throw new ValidationError('Позиции договора передаёт только документ взаимодействия');
	}

	if (interactionId !== null) {
		await assertInteractionAccessible(ctx, interactionId);
		// Какие документы собираются в деле, решает его процесс: соглашение с
		// вузом в карточке обучения физического лица — ошибка, а не выбор.
		await assertTemplateOffered(getDb(), interactionId, input.templateKey);
	}

	const { record, content } = await loadTemplate(ctx, input.templateKey);

	const missingRequired = record.variables
		.filter((variable) => variable.required && !(variable.key in input.data))
		.map((variable) => variable.key);

	if (missingRequired.length > 0) {
		throw new ValidationError('Не заполнены обязательные поля шаблона', missingRequired);
	}

	const docx = renderTemplate(content, input.data);
	const outputs: { bytes: Buffer; mime: AllowedDocumentMime }[] = [];

	for (const format of formats) {
		outputs.push(
			format === 'docx'
				? { bytes: docx, mime: DOCX_MIME }
				: { bytes: await convertToPdf(docx), mime: PDF_MIME }
		);
	}

	const staged: StagedBlob[] = [];

	try {
		for (const output of outputs) {
			staged.push(await stageBlob(output.bytes, output.mime));
		}

		return await withTransaction(ctx, async (tx) => {
			const views: DocumentView[] = [];

			if (interactionId !== null) {
				await assertItemsChosen(tx, interactionId, contractItemIds);
				await touchInteraction(tx, interactionId);
				publishAfterCommit(tx, interactionId, { type: 'interaction.changed' });
			}

			for (const blob of staged) {
				await promoteBlob(blob);

				const [row] = await tx
					.insert(documents)
					.values({
						interactionId,
						kind: GENERATED_KIND,
						title,
						filePath: blob.relativePath,
						mime: blob.mime,
						sizeBytes: blob.sizeBytes,
						sha256: blob.sha256,
						uploadedBy: ctx.user?.id ?? null
					})
					.returning();

				if (contractItemIds.length > 0) {
					await tx
						.insert(documentContractItems)
						.values(
							contractItemIds.map((contractItemId) => ({ documentId: row.id, contractItemId }))
						);
				}

				// Ключ шаблона в журнал не положить: в подробностях события
				// допустимы только ссылки на записи, поэтому пишется идентификатор.
				const details: AuditDetails = { templateId: record.id, documentId: row.id };

				if (interactionId !== null) {
					details.interactionId = interactionId;
				}

				await recordAuditEvent(
					ctx,
					{
						type: 'documents.generated',
						outcome: 'success',
						subject: { type: 'document', id: row.id },
						details
					},
					tx
				);

				views.push(toDocumentView(row));
			}

			return views;
		});
	} catch (error) {
		await discardStaged(staged, error);
		throw error;
	}
}
