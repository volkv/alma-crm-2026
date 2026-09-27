/**
 * Импорт справочника файлом. Видов загрузки два: каталог «вуз × продукт ×
 * договор × лицензия × статус передачи» и вендоры с контактами по продуктам.
 * Мастер, предпросмотр, построчные ошибки и подтверждение у них общие, а поля
 * строки и правила её применения — свои.
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
import { AWAITING_TRANSFER_STATUS, TRANSFERRED_STATUS } from './documents';

/**
 * Что описывает файл. От вида зависят поля строки, синонимы колонок и правила
 * применения; всё остальное — шаги мастера, предпросмотр, ошибки по строкам,
 * исходный файл, подтверждение и отказ — общее.
 */
export const DIRECTORY_IMPORT_KINDS = ['catalog', 'vendors'] as const;

export type DirectoryImportKind = (typeof DIRECTORY_IMPORT_KINDS)[number];

export const DIRECTORY_IMPORT_KIND_LABELS: Record<DirectoryImportKind, string> = {
	catalog: 'Каталог вузов (вуз × продукт × договор)',
	vendors: 'Вендоры и контакты по продуктам'
};

/** Что загружают, в родительном падеже: «Загрузка вендоров», «Предпросмотр импорта каталога». */
export const DIRECTORY_IMPORT_KIND_SUBJECTS: Record<DirectoryImportKind, string> = {
	catalog: 'каталога',
	vendors: 'вендоров'
};

/** Что за файл ждёт каждый вид — одной фразой под выбором на первом шаге. */
export const DIRECTORY_IMPORT_KIND_HINTS: Record<DirectoryImportKind, string> = {
	catalog:
		'Строка — пара «учебное заведение и поставленное ему ПО»: вендор, продукт, договор, лицензия, статус передачи',
	vendors:
		'Строка — компания-правообладатель, её продукты и контакт по ним: ФИО, телефон, почта, способ связи'
};

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
	'transferStatus',
	'manager',
	'contacts',
	'comment'
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
	transferStatus: 'Статус по передаче',
	manager: 'ФИО менеджера',
	contacts: 'Контакты вуза',
	comment: 'Комментарий'
};

/**
 * Допущение, на котором работает поле, — одной фразой рядом со списком на шаге
 * сопоставления.
 *
 * Здесь, а не в разметке: колонка файла ложится на поле по допущению («срок —
 * это 31 декабря названного года», «менеджер — это ответственный за вуз»), и
 * человек, который выбирает поле, обязан прочитать это допущение раньше, чем
 * нажмёт «дальше», а не после применения.
 */
export const CATALOG_FIELD_HINTS: Record<CatalogField, string> = {
	organization: 'Вуз ищется по ИНН, а без него — по названию; ненайденный заводится карточкой',
	organizationInn: 'Ключ сверки; ИНН проверяется контрольной суммой',
	vendor: 'Правообладатель ПО; ненайденный заводится организацией вида «Вендор»',
	product: 'Продукт ищется по коду, а без него — по названию; новый заводится черновиком',
	productCode: 'Артикул каталога; без него код собирается из названия продукта',
	direction: 'ИТ-направление продукта; связь добавляется и уже заведённому продукту',
	contractNumber: 'Номер договора с вузом: в нём лежат лицензия и статус передачи',
	contractSignedOn: 'Дата подписания договора; один год здесь датой не считается',
	contractValidUntil: 'Срок договора; «2027» читается как 31 декабря 2027 года',
	licenseSignedAt: 'Дата подписи лицензии; один год здесь датой не считается',
	licenseUntil: 'Срок лицензии; «2027» читается как 31 декабря 2027 года',
	transferStatus: `Статус по передаче словарём: «${AWAITING_TRANSFER_STATUS}», «${TRANSFERRED_STATUS}»`,
	manager: 'ФИО сотрудника оператора: он станет ответственным за вуз целиком',
	contacts: 'Свободный текст: ФИО, телефон и почта; каждый разбирается в контакт вуза',
	comment: 'Дописывается в примечание карточки вуза, уже записанное не затирает'
};

/**
 * Поля, без которых строку не к чему отнести. Организация и продукт — это и
 * есть пара, которую строка описывает; всё остальное к ней добавляется.
 */
export const CATALOG_REQUIRED_FIELDS: readonly CatalogField[] = ['organization', 'product'];

/**
 * Поля строки файла вендоров. Контакт разложен на части так же, как его
 * присылают: ФИО, телефон и почта отдельными колонками, а способ связи — списком
 * через запятую («Почта, Чат в ТГ»).
 */
export const VENDOR_FIELDS = [
	'company',
	'companyInn',
	'products',
	'contactName',
	'contactPhone',
	'contactEmail',
	'contactChannel'
] as const;

export type VendorField = (typeof VENDOR_FIELDS)[number];

export const VENDOR_FIELD_LABELS: Record<VendorField, string> = {
	company: 'Компания',
	companyInn: 'ИНН компании',
	products: 'Продукты',
	contactName: 'ФИО контакта',
	contactPhone: 'Телефон контакта',
	contactEmail: 'Почта контакта',
	contactChannel: 'Способ связи'
};

