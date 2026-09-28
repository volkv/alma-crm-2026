/**
 * Материалы программ демонстрационного стенда: у каждой программы справочника —
 * PDF «Описание программы» с целями, слушателями, модулями и часами, форматом,
 * итоговой аттестацией и тем, что получает учебное заведение. Без него письмо
 * вузу «информация о программах» из карточки дела ушло бы на стенде без
 * вложений, а раздел материалов на карточке программы пустовал бы.
 *
 * Файл — обычный материал программы, ровно такой, какой положила бы загрузка
 * на карточке (`$lib/server/directory/program-materials.ts`): строка
 * `documents` без взаимодействия с видом `PROGRAM_MATERIAL_DOCUMENT_KIND`,
 * объект хранилища по тому же протоколу `stageBlob` → `promoteBlob` → запись и
 * связь `program_documents`. Сервис загрузки сид не зовёт: тот заводит документ
 * со случайным идентификатором, а сиду нужен вычисляемый — по нему повторный
 * запуск узнаёт уже собранный материал и не печатает его второй раз.
 *
 * Идёт отдельным шагом после транзакции справочников, а не внутри неё: печать и
 * хранилище — чужие службы по сети, и транзакции, которая держит весь
 * справочник, ждать их незачем. Программы к этому моменту уже зафиксированы.
 *
 * Запасной путь при недоступном Gotenberg здесь другой, чем у документов дел:
 * текстовый файл материалом программы быть не может (материал — PDF или DOCX,
 * он уходит вузу вложением), поэтому материал без печати просто не заводится,
 * а следующий запуск сида соберёт то, чего не хватает. Заливку отказ не роняет.
 */
import { inArray } from 'drizzle-orm';
import { PROGRAM_LEVEL_LABELS } from '$lib/components/directory/labels';
import { PROGRAM_MATERIAL_DOCUMENT_KIND } from '$lib/contracts/documents';
import { formatDate, pluralize } from '$lib/format';
import { getDb } from '$lib/server/db';
import { documents, programDocuments } from '$lib/server/db/schema';
import { DocumentConversionError } from '$lib/server/documents/errors';
import { PDF_MIME } from '$lib/server/documents/mime';
import { discardStaged, promoteBlob, stageBlob } from '$lib/server/documents/storage';
import { PROGRAM_MATERIAL_SEEDS, type ProgramMaterialSeed } from './directory';
import { DEMO_NOTICE, escapeHtml, renderHtmlToPdf } from './documents';
import { seedId } from './ids';

const HOURS_FORMS = ['академический час', 'академических часа', 'академических часов'] as const;

/** Название материала: оно же имя файла без расширения (`documentFileName`). */
export function programMaterialTitle(seed: Pick<ProgramMaterialSeed, 'code' | 'name'>): string {
	return `${seed.code} ${seed.name}`;
}

function totalHours(seed: ProgramMaterialSeed): number {
	return seed.brochure.modules.reduce((total, module) => total + module.hours, 0);
}

