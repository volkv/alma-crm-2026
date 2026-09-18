/**
 * Документы взаимодействия: что загружают, что генерируют по шаблону и какие
 * факты по документу фиксируют.
 *
 * Файл неизменяем: новая редакция — это новая запись документа, а не правка
 * старой. Так подпись, хеш и даты согласования всегда описывают ровно тот файл,
 * который лежит на диске.
 */
import { z } from 'zod';
import { moscowDay, moscowDayStart } from './calendar';
import { id, optionalId, pageQuerySchema, requiredText, searchQuery } from './common';

/**
 * Три факта по документу фиксируются отдельно: согласован, утверждён, вступил
 * в силу. Это не стадии одного статуса — документ может быть согласован и не
 * утверждён, а дата вступления в силу вообще приходит из договора.
 */
export const DOCUMENT_STATUS_FACTS = ['agreed', 'approved', 'in_effect'] as const;

export type DocumentStatusFact = (typeof DOCUMENT_STATUS_FACTS)[number];

/**
 * Названия отметок. Код едет в базу и в журнал, а на экран выходит название —
 * и оно одно на список, карточку документа, панель дела и фильтр раздела:
 * «Утверждён» в одном месте и «Утверждено» в другом читаются как две разных
 * отметки.
 */
export const DOCUMENT_STATUS_FACT_LABELS: Record<DocumentStatusFact, string> = {
	agreed: 'Согласован',
	approved: 'Утверждён',
	in_effect: 'Введён в действие'
};

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
	'application/zip',
	// Архивы, названные в задании рядом с zip. Содержимое не разбирается:
	// распаковка произвольного архива на сервере — работа, объём которой заранее
	// не ограничить. Границы — сигнатура и потолок размера.
	'application/gzip',
	'application/vnd.rar'
] as const;

/** Потолок размера файла: 25 МиБ. */
export const MAX_DOCUMENT_SIZE_BYTES = 25 * 1024 * 1024;

export const uploadDocumentSchema = z.object({
	/** Документ может жить вне взаимодействия — например, типовая форма. */
	interactionId: optionalId('Некорректный идентификатор взаимодействия'),
	/**
	 * Редакция, которую заменяет загружаемый файл. Вид, название и
	 * взаимодействие новая редакция берёт у неё: это тот же документ в новой
	 * редакции, а не второй документ рядом.
	 */
	supersedesId: optionalId('Некорректный идентификатор заменяемой редакции'),
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
	 * День факта — календарный, `2026-09-17`. Согласование могло случиться
	 * раньше, чем до него дошли руки в системе, поэтому день можно назвать, а не
	 * только поставить отметку «сейчас». Часа у отметки нет и в договоре:
	 * согласовывают днём, а не минутой.
	 */
	at: z.iso.date({ error: 'Дата указана неверно' }).nullable().default(null)
});

/**
 * Границы дня отметки: не раньше дня, когда документ появился в системе, и не
 * позже сегодняшнего. Обе границы считаются по московскому календарю — по нему
 * же живут сроки процесса.
 */
export type MarkDayBounds = { min: string; max: string };

export function markDayBounds(createdAt: Date, now: Date = new Date()): MarkDayBounds {
	return { min: moscowDay(createdAt), max: moscowDay(now) };
}

/**
 * Что не так с выбранным днём отметки; `null` — день подходит.
 *
 * Правило одно на форму и на сервис: форма подставляет эти же границы в
 * календарь, а последнее слово остаётся за сервисом. Два свода правил — на
 * клиенте и на сервере — однажды разойдутся, и разойдутся молча.
 */
export function markDayIssue(day: string, bounds: MarkDayBounds): string | null {
	if (day > bounds.max) {
		return 'Отметка не может быть позже сегодняшнего дня: факта, которого ещё не было, не бывает';
	}

	if (day < bounds.min) {
		return 'Отметка не может быть раньше дня, когда документ появился в системе';
	}

	return null;
}

/**
 * Момент отметки по выбранному дню.
 *
 * Сегодняшний день — это «сейчас»: время известно, и терять его незачем.
 * Прошлый день — его начало по Москве: часа, в который случился факт, не знает
 * никто, а придуманный час выглядел бы в карточке как записанный.
 */
export function markMomentFromDay(day: string, now: Date = new Date()): Date {
	return moscowDay(now) === day ? now : moscowDayStart(day);
}

/** Переменная шаблона: что подставляем и обязательна ли она. */
export const documentTemplateVariableSchema = z.object({
	key: requiredText(100, 'У переменной шаблона должен быть ключ'),
	label: requiredText(200, 'У переменной шаблона должно быть название'),
	required: z.boolean().default(false)
});

