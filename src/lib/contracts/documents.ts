/**
 * Документы взаимодействия: что загружают, что генерируют по шаблону и какие
 * факты по документу фиксируют.
 *
 * Файл неизменяем: новая редакция — это новая запись документа, а не правка
 * старой. Так подпись, хеш и даты согласования всегда описывают ровно тот файл,
 * который лежит на диске.
 */
import { z } from 'zod';
import { id, optionalId, optionalText, pageQuerySchema, requiredText, searchQuery } from './common';

/**
 * Три факта по документу фиксируются отдельно: согласован, утверждён, вступил
 * в силу. Это не стадии одного статуса — документ может быть согласован и не
 * утверждён, а дата вступления в силу вообще приходит из договора.
 */
export const DOCUMENT_STATUS_FACTS = ['agreed', 'approved', 'in_effect'] as const;

export type DocumentStatusFact = (typeof DOCUMENT_STATUS_FACTS)[number];

/** Что принимаем на загрузку. Всё остальное отклоняем на входе, а не на диске. */
export const ALLOWED_DOCUMENT_MIME_TYPES = [
	'application/pdf',
	'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
	'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
	'application/vnd.openxmlformats-officedocument.presentationml.presentation',
	'application/msword',
	'application/vnd.ms-excel',
	'image/png',
	'image/jpeg',
	'text/plain',
	'application/zip'
] as const;

/** Потолок размера файла: 25 МиБ. */
export const MAX_DOCUMENT_SIZE_BYTES = 25 * 1024 * 1024;

export const uploadDocumentSchema = z.object({
	/** Документ может жить вне взаимодействия — например, типовая форма. */
	interactionId: optionalId('Некорректный идентификатор взаимодействия'),
	/** Вид документа: соглашение, приказ, акт, отчёт. Справочник настраивается. */
	kind: requiredText(100, 'Укажите вид документа'),
	title: requiredText(300, 'Укажите название документа'),
	mime: z.enum(ALLOWED_DOCUMENT_MIME_TYPES, { error: 'Такой тип файла загрузить нельзя' }),
	sizeBytes: z
		.number({ error: 'Не удалось определить размер файла' })
		.int()
		.min(1, { error: 'Файл пустой' })
		.max(MAX_DOCUMENT_SIZE_BYTES, { error: 'Файл больше 25 МиБ' })
});

export const generateDocumentSchema = z.object({
	templateKey: requiredText(100, 'Выберите шаблон документа'),
	interactionId: id('Некорректный идентификатор взаимодействия'),
	/** Значения переменных шаблона; чего нет в шаблоне — отбрасывается. */
	variables: z.record(z.string(), z.string()).default({})
});

export const markDocumentStatusSchema = z.object({
	documentId: id('Некорректный идентификатор документа'),
	fact: z.enum(DOCUMENT_STATUS_FACTS, { error: 'Выберите, какой факт фиксируем' }),
	/**
	 * Дата факта. Согласование могло случиться раньше, чем до него дошли руки
	 * в системе, поэтому её можно указать, а не только «сейчас».
	 */
	at: z.iso.datetime({ offset: true, error: 'Дата указана неверно' }).nullable().default(null)
});

/** Переменная шаблона: что подставляем и обязательна ли она. */
export const documentTemplateVariableSchema = z.object({
	key: requiredText(100, 'У переменной шаблона должен быть ключ'),
	label: requiredText(200, 'У переменной шаблона должно быть название'),
	required: z.boolean().default(false)
});

export type DocumentTemplateVariable = z.output<typeof documentTemplateVariableSchema>;

export const documentListQuerySchema = z.object({
	interactionId: optionalId('Некорректный идентификатор взаимодействия'),
	kind: optionalText(100),
	q: searchQuery,
	...pageQuerySchema.shape
});

export type UploadDocumentInput = z.output<typeof uploadDocumentSchema>;
export type GenerateDocumentInput = z.output<typeof generateDocumentSchema>;
export type MarkDocumentStatusInput = z.output<typeof markDocumentStatusSchema>;
export type DocumentListQuery = z.output<typeof documentListQuerySchema>;

export type DocumentView = {
	id: string;
	interactionId: string | null;
	kind: string;
	title: string;
	mime: string;
	sizeBytes: number;
	sha256: string;
	uploadedBy: string | null;
	createdAt: Date;
	agreedAt: Date | null;
	approvedAt: Date | null;
	inEffectAt: Date | null;
};
