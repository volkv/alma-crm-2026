/**
 * Шаблоны документов: какие бывают и как файл из репозитория попадает в базу.
 *
 * Сам файл шаблона лежит в каталоге `templates/` рядом с кодом — он часть
 * поставки, его правят и ревьюят вместе с ней. В базе хранится не он, а его
 * копия в хранилище файлов: запись `document_templates` должна ссылаться на
 * неизменяемый файл, иначе уже сгенерированный документ невозможно объяснить —
 * шаблон под ним успели переписать.
 *
 * `ensureTemplateRegistered` переносит файл в хранилище при первом обращении и
 * сверяет его по sha256 при каждом следующем: содержимое изменилось — в базе
 * появляется новая версия того же ключа, и старый файл остаётся на месте.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import {
	DOCUMENT_TEMPLATE_LABELS,
	type DocumentTemplateKey,
	type DocumentTemplateVariable
} from '$lib/contracts/documents';
import type { ActorContext } from '../actor';
import { getDb } from '../db';
import { documentTemplates } from '../db/schema';
import { withTransaction } from '../db/transaction';
import { DOCX_MIME } from './mime';
import {
	discardStaged,
	promoteBlob,
	readStoredFile,
	sha256Hex,
	stageBlob,
	storedFileSha256
} from './storage';

/** Каталог с файлами шаблонов; путь — от рабочего каталога процесса. */
const TEMPLATE_SOURCE_DIR = 'templates';

type BuiltInTemplate = {
	name: string;
	/** Имя файла в каталоге `templates/`. */
	fileName: string;
	/**
	 * Теги, которые шаблон подставляет. Необязательных тегов нет: пустое поле
	 * в договоре — это дефект документа, а не «значение по умолчанию».
	 */
	variables: readonly DocumentTemplateVariable[];
};

/** Место и дата подписания — у каждого шаблона. */
const SIGNING: readonly DocumentTemplateVariable[] = [
	{ key: 'city', label: 'Город подписания', required: true },
	{ key: 'date', label: 'Дата подписания', required: true }
];

/** Оператор: наименование, реквизиты одной строкой на строку, подписант. */
const OPERATOR: readonly DocumentTemplateVariable[] = [
	{ key: 'operatorName', label: 'Оператор: полное наименование', required: true },
	{ key: 'operatorRequisites', label: 'Оператор: ИНН, КПП, ОГРН', required: true },
	{ key: 'operatorSigner', label: 'Оператор: подписант в родительном падеже', required: true }
];

function institution(role: string): DocumentTemplateVariable[] {
	return [
		{ key: 'institutionName', label: `${role}: полное наименование`, required: true },
		{ key: 'institutionRequisites', label: `${role}: ИНН, КПП, ОГРН`, required: true },
		{
			key: 'institutionSigner',
			label: `${role}: подписант в родительном падеже`,
			required: true
		}
	];
}

/** Заказчик коммерческого обучения — юридическое или физическое лицо. */
const CUSTOMER: readonly DocumentTemplateVariable[] = [
	{ key: 'customerName', label: 'Заказчик: полное наименование или ФИО', required: true },
	{ key: 'customerRequisites', label: 'Заказчик: реквизиты', required: true },
	{ key: 'customerSigner', label: 'Заказчик: подписант', required: true }
];

/** Что и когда изучают: программы и период обучения. */
const STUDY: readonly DocumentTemplateVariable[] = [
	{
		key: 'programs',
		label: 'Образовательные программы: список записей с полем name',
		required: true
	},
	{ key: 'periodStart', label: 'Начало обучения', required: true },
	{ key: 'periodEnd', label: 'Окончание обучения', required: true }
];

const CONTRACT_ITEMS: DocumentTemplateVariable = {
	key: 'items',
	label: 'Позиции договора: список записей с полями productName и licenseUntil',
	required: true
};