export type DocumentTemplateVariable = z.output<typeof documentTemplateVariableSchema>;

/**
 * Метка вида, под которой генерация записывает свои файлы в `documents.kind`.
 * Отдельного столбца «откуда взялся файл» в схеме нет, и эта метка — всё, что
 * отличает собранный по шаблону документ от загруженного руками.
 */
export const GENERATED_DOCUMENT_KIND = 'generated';

/**
 * Метка вида для файла, приложенного к переходу по стадии.
 *
 * Такой файл не выбирают из справочника видов: его прикладывают прямо в диалоге
 * перехода, и вид ему ставит приложение. Метка живёт здесь по той же причине,
 * что и `generated`, — её пишет наш код, значит и название для человека у неё
 * обязано быть, а не код из базы на экране.
 */
export const STAGE_ATTACHMENT_DOCUMENT_KIND = 'stage_attachment';

/**
 * Вид документа в списке: загружен человеком или собран по шаблону.
 *
 * У загруженного файла в `documents.kind` лежит вид, который назвал человек
 * («соглашение», «акт»), у собранного — метка `generated`. Значит, «вид» в
 * списке — это ответ на вопрос «откуда файл», а названный человеком вид
 * показывается рядом с названием отдельно.
 */
export const DOCUMENT_KINDS = ['uploaded', 'generated'] as const;

export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

/** Откуда файл — словами. */
export const DOCUMENT_ORIGIN_LABELS: Record<DocumentKind, string> = {
	uploaded: 'Загружен',
	generated: 'Сгенерирован'
};

/**
 * Виды документа, которые человек выбирает при загрузке.
 *
 * Справочник закрытый и живёт здесь, а не в свободной строке: «соглашение»,
 * «Соглашение» и «agreement», введённые тремя руками, — три разных вида, и
 * отчёт «сколько актов ещё не подписано» по ним не собрать. Код остаётся
 * латиницей (он едет в `documents.kind` и в журнал), а на экран выходит
 * название из `DOCUMENT_KIND_LABELS`.
 */
export const UPLOADED_DOCUMENT_KINDS = [
	'agreement',
	'annex',
	'order',
	'act',
	'report',
	'letter',
	'other'
] as const;

export type UploadedDocumentKind = (typeof UPLOADED_DOCUMENT_KINDS)[number];

/** Виды, которые ставит само приложение: их не выбирают руками. */
export type SystemDocumentKind =
	typeof GENERATED_DOCUMENT_KIND | typeof STAGE_ATTACHMENT_DOCUMENT_KIND;

/**
 * Русские названия видов. Виды, которые ставит приложение, стоят в том же ряду:
 * в `documents.kind` у них метка (`generated`, `stage_attachment`), и человеку
 * она видна как вид — значит, и читаться должна словами.
 */
export const DOCUMENT_KIND_LABELS: Record<UploadedDocumentKind | SystemDocumentKind, string> = {
	agreement: 'Соглашение',
	annex: 'Приложение к соглашению',
	order: 'Приказ',
	act: 'Акт',
	report: 'Отчёт',
	letter: 'Письмо',
	other: 'Другое',
	generated: 'Собран по шаблону',
	stage_attachment: 'Вложение к переходу'
};

/**
 * Название вида для показа. Вид пришёл не из справочника — печатается как
 * записан: придумывать название за того, кто завёл документ до появления
 * справочника, значит показывать не то, что лежит в базе.
 */
export function documentKindLabel(kind: string): string {
	return kind in DOCUMENT_KIND_LABELS
		? DOCUMENT_KIND_LABELS[kind as UploadedDocumentKind | SystemDocumentKind]
		: kind;
}

/**
 * Формат файла: то, что человек называет словом «DOCX», и тип, которым он
 * записан. Тип в базе — произвольная строка, поэтому соответствие объявлено
 * явно, а неизвестный тип формата не получает вовсе.
 */
export const DOCUMENT_FORMAT_MIME_TYPES = {
	pdf: 'application/pdf',
	docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
	xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
	pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
	doc: 'application/msword',
	xls: 'application/vnd.ms-excel',
	png: 'image/png',
	jpeg: 'image/jpeg',
	txt: 'text/plain',
	zip: 'application/zip'
} as const satisfies Record<string, (typeof ALLOWED_DOCUMENT_MIME_TYPES)[number]>;

export type DocumentFormat = keyof typeof DOCUMENT_FORMAT_MIME_TYPES;

export const DOCUMENT_FORMATS = Object.keys(DOCUMENT_FORMAT_MIME_TYPES) as DocumentFormat[];

