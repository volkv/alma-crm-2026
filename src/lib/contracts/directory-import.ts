/**
 * Импорт каталога «вуз × продукт × договор × лицензия × статус передачи».
 *
 * Рабочая таблица оператора — это одна строка на пару «учебное заведение и
 * поставленное ему ПО»: вендор, продукт, номер договора, подписание лицензии,
 * её срок и статус по передаче. Импорт раскладывает такую строку по
 * справочникам, а не хранит её отдельной сущностью: иначе рядом с
 * организациями, продуктами и договорами завёлся бы второй справочник тех же
 * вещей, и на вопрос «какой срок лицензии действует» появилось бы два ответа.
 *
 * Отсюда главное отличие от импорта данных об обучении: там результат —
 * **снимок чисел**, который живёт своей жизнью, здесь — **изменение
 * справочника**. Поэтому у каждой строки есть не только «разобралась или нет»,
 * но и действие: создать, обновить (и что именно), оставить как есть, отказать.
 *
 * Пустая ячейка ничего не стирает. Выгрузка из чужой таблицы почти всегда
 * неполна, и «в колонке пусто» означает «здесь нет данных», а не «сотрите то,
 * что у вас записано».
 */
import { z } from 'zod';
import { optionalText } from './common';

/**
 * Поля строки каталога — то, во что сопоставляются колонки файла.
 *
 * Названия и коды разведены на разные поля там, где по одному значению ищут, а
 * другим заполняют новую запись: ИНН — ключ сверки организации, но названием он
 * быть не может, а код продукта уникален, но в рабочей таблице заказчика его
 * обычно нет вовсе.
 */
export const CATALOG_FIELDS = [
	'organization',
	'organizationInn',
	'vendor',
	'product',
	'productCode',
	'direction',
	'contractNumber',
	'contractSignedOn',
	'contractValidUntil',
	'licenseSignedAt',
	'licenseUntil',
	'transferStatus'
] as const;

export type CatalogField = (typeof CATALOG_FIELDS)[number];

export const CATALOG_FIELD_LABELS: Record<CatalogField, string> = {
	organization: 'Учебное заведение',
	organizationInn: 'ИНН учебного заведения',
	vendor: 'Вендор',
	product: 'Продукт (ПО)',
	productCode: 'Код продукта',
	direction: 'ИТ-направление',
	contractNumber: 'Номер договора',
	contractSignedOn: 'Дата договора',
	contractValidUntil: 'Договор действует до',
	licenseSignedAt: 'Подписание лицензии',
	licenseUntil: 'Срок действия лицензии',
	transferStatus: 'Статус по передаче'
};

/**
 * Поля, без которых строку не к чему отнести. Организация и продукт — это и
 * есть пара, которую строка описывает; всё остальное к ней добавляется.
 */
export const CATALOG_REQUIRED_FIELDS: readonly CatalogField[] = ['organization', 'product'];

/**
 * «Колонку не берём» в форме сопоставления. Пустая строка означала бы «ничего
 * не выбрано» и была бы неотличима от пустоты, поэтому у отказа собственное
 * значение — и его же разбирает сервер.
 */
export const CATALOG_FIELD_NONE = '__none';

/**
 * Сопоставление колонок: имя колонки файла → поле строки. Колонка без поля в
 * сопоставление не попадает вовсе: «не сопоставлено» — это отсутствие ключа.
 */
export const catalogMappingSchema = z
	.record(z.string(), z.enum(CATALOG_FIELDS))
	.refine((mapping) => new Set(Object.values(mapping)).size === Object.values(mapping).length, {
		error: 'Одно поле назначено сразу нескольким колонкам'
	});

export type CatalogMapping = z.output<typeof catalogMappingSchema>;

/** Сколько строк файла разбирается ради превью на шаге сопоставления. */
export const CATALOG_PREVIEW_PARSE_LIMIT = 200;

/** Сколько строк превью показывается рядом с колонкой. */
export const CATALOG_PREVIEW_ROWS = 5;

/**
 * Шаги мастера импорта: у каждого свой адрес, и вернуться к сопоставлению можно
 * из списка загрузок. Объявлены рядом с остальными названиями раздела, чтобы
 * полоска шагов и заголовки страниц брали их из одного места.
 */
export const CATALOG_WIZARD_STEPS = [
	{ number: 1, label: 'Файл каталога' },
	{ number: 2, label: 'Сопоставление колонок' },
	{ number: 3, label: 'Предпросмотр и применение' }
] as const;

/** Сколько строк предпросмотра показывает третий шаг за раз. */
export const CATALOG_ROWS_PAGE = 200;

/**
 * Что импорт читает. Одна фраза под полем файла и в отказе формы: два списка
 * форматов однажды разошлись бы.
 */
export const CATALOG_FILE_FORMATS_HINT = 'Импорт читает книги XLS и XLSX, таблицы CSV и файлы JSON';

/**
 * Состояние импорта. Отклонённый импорт остаётся в системе вместе со строками:
 * по нему видно, что именно не приняли и почему.
 */
export const CATALOG_IMPORT_STATUSES = ['uploading', 'mapped', 'confirmed', 'rejected'] as const;

export type CatalogImportStatus = (typeof CATALOG_IMPORT_STATUSES)[number];

export const CATALOG_IMPORT_STATUS_LABELS: Record<CatalogImportStatus, string> = {
	uploading: 'Файл принят',
	mapped: 'Предпросмотр готов',
	confirmed: 'Применён',
	rejected: 'Отклонён'
};

/**
 * Что импорт сделает со строкой (на предпросмотре) и что сделал (после
 * применения). Четыре ответа, а не два: «ничего не поменялось» — это результат,
 * а не отсутствие результата, и повторная загрузка того же файла обязана
 * говорить именно его.
 */