function listHtml(items: readonly string[]): string {
	return `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
}

function renderMaterialHtml(seed: ProgramMaterialSeed): string {
	const { brochure } = seed;
	const hours = totalHours(seed);

	const facts: { label: string; value: string }[] = [
		{ label: 'Уровень', value: PROGRAM_LEVEL_LABELS[seed.level] },
		...(seed.directionCode === null
			? []
			: [{ label: 'Направление подготовки', value: seed.directionCode }]),
		{ label: 'ИТ-направление', value: seed.itDirection },
		{ label: 'Объём', value: pluralize(hours, HOURS_FORMS) },
		{
			label: 'Редакция',
			value: `${seed.version.number} от ${formatDate(seed.version.effectiveFrom)}`
		}
	];

	// Лицензии продуктов — первой строкой того, что получает вуз: ради них
	// программу и ведут на продуктах оператора.
	const institutionGets = [
		...seed.products.map(
			(product) =>
				`Учебные лицензии «${product.name}» на срок реализации программы — ${product.description.charAt(0).toLowerCase()}${product.description.slice(1)}`
		),
		...brochure.institutionGets
	];

	const modulesHtml = brochure.modules
		.map(
			(module, index) =>
				`<tr><td class="num">${index + 1}</td><td>${escapeHtml(module.name)}</td><td class="hours">${module.hours}</td></tr>`
		)
		.join('');

	return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8" />
<style>
	* { box-sizing: border-box; }
	body {
		font-family: "Segoe UI", Roboto, Arial, sans-serif;
		color: #1f1f1f;
		font-size: 12.5px;
		line-height: 1.5;
		margin: 0;
	}
	.brand {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		border-bottom: 3px solid #7700ff;
		padding-bottom: 6px;
		margin-bottom: 18px;
		font-size: 11px;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: #5a5a5a;
	}
	.brand strong { color: #7700ff; }
	h1 { font-size: 20px; margin: 0 0 4px; line-height: 1.25; }
	.code { color: #ff4f12; font-weight: 700; font-size: 13px; margin-bottom: 14px; }
	h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.03em; color: #7700ff; margin: 18px 0 6px; }
	p { margin: 0 0 8px; }
	ul { margin: 0; padding-left: 18px; }
	li { margin-bottom: 3px; }
	table { width: 100%; border-collapse: collapse; }
	.facts td { padding: 4px 8px; border-bottom: 1px solid #e3e3e3; vertical-align: top; }
	.facts td:first-child { width: 34%; color: #5a5a5a; }
	.modules th, .modules td { border: 1px solid #d6d6d6; padding: 5px 8px; text-align: left; }
	.modules th { background: #f3edff; font-weight: 600; }
	.modules .num { width: 6%; text-align: center; }
	.modules .hours { width: 14%; text-align: right; }
	.modules tfoot td { font-weight: 700; background: #fafafa; }
	.version { color: #5a5a5a; font-size: 11.5px; margin-top: 14px; }
	.stamp { margin-top: 24px; border: 2px solid #b00020; color: #b00020; padding: 8px 12px; text-align: center; font-weight: 700; letter-spacing: 0.03em; text-transform: uppercase; font-size: 11px; page-break-inside: avoid; }
	section { page-break-inside: avoid; }
</style>
</head>
<body>
	<div class="brand"><strong>ИТ Школа Ростелекома</strong><span>Описание программы</span></div>
	<h1>${escapeHtml(seed.name)}</h1>
	<div class="code">${escapeHtml(seed.code)}</div>
	<table class="facts"><tbody>${facts
		.map((fact) => `<tr><td>${escapeHtml(fact.label)}</td><td>${escapeHtml(fact.value)}</td></tr>`)
		.join('')}</tbody></table>
	<section><h2>О программе</h2><p>${escapeHtml(seed.description)}</p></section>
	<section><h2>Цели</h2>${listHtml(brochure.goals)}</section>
	<section><h2>Для кого</h2><p>${escapeHtml(brochure.audience)}</p></section>
	<section>
		<h2>Структура программы</h2>
		<table class="modules">
			<thead><tr><th class="num">№</th><th>Модуль</th><th class="hours">Часы</th></tr></thead>
			<tbody>${modulesHtml}</tbody>
			<tfoot><tr><td></td><td>Итого</td><td class="hours">${hours}</td></tr></tfoot>
		</table>
	</section>
	<section><h2>Формат обучения</h2><p>${escapeHtml(brochure.format)}</p></section>
	<section><h2>Итоговая аттестация</h2><p>${escapeHtml(brochure.assessment)}</p></section>
	<section><h2>Что получает учебное заведение</h2>${listHtml(institutionGets)}</section>
	<p class="version">Редакция ${seed.version.number} от ${escapeHtml(formatDate(seed.version.effectiveFrom))}: ${escapeHtml(seed.version.summary)}</p>
	<div class="stamp">${escapeHtml(DEMO_NOTICE)}</div>
</body>
</html>`;
}

/**
 * Печатает материал программы. Отдельной функцией, чтобы печать можно было
 * проверить без базы и хранилища.
 */
export async function renderProgramMaterial(seed: ProgramMaterialSeed): Promise<Buffer> {
	return renderHtmlToPdf(renderMaterialHtml(seed));
}

/**
 * Заводит недостающие материалы программ. Уже заведённый материал (по
 * вычисляемому идентификатору документа) не трогает: ни перепечатки, ни
 * восстановления снятой на стенде связи — правка показа переживает перезапуск,
 * как и у остального справочника. Возвращает число заведённых материалов.
 */
export async function seedProgramMaterials(options: { authorUserId: string }): Promise<number> {
	const db = getDb();
	const ids = PROGRAM_MATERIAL_SEEDS.map((seed) => seedId('program-material', seed.key));
	const existing = new Set(
		(await db.select({ id: documents.id }).from(documents).where(inArray(documents.id, ids))).map(
			(row) => row.id
		)
	);

	let created = 0;

	for (const seed of PROGRAM_MATERIAL_SEEDS) {
		const documentId = seedId('program-material', seed.key);

		if (existing.has(documentId)) {
			continue;
		}

		let pdf: Buffer;

		try {
			pdf = await renderProgramMaterial(seed);
		} catch (error) {
			if (!(error instanceof DocumentConversionError)) {
				throw error;
			}

			console.log(
				`seed: описание программы ${seed.code} не собрано — служба печати в PDF недоступна (${error.message}); его соберёт следующий запуск сида`
			);
			continue;
		}

		const blob = await stageBlob(pdf, PDF_MIME);

		try {
			const inserted = await db.transaction(async (tx) => {
				const rows = await tx
					.insert(documents)
					.values({
						id: documentId,
						interactionId: null,
						kind: PROGRAM_MATERIAL_DOCUMENT_KIND,
						title: programMaterialTitle(seed),
						filePath: blob.relativePath,
						mime: blob.mime,
						sizeBytes: blob.sizeBytes,
						sha256: blob.sha256,
						uploadedBy: options.authorUserId
					})
					.onConflictDoNothing({ target: documents.id })
					.returning({ id: documents.id });

				// Материал успела завести параллельная заливка: её файл уже на
				// месте, а свой объект — мусор, который убирается ниже.
				if (rows.length === 0) {
					return false;
				}

				// Перенос — внутри транзакции: не удался он — не будет и записи,
				// которая ссылалась бы на файл, которого нет.
				await promoteBlob(blob);
				await tx
					.insert(programDocuments)
					.values({ programId: seedId('program', seed.key), documentId })
					.onConflictDoNothing();

				return true;
			});

			if (!inserted) {
				await discardStaged([blob], null);
				continue;
			}
		} catch (error) {
			await discardStaged([blob], error);
			throw error;
		}

		created += 1;
	}

	return created;
}