export const BUILT_IN_TEMPLATES: Record<DocumentTemplateKey, BuiltInTemplate> = {
	agreement: {
		name: DOCUMENT_TEMPLATE_LABELS.agreement,
		fileName: 'agreement.docx',
		variables: [
			{ key: 'city', label: 'Город подписания', required: true },
			{ key: 'date', label: 'Дата подписания', required: true },
			{ key: 'operatorName', label: 'Оператор: полное наименование', required: true },
			{
				key: 'operatorSigner',
				label: 'Оператор: подписант в родительном падеже',
				required: true
			},
			{
				key: 'institutionName',
				label: 'Образовательная организация: полное наименование',
				required: true
			},
			{
				key: 'institutionSigner',
				label: 'Образовательная организация: подписант в родительном падеже',
				required: true
			},
			{ key: 'customerName', label: 'Заказчик подготовки', required: true },
			{ key: 'periodStart', label: 'Начало срока действия', required: true },
			{ key: 'periodEnd', label: 'Окончание срока действия', required: true },
			{
				key: 'programs',
				label: 'Образовательные программы: список записей с полем name',
				required: true
			}
		]
	},
	sublicense: {
		name: DOCUMENT_TEMPLATE_LABELS.sublicense,
		fileName: 'sublicense.docx',
		variables: [
			...SIGNING,
			{ key: 'contractNumber', label: 'Номер договора', required: true },
			...OPERATOR,
			...institution('Сублицензиат'),
			CONTRACT_ITEMS
		]
	},
	handover_act: {
		name: DOCUMENT_TEMPLATE_LABELS.handover_act,
		fileName: 'handover-act.docx',
		variables: [
			...SIGNING,
			{ key: 'contractNumber', label: 'Номер договора', required: true },
			{ key: 'contractSignedOn', label: 'Дата подписания договора', required: true },
			...OPERATOR,
			...institution('Сублицензиат'),
			CONTRACT_ITEMS
		]
	},
	offer: {
		name: DOCUMENT_TEMPLATE_LABELS.offer,
		fileName: 'offer.docx',
		variables: [
			...SIGNING,
			...OPERATOR,
			{ key: 'learnerName', label: 'Слушатель: фамилия, имя, отчество', required: true },
			{ key: 'learnerSigner', label: 'Слушатель: фамилия и инициалы', required: true },
			...STUDY
		]
	},
	legal_entity_contract: {
		name: DOCUMENT_TEMPLATE_LABELS.legal_entity_contract,
		fileName: 'legal-entity-contract.docx',
		variables: [...SIGNING, ...OPERATOR, ...CUSTOMER, ...STUDY]
	},
	services_act: {
		name: DOCUMENT_TEMPLATE_LABELS.services_act,
		fileName: 'services-act.docx',
		variables: [...SIGNING, ...OPERATOR, ...CUSTOMER, ...STUDY]
	}
};

export function isDocumentTemplateKey(value: string): value is DocumentTemplateKey {
	return value in BUILT_IN_TEMPLATES;
}

/** Шаблон в том виде, в каком он записан в базе. */
export type DocumentTemplateRecord = {
	id: string;
	key: DocumentTemplateKey;
	name: string;
	/** Путь к файлу шаблона относительно каталога данных. */
	filePath: string;
	version: number;
	variables: DocumentTemplateVariable[];
};

function toRecord(
	row: typeof documentTemplates.$inferSelect,
	key: DocumentTemplateKey
): DocumentTemplateRecord {
	return {
		id: row.id,
		key,
		name: row.name,
		filePath: row.filePath,
		version: row.version,
		variables: row.variables
	};
}

async function readTemplateSource(fileName: string): Promise<Buffer> {
	const path = resolve(process.cwd(), TEMPLATE_SOURCE_DIR, fileName);

	try {
		return await readFile(path);
	} catch (error) {
		throw new Error(`Файл шаблона «${fileName}» не найден: ожидался ${path}`, { cause: error });
	}
}

/**
 * Запись шаблона в базе, соответствующая файлу в поставке. Операция
 * идемпотентна: пока файл не менялся, второй вызов ничего не пишет.
 */
export async function ensureTemplateRegistered(
	ctx: ActorContext,
	key: DocumentTemplateKey
): Promise<DocumentTemplateRecord> {
	const builtIn = BUILT_IN_TEMPLATES[key];
	const source = await readTemplateSource(builtIn.fileName);

	const [existing] = await getDb()
		.select()
		.from(documentTemplates)
		.where(eq(documentTemplates.key, key))
		.limit(1);

	// Файла в хранилище может не быть — например, бакет завели заново при
	// переезде. Тогда запись считается неактуальной и перерегистрируется.
	if (existing !== undefined && (await storedFileSha256(existing.filePath)) === sha256Hex(source)) {
		return toRecord(existing, key);
	}

	const staged = await stageBlob(source, DOCX_MIME);
	const variables = [...builtIn.variables];

	try {
		return await withTransaction(ctx, async (tx) => {
			await promoteBlob(staged);

			const [row] = await tx
				.insert(documentTemplates)
				.values({
					key,
					name: builtIn.name,
					filePath: staged.relativePath,
					version: (existing?.version ?? 0) + 1,
					variables
				})
				.onConflictDoUpdate({
					target: documentTemplates.key,
					set: {
						name: builtIn.name,
						filePath: staged.relativePath,
						version: sql`${documentTemplates.version} + 1`,
						variables,
						updatedAt: new Date()
					}
				})
				.returning();

			return toRecord(row, key);
		});
	} catch (error) {
		await discardStaged([staged], error);
		throw error;
	}
}

/** Запись шаблона вместе с содержимым файла — то, что нужно генератору. */
export async function loadTemplate(
	ctx: ActorContext,
	key: DocumentTemplateKey
): Promise<{ record: DocumentTemplateRecord; content: Buffer }> {
	const record = await ensureTemplateRegistered(ctx, key);

	return { record, content: await readStoredFile(record.filePath) };
}