/** Формат по типу файла или `null`, если тип неизвестен. */
export function documentFormat(mime: string): DocumentFormat | null {
	return DOCUMENT_FORMATS.find((format) => DOCUMENT_FORMAT_MIME_TYPES[format] === mime) ?? null;
}

/**
 * Отбор по редакциям. По умолчанию раздел показывает только действующие: файл
 * неизменяем, и заменённая редакция остаётся в базе навсегда — без отбора
 * список соглашения из трёх редакций выглядел бы как три разных соглашения.
 * Заменённые никуда не деваются и открываются переключателем.
 */
export const DOCUMENT_REVISION_FILTERS = ['current', 'all'] as const;

export type DocumentRevisionFilter = (typeof DOCUMENT_REVISION_FILTERS)[number];

/**
 * Отбор по отметкам: либо конкретный факт поставлен, либо не поставлено ни
 * одного. «Ни одного» — это не отсутствие фильтра, а отдельный вопрос: какие
 * документы ещё никто не согласовал.
 */
export const DOCUMENT_FACT_FILTERS = [...DOCUMENT_STATUS_FACTS, 'none'] as const;

export type DocumentFactFilter = (typeof DOCUMENT_FACT_FILTERS)[number];

/** Колонки, по которым список сортируется на сервере. */
export const DOCUMENT_SORT_KEYS = ['title', 'format', 'sizeBytes', 'createdAt'] as const;

/**
 * Разбор строки запроса — это чтение пользовательского ввода: `format=чушь` в
 * адресе не должен ронять страницу, он просто не фильтр. Поэтому у полей
 * списка стоит `catch`, а не `parse`, который бросает.
 */
export const documentListQuerySchema = z.object({
	interactionId: optionalId('Некорректный идентификатор взаимодействия'),
	kind: z.enum(DOCUMENT_KINDS).nullable().catch(null),
	format: z.enum(DOCUMENT_FORMATS).nullable().catch(null),
	fact: z.enum(DOCUMENT_FACT_FILTERS).nullable().catch(null),
	/** Отсутствие параметра в адресе означает «только действующие редакции». */
	revisions: z.enum(DOCUMENT_REVISION_FILTERS).catch('current'),
	q: searchQuery,
	sortBy: z.enum(DOCUMENT_SORT_KEYS).catch('createdAt'),
	sortDirection: z.enum(['asc', 'desc']).catch('desc'),
	...pageQuerySchema.shape
});

export type UploadDocumentInput = z.output<typeof uploadDocumentSchema>;
export type GenerateDocumentInput = z.output<typeof generateDocumentSchema>;
export type MarkDocumentStatusInput = z.output<typeof markDocumentStatusSchema>;
export type DocumentListQuery = z.output<typeof documentListQuerySchema>;

/**
 * Строка списка документов. Взаимодействие и автор приходят уже названиями:
 * список показывает их текстом и ссылкой, а второй запрос за именами
 * превратил бы страницу в N+1.
 */
export type DocumentListItem = {
	id: string;
	title: string;
	kind: DocumentKind;
	/** Вид, который назвал человек при загрузке; у собранных файлов его нет. */
	uploadedKind: string | null;
	mime: string;
	sizeBytes: number;
	createdAt: Date;
	agreedAt: Date | null;
	approvedAt: Date | null;
	inEffectAt: Date | null;
	interaction: { id: string; title: string } | null;
	/** Кто загрузил или собрал файл; `null` — если учётной записи уже нет. */
	authorName: string | null;
	/** Редакция, которая заменила этот файл, или `null` у действующей. */
	supersededBy: { id: string; createdAt: Date } | null;
};

/**
 * Одна редакция в цепочке документа: от первой к действующей. Файл
 * неизменяем, поэтому цепочка — это записи, а не версии одной строки.
 */
export type DocumentRevisionView = {
	id: string;
	title: string;
	mime: string;
	sizeBytes: number;
	createdAt: Date;
	/** Кто загрузил редакцию; `null` — если учётной записи уже нет. */
	authorName: string | null;
	/** Действующая редакция — та, которую никто не заменил. */
	isCurrent: boolean;
};

/**
 * Заменённая редакция и та, что пришла ей на смену. Панель документов
 * взаимодействия прячет заменённые по умолчанию, и чтобы объяснить, почему
 * файла нет в списке, ей нужна дата замены.
 */
export type DocumentSupersession = {
	documentId: string;
	supersededById: string;
	supersededAt: Date;
};

export type DocumentView = {
	id: string;
	interactionId: string | null;
	/** Редакция, которую этот файл заменил, или `null` у первой. */
	supersedesId: string | null;
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