export const CATALOG_ROW_ACTIONS = ['create', 'update', 'unchanged', 'error'] as const;

export type CatalogRowAction = (typeof CATALOG_ROW_ACTIONS)[number];

/** Как действие называется на предпросмотре — в будущем времени. */
export const CATALOG_ROW_ACTION_LABELS: Record<CatalogRowAction, string> = {
	create: 'Создать',
	update: 'Обновить',
	unchanged: 'Без изменений',
	error: 'Ошибка'
};

/** Как оно называется на карточке применённого импорта — в прошедшем. */
export const CATALOG_ROW_ACTION_DONE_LABELS: Record<CatalogRowAction, string> = {
	create: 'Создано',
	update: 'Обновлено',
	unchanged: 'Без изменений',
	error: 'Ошибка'
};

/** Записи справочника, которых касается строка каталога. */
export const CATALOG_TARGETS = [
	'organization',
	'vendor',
	'product',
	'direction',
	'contract',
	'contractItem'
] as const;

export type CatalogTarget = (typeof CATALOG_TARGETS)[number];

export const CATALOG_TARGET_LABELS: Record<CatalogTarget, string> = {
	organization: 'Организация',
	vendor: 'Вендор',
	product: 'Продукт',
	direction: 'Направление',
	contract: 'Договор',
	contractItem: 'Позиция договора'
};

/** Претензия к строке: к какому полю и в чём дело. */
export type CatalogRowIssue = {
	/** `null` — претензия к строке целиком (дубль, противоречие). */
	field: CatalogField | null;
	message: string;
};

/** Запись справочника, которую строка заводит. */
export type CatalogCreation = {
	target: CatalogTarget;
	/** Как запись названа — то, что человек увидит в справочнике. */
	subject: string;
};

/**
 * Одно изменение существующей записи. Хранится вместе со строкой, потому что
 * предпросмотр обязан отвечать не «обновить», а «обновить срок лицензии с
 * 2027-06-30 на 2028-06-30»: без «что именно» подтверждать нечего.
 */
export type CatalogRowChange = {
	target: CatalogTarget;
	subject: string;
	/** Название поля по-русски: журнал полей тут читает человек, а не выборка. */
	field: string;
	/** `null` — поле было пустым. */
	from: string | null;
	to: string;
};

/** Разобранные значения строки: то, с чем работает применение. */
export type CatalogRowValues = {
	organizationName: string | null;
	organizationInn: string | null;
	vendorName: string | null;
	productName: string | null;
	productCode: string | null;
	directionName: string | null;
	contractNumber: string | null;
	contractSignedOn: string | null;
	contractValidUntil: string | null;
	licenseSignedAt: string | null;
	licenseUntil: string | null;
	transferStatus: string | null;
};

/** Строка импорта в том виде, в каком её показывают. */
export type CatalogImportRowView = CatalogRowValues & {
	id: string;
	rowNo: number;
	/** Место строки в файле: номер строки листа или индекс элемента JSON. */
	origin: number;
	action: CatalogRowAction;
	issues: CatalogRowIssue[];
	creations: CatalogCreation[];
	changes: CatalogRowChange[];
	organizationId: string | null;
	productId: string | null;
	contractId: string | null;
	contractItemId: string | null;
	/** Строка файла как есть: колонка → значение. */
	raw: Record<string, string>;
};

/** Счётчики импорта: они же уходят числами в журнал действий. */
export type CatalogImportCounts = {
	rowCount: number;
	createCount: number;
	updateCount: number;
	unchangedCount: number;
	errorCount: number;
};

/** Импорт каталога в том виде, в каком его отдают наружу. */
export type CatalogImportView = CatalogImportCounts & {
	id: string;
	status: CatalogImportStatus;
	fileDocumentId: string | null;
	mapping: CatalogMapping;
	note: string | null;
	createdBy: string | null;
	createdAt: Date;
	confirmedAt: Date | null;
	confirmedBy: string | null;
};

/** Строка списка импортов: имена вместо идентификаторов. */
export type CatalogImportListItem = CatalogImportView & {
	/** Кто загрузил; `null` — если учётной записи уже нет. */
	authorName: string | null;
	/** Название исходного файла в хранилище документов. */
	fileName: string | null;
};

export const createCatalogImportSchema = z.object({
	note: optionalText(1000)
});

export const rejectCatalogImportSchema = z.object({
	reason: z
		.string({ error: 'Объясните, почему импорт отклонён' })
		.trim()
		.min(1, { error: 'Объясните, почему импорт отклонён' })
		.max(1000, { error: 'Причина не длиннее 1000 символов' })
});

/**
 * Итог строки по её претензиям и списку изменений.
 *
 * Функция чистая и одна на предпросмотр и на применение: действие, посчитанное
 * в двух местах, однажды разошлось бы — и разошлось бы молча, ровно между тем,
 * что человек подтвердил, и тем, что записалось.
 */
export function catalogRowAction(row: {
	issues: readonly CatalogRowIssue[];
	creations: readonly CatalogCreation[];
	changes: readonly CatalogRowChange[];
}): CatalogRowAction {
	if (row.issues.length > 0) {
		return 'error';
	}

	if (row.creations.length > 0) {
		return 'create';
	}

	return row.changes.length > 0 ? 'update' : 'unchanged';
}

/** Счётчики по разобранным строкам. */
export function catalogImportCounts(
	rows: readonly { action: CatalogRowAction }[]
): CatalogImportCounts {
	const of = (action: CatalogRowAction): number =>
		rows.filter((row) => row.action === action).length;

	return {
		rowCount: rows.length,
		createCount: of('create'),
		updateCount: of('update'),
		unchangedCount: of('unchanged'),
		errorCount: of('error')
	};
}