export const VENDOR_FIELD_HINTS: Record<VendorField, string> = {
	company:
		'Ищется по ИНН, а без него — по названию среди вендоров, оператора и компаний; ненайденная заводится вендором',
	companyInn: 'Ключ сверки компании; ИНН проверяется контрольной суммой',
	products:
		'Один или несколько продуктов: «А», «Б» или через запятую; новый заводится черновиком этого вендора',
	contactName: 'Фамилия, имя и, если есть, отчество; без ФИО телефон и почту не к кому отнести',
	contactPhone: 'Телефон контакта в любом написании: +7 (900) 111-22-33 или одними цифрами',
	contactEmail: 'Рабочая почта контакта',
	contactChannel: 'Список через запятую: «Почта, Чат в ТГ»; повторы и лишние пробелы убираются'
};

/** Без компании строку не к чему отнести: продукты и контакт принадлежат ей. */
export const VENDOR_REQUIRED_FIELDS: readonly VendorField[] = ['company'];

/** Поле строки любого вида загрузки: то, во что сопоставляется колонка файла. */
export type ImportField = CatalogField | VendorField;

/** Поля, подписи, допущения и обязательные поля вида загрузки — одним словарём. */
export const IMPORT_FIELDS_BY_KIND: Record<
	DirectoryImportKind,
	{
		fields: readonly ImportField[];
		labels: Readonly<Record<string, string>>;
		hints: Readonly<Record<string, string>>;
		required: readonly ImportField[];
	}
> = {
	catalog: {
		fields: CATALOG_FIELDS,
		labels: CATALOG_FIELD_LABELS,
		hints: CATALOG_FIELD_HINTS,
		required: CATALOG_REQUIRED_FIELDS
	},
	vendors: {
		fields: VENDOR_FIELDS,
		labels: VENDOR_FIELD_LABELS,
		hints: VENDOR_FIELD_HINTS,
		required: VENDOR_REQUIRED_FIELDS
	}
};

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

export const vendorMappingSchema = z
	.record(z.string(), z.enum(VENDOR_FIELDS))
	.refine((mapping) => new Set(Object.values(mapping)).size === Object.values(mapping).length, {
		error: 'Одно поле назначено сразу нескольким колонкам'
	});

export type VendorMapping = z.output<typeof vendorMappingSchema>;

/** Сопоставление загрузки любого вида: поля в нём — только поля её вида. */
export type ImportMapping = CatalogMapping | VendorMapping;

/** Схема сопоставления для вида загрузки. */
export function importMappingSchema(
	kind: DirectoryImportKind
): typeof catalogMappingSchema | typeof vendorMappingSchema {
	return kind === 'catalog' ? catalogMappingSchema : vendorMappingSchema;
}

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
	{ number: 1, label: 'Файл и вид загрузки' },
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
	'contractItem',
	'responsible',
	'contact',
	'vendorContact'
] as const;

export type CatalogTarget = (typeof CATALOG_TARGETS)[number];

export const CATALOG_TARGET_LABELS: Record<CatalogTarget, string> = {
	organization: 'Организация',
	vendor: 'Вендор',
	product: 'Продукт',
	direction: 'Направление',
	contract: 'Договор',
	contractItem: 'Позиция договора',
	responsible: 'Ответственный за вуз',
	contact: 'Контакт вуза',
	vendorContact: 'Контакт вендора'
};

/** Претензия к строке: к какому полю и в чём дело. */
export type CatalogRowIssue = {
	/** `null` — претензия к строке целиком (дубль, противоречие). */
	field: ImportField | null;
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

/**
 * Разобранные значения строки: то, с чем работает применение.
 *
 * Полей здесь меньше, чем в {@link CATALOG_FIELDS}: менеджер, контакты вуза и
 * комментарий сюда не попадают. Они не описывают запись справочника, по ним не
 * ищут и не отчитываются — это ввод для действий вокруг строки (назначение,
 * контакт, примечание), и сервер читает их из сохранённой строки файла по
 * сохранённому сопоставлению. Заодно это держит их подальше от экрана: ФИО и
 * телефоны видны по правилам людей, а не по видимости загрузки
 * (`docs/access-matrix.md`, раздел 3).
 */
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
	/**
	 * Строка файла как есть: колонка → значение. `null` — строки файла этому
	 * человеку не показывают: в них есть колонки, которых импорт в справочник не
	 * переносит (`docs/access-matrix.md`, раздел 3).
	 */
	raw: Record<string, string> | null;
	/**
	 * Контакт строки вендоров — ФИО и способ связи, прочитанные из строки файла
	 * по сохранённому сопоставлению. Правило то же, что у `raw`: `null` — строки
	 * файла этому человеку не показывают, либо это загрузка каталога.
	 */
	vendorContact: VendorRowContactView | null;
};

/** ФИО и способ связи контакта вендора, как их назвал файл. */
export type VendorRowContactView = {
	name: string | null;
	channel: string | null;
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
	kind: DirectoryImportKind;
	status: CatalogImportStatus;
	fileDocumentId: string | null;
	mapping: ImportMapping;
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
	kind: z.enum(DIRECTORY_IMPORT_KINDS, { error: 'Выберите, что описывает файл' }),
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
