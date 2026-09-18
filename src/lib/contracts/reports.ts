/**
 * Отчёт по взаимодействиям: что у отчёта спрашивают, из чего состоит строка и в
 * каком виде одни и те же числа уходят на экран, в диаграмму и в файл.
 *
 * Отчёт отвечает на два разных вопроса — «где всё стоит на дату» и «что за
 * период произошло», — и числа этих двух вопросов не сравнимы между собой.
 * Поэтому режим всегда виден на экране, всегда стоит в адресе и всегда попадает
 * в шапку выгрузки.
 *
 * Семантика описана в `docs/reports.md`; здесь — её машинная часть: словари,
 * каталог колонок, схема разбора адреса и объект выдачи. Второго описания тех
 * же данных в продукте нет: писатели четырёх форматов переводят в свой формат
 * именно этот объект и в базу не ходят.
 */
import { z } from 'zod';
import { INTERACTION_STATUSES, type InteractionStatus } from './interactions';
import { ORGANIZATION_KINDS, type OrganizationKind } from './directory';

/**
 * Версия схемы выгрузки. Растёт, когда меняется форма объекта, а не когда
 * добавилась колонка: по ней принимающая сторона решает, умеет ли она читать
 * файл.
 */
export const REPORT_SCHEMA_VERSION = 1;

/** Режим отчёта: срез на конец периода или движение за период. */
export const REPORT_MODES = ['snapshot', 'movement'] as const;

export type ReportMode = (typeof REPORT_MODES)[number];

export const REPORT_MODE_LABELS: Record<ReportMode, string> = {
	snapshot: 'Срез',
	movement: 'Движение'
};

/**
 * Вид события движения. Восстанавливается из исхода покидаемой записи и из
 * того, открыта ли следующая: отдельного журнала переходов отчёту не нужно.
 *
 * Возврат считается отдельно и никогда не складывается с шагом вперёд: «10
 * переходов» без разбивки на виды — бессмысленное число.
 */
export const REPORT_EVENT_KINDS = [
	'forward',
	'return',
	'skip',
	'started',
	'completed',
	'cancelled'
] as const;

export type ReportEventKind = (typeof REPORT_EVENT_KINDS)[number];

export const REPORT_EVENT_KIND_LABELS: Record<ReportEventKind, string> = {
	forward: 'Вперёд',
	return: 'Возврат',
	skip: 'Пропуск',
	started: 'Начато',
	completed: 'Завершено',
	cancelled: 'Отменено'
};

/**
 * Корзины среза, в которые уходят закрытые взаимодействия. После закрытия
 * открытой записи нет, поэтому в стадию такое взаимодействие не попадает — и
 * показывается отдельной строкой по дню закрытия.
 */
export const REPORT_CLOSED_BUCKETS = ['completed', 'cancelled'] as const;

export type ReportClosedBucket = (typeof REPORT_CLOSED_BUCKETS)[number];

export const REPORT_CLOSED_BUCKET_LABELS: Record<ReportClosedBucket, string> = {
	completed: 'Завершено',
	cancelled: 'Отменено'
};

/** Формат выгрузки. CSV отчёт не производит — см. `docs/reports.md`. */
export const REPORT_FORMATS = ['xlsx', 'xls', 'pdf', 'json'] as const;

export type ReportFormat = (typeof REPORT_FORMATS)[number];

export const REPORT_FORMAT_LABELS: Record<ReportFormat, string> = {
	xlsx: 'XLSX',
	xls: 'XLS',
	pdf: 'PDF',
	json: 'JSON'
};

export const REPORT_FORMAT_MIME: Record<ReportFormat, string> = {
	xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
	xls: 'application/vnd.ms-excel',
	pdf: 'application/pdf',
	json: 'application/json'
};

/**
 * Сорт колонки. Историческая считается на момент среза и после публикации
 * изменённого процесса не меняется; текущая описывает запись сейчас — отчёт за
 * прошлый квартал покажет сегодняшнего владельца. Без пометки один и тот же
 * файл читается двумя способами.
 */
export type ReportColumnSort = 'historical' | 'current';

/** Тип ячейки. Числа пишутся числами, даты — датами: иначе таблица врёт молча. */
export type ReportCellKind = 'text' | 'number' | 'date' | 'datetime' | 'list' | 'link';

export type ReportColumnKey =
	| 'interaction'
	| 'organization'
	| 'directions'
	| 'programs'
	| 'products'
	| 'contract'
	| 'transferStatus'
	| 'state'
	| 'owner'
	| 'assignee'
	| 'stage'
	| 'stageEnteredAt'
	| 'daysOnStage'
	| 'overdueDays'
	| 'paused'
	| 'stageFrom'
	| 'stageTo'
	| 'moveKind'
	| 'movedAt'
	| 'moveReason';

export type ReportColumnDefinition = {
	key: ReportColumnKey;
	label: string;
	kind: ReportCellKind;
	sort: ReportColumnSort;
	/** В каких режимах колонка вообще существует. */
	modes: readonly ReportMode[];
	/** Входит в набор по умолчанию. */
	byDefault: boolean;
	/** Выключить нельзя: без неё строка не опознаётся. */
	required: boolean;
	/** Ширина в знаках для книг; на экране ширину считает вёрстка. */
	width: number;
};

const BOTH_MODES: readonly ReportMode[] = REPORT_MODES;
const SNAPSHOT_ONLY: readonly ReportMode[] = ['snapshot'];
const MOVEMENT_ONLY: readonly ReportMode[] = ['movement'];

/**
 * Каталог колонок. Порядок фиксирован здесь и выбором не меняется: две ссылки с
 * одним набором колонок обязаны дать одну таблицу и один файл.
 *
 * Каталог m2 — двадцать ключей: то, что называет задание (вуз, направление,
 * программа, продукт, состояние работы, ответственный, период), плюс минимум,
 * без которого строка не опознаётся и переход не объясняется. Остальное
 * отложено в m3 и добавляется одной строкой этого каталога.
 */
export const REPORT_COLUMNS: readonly ReportColumnDefinition[] = [
	{
		key: 'interaction',
		label: 'Взаимодействие',
		kind: 'link',
		sort: 'current',
		modes: BOTH_MODES,
		byDefault: true,
		required: true,
		width: 44
	},
	{
		key: 'organization',
		label: 'Вуз или контрагент',
		kind: 'text',
		sort: 'current',
		modes: BOTH_MODES,
		byDefault: true,
		required: true,
		width: 34
	},
	{
		key: 'directions',
		label: 'Направления',
		kind: 'list',
		sort: 'current',
		modes: BOTH_MODES,
		byDefault: true,
		required: false,
		width: 24
	},
	{
		key: 'programs',
		label: 'Программы',
		kind: 'list',
		sort: 'current',
		modes: BOTH_MODES,
		byDefault: true,
		required: false,
		width: 28
	},
	{
		key: 'products',
		label: 'Продукты',
		kind: 'list',
		sort: 'current',
		modes: BOTH_MODES,
		byDefault: true,
		required: false,
		width: 28
	},
	{
		key: 'contract',
		label: 'Номер договора',
		kind: 'text',
		sort: 'current',
		modes: BOTH_MODES,
		byDefault: false,
		required: false,
		width: 18
	},
	{
		key: 'transferStatus',
		label: 'Статус передачи',
		kind: 'list',
		sort: 'current',
		modes: BOTH_MODES,
		byDefault: false,
		required: false,
		width: 22
	},
	{
		key: 'state',
		label: 'Состояние',
		kind: 'text',
		sort: 'current',
		modes: BOTH_MODES,
		byDefault: true,
		required: false,
		width: 14
	},
	{
		key: 'owner',
		label: 'Ответственный',
		kind: 'text',
		sort: 'current',
		modes: BOTH_MODES,
		byDefault: true,
		required: false,
		width: 26
	},
	{
		key: 'assignee',
		label: 'Ответственный за вуз',
		kind: 'list',
		sort: 'historical',
		modes: BOTH_MODES,
		byDefault: false,
		required: false,
		width: 28
	},
	{
		key: 'stage',
		label: 'Стадия на дату среза',
		kind: 'text',
		sort: 'historical',
		modes: SNAPSHOT_ONLY,
		byDefault: true,
		required: false,
		width: 26
	},
	{
		key: 'stageEnteredAt',
		label: 'На стадии с',
		kind: 'date',
		sort: 'historical',
		modes: SNAPSHOT_ONLY,
		byDefault: false,
		required: false,
		width: 14
	},
	{
		key: 'daysOnStage',
		label: 'Дней на стадии',
		kind: 'number',
		sort: 'historical',
		modes: SNAPSHOT_ONLY,
		byDefault: false,
		required: false,
		width: 16
	},
	{
		key: 'overdueDays',
		label: 'Просрочка, дней',
		kind: 'number',
		sort: 'historical',
		modes: SNAPSHOT_ONLY,
		byDefault: false,
		required: false,
		width: 16
	},
	{
		key: 'paused',
		label: 'На паузе',
		kind: 'text',
		sort: 'historical',
		modes: SNAPSHOT_ONLY,
		byDefault: false,
		required: false,
		width: 24
	},
	{
		key: 'stageFrom',
		label: 'Из стадии',
		kind: 'text',
		sort: 'historical',
		modes: MOVEMENT_ONLY,
		byDefault: true,
		required: false,
		width: 26
	},
	{
		key: 'stageTo',
		label: 'В стадию',
		kind: 'text',
		sort: 'historical',
		modes: MOVEMENT_ONLY,
		byDefault: true,
		required: false,
		width: 26
	},
	{
		key: 'moveKind',
		label: 'Вид события',
		kind: 'text',
		sort: 'historical',
		modes: MOVEMENT_ONLY,
		byDefault: true,
		required: false,
		width: 16
	},
	{
		key: 'movedAt',
		label: 'Когда',
		kind: 'datetime',
		sort: 'historical',
		modes: MOVEMENT_ONLY,
		byDefault: true,
		required: false,
		width: 18
	},
	{
		key: 'moveReason',
		label: 'Комментарий перехода',
		kind: 'text',
		sort: 'historical',
		modes: MOVEMENT_ONLY,
		byDefault: true,
		required: false,
		width: 40
	}
];

const COLUMN_BY_KEY = new Map(REPORT_COLUMNS.map((column) => [column.key, column]));

export function isReportColumnKey(value: string): value is ReportColumnKey {
	return COLUMN_BY_KEY.has(value as ReportColumnKey);
}

/** Колонки, существующие в этом режиме, в порядке каталога. */
export function columnsForMode(mode: ReportMode): readonly ReportColumnDefinition[] {
	return REPORT_COLUMNS.filter((column) => column.modes.includes(mode));
}

/**
 * Какие колонки показывать. Неизвестные ключи игнорируются, обязательные
 * добавляются всегда, порядок берётся из каталога, а не из адреса: иначе один и
 * тот же набор в двух ссылках давал бы две разные таблицы.
 */
export function resolveColumns(
	mode: ReportMode,
	requested: readonly string[]
): readonly ReportColumnDefinition[] {
	const available = columnsForMode(mode);
	const asked = new Set(requested.filter(isReportColumnKey));

	if (asked.size === 0) {
		return available.filter((column) => column.byDefault || column.required);
	}

	return available.filter((column) => column.required || asked.has(column.key));
}

/** Начало текущего квартала — период по умолчанию. */
export function quarterStart(today: string): string {
	const month = Number(today.slice(5, 7));
	const first = Math.floor((month - 1) / 3) * 3 + 1;

	return `${today.slice(0, 4)}-${String(first).padStart(2, '0')}-01`;
}

/**
 * Многозначный параметр адреса: `prod=a,b` и `prod=a&prod=b` — одно и то же.
 * Пустые куски выбрасываются, чтобы `prod=` не означал «фильтр по пустоте».
 */
const multiValue = z
	.union([z.string(), z.array(z.string())])
	.default([])
	.transform((value) =>
		(Array.isArray(value) ? value : [value])
			.flatMap((item) => item.split(','))
			.map((item) => item.trim())
			.filter((item) => item !== '')
	);

function multiEnum<TValue extends string>(values: readonly [TValue, ...TValue[]]) {
	const allowed = new Set<string>(values);

	// Непонятное значение в адресе — это не ошибка запроса, а просто не фильтр:
	// человек правил ссылку руками, и показать ему 400 вместо отчёта незачем.
	return multiValue.transform((items) => items.filter((item): item is TValue => allowed.has(item)));
}

const multiUuid = multiValue.transform((items) =>
	items.filter((item) => z.uuid().safeParse(item).success)
);

const flag = z
	.union([z.string(), z.boolean()])
	.default(false)
	.transform((value) => value === true || value === 'true');

/**
 * Схема разбора адреса. Все фильтры живут в адресной строке и являются
 * единственным источником для таблицы, диаграмм и всех четырёх выгрузок: экран
 * — это ссылка, а выгрузка — та же ссылка с другим расширением.
 */
export const reportQuerySchema = z.object({
	mode: z.enum(REPORT_MODES).catch('snapshot'),
	from: z.iso.date({ error: 'Дата начала периода указана неверно' }),
	to: z.iso.date({ error: 'Дата окончания периода указана неверно' }),
	/** Вузы и другие контрагенты — по стороне взаимодействия. */
	org: multiUuid,
	/** Направления: объединение направлений продуктов и программ. */
	dir: multiUuid,
	prog: multiUuid,
	prod: multiUuid,
	/** Ответственный за взаимодействие — тот, кто ведёт его сейчас. */
	owner: multiUuid,
	/** Действующий ответственный за вуз. */
	assignee: multiUuid,
	/** Стадия — по ключу; в движении бьёт и по «откуда», и по «куда». */
	stage: multiValue,
	state: multiEnum(INTERACTION_STATUSES),
	/** Статус передачи по позициям договора — свободный словарь справочника. */
	transfer: multiValue,
	party: multiEnum(ORGANIZATION_KINDS),
	/** Группа процесса — по ключу (`b2b`, `b2c`). */
	group: multiValue,
	overdue: flag,
	paused: flag,
	cols: multiValue
});

export type ReportQuery = z.output<typeof reportQuerySchema>;

/**
 * Параметры адреса, которые отчёт понимает. Всё остальное в адресе он не
 * трогает: рядом живёт состояние таблицы, и чужие параметры не его дело.
 */
export const REPORT_PARAMS = [
	'mode',
	'from',
	'to',
	'org',
	'dir',
	'prog',
	'prod',
	'owner',
	'assignee',
	'stage',
	'state',
	'transfer',
	'party',
	'group',
	'overdue',
	'paused',
	'cols'
] as const;

export type ReportParam = (typeof REPORT_PARAMS)[number];

/** Период отчёта задом наперёд отчётом не является. */
export function periodIssues(query: { from: string; to: string }): string[] {
	return query.to < query.from ? ['Дата окончания периода раньше даты начала'] : [];
}

/** Текст правила на экране и в шапке каждой выгрузки — режим объясняет себя сам. */
export function reportSemantics(mode: ReportMode, from: string, to: string): string {
	const day = (value: string): string => value.split('-').reverse().join('.');

	return mode === 'snapshot'
		? `Срез на ${day(to)}. Каждое взаимодействие показано в той стадии, в которой стояло в этот ` +
				`день; завершённые и отменённые вынесены в отдельные колонки по дню закрытия. ` +
				`Созданные позже ${day(to)} и закрытые раньше ${day(from)} в отчёт не входят.`
		: `Движение за ${day(from)} — ${day(to)}. Каждая строка — один переход, случившийся в эти ` +
				`дни, с указанием, из какой стадии в какую; одно взаимодействие даёт столько строк, ` +
				`сколько раз двигалось. Возвраты и пропуски считаются отдельно от шагов вперёд, ` +
				`перенос на изменённый процесс переходом не считается.`;
}

/** Значение ячейки. Пустая ячейка — не ноль: ноль означает записанный ноль. */
export type ReportCell =
	| { kind: 'text'; value: string | null }
	| { kind: 'number'; value: number | null }
	/** Календарный день `2026-10-01`. */
	| { kind: 'date'; value: string | null }
	/** Момент в ISO с зоной. */
	| { kind: 'datetime'; value: string | null }
	| { kind: 'list'; values: readonly string[] }
	| { kind: 'link'; value: string | null; url: string | null };

/**
 * Ключ связи с документом взаимодействия: чем подтверждено то, что посчитано.
 *
 * Полей ровно четыре, и ни одно из них не персональные данные: название
 * документа и тот, кто его загрузил, остаются в карточке. Этого хватает, чтобы
 * найти файл в хранилище (`storageKey`) и убедиться, что его не подменили
 * (`sha256`), — путь «от числа к подтверждению» дальше файла не идёт.
 */
export type ReportDocumentRef = {
	id: string;
	/** Вид документа: соглашение, приказ, акт, отчёт. */
	kind: string;
	/** Ключ объекта в хранилище документов. */
	storageKey: string;
	sha256: string;
};

/**
 * Ключ связи с учебной группой: тем же путём проверяется результат обучения.
 *
 * `externalId` — идентификатор группы на стороне системы обучения, `resultId` —
 * последний подтверждённый результат этой группы; его нет, пока результат не
 * приехал.
 */
export type ReportLearningGroupRef = {
	id: string;
	externalId: string | null;
	resultId: string | null;
};

/**
 * Строка отчёта. Зерно фиксировано и не зависит от выбранных колонок: срез —
 * одно взаимодействие, движение — одно событие. Ячейки идут в порядке
 * `meta.columns`: второго способа сопоставить ячейку с колонкой нет, и
 * разъехаться им негде.
 */
export type ReportRow = {
	/**
	 * Устойчивое имя строки, различное внутри одной выборки.
	 *
	 * Ни взаимодействие, ни запись о стадии на эту роль не годятся: в движении
	 * одна запись законно даёт две строки — начало работы и уход с той же
	 * стадии, если и то и другое случилось внутри периода. Порядковый номер тоже
	 * не годится: он меняется при любой смене выборки, и список на экране
	 * перерисовывается целиком вместо изменившихся строк.
	 */
	rowKey: string;
	interactionId: string;
	/** Запись о стадии: в срезе — та, что накрывает `T`; в движении — покинутая. */
	stageEntryId: string | null;
	cells: readonly ReportCell[];
	/**
	 * Ключи связи для проверки числа: документы взаимодействия и его учебные
	 * группы. В таблицу и в книги они не идут — колонкой их не показать, — а в
	 * JSON и в машинном отчёте без них путь «от числа к подтверждению»
	 * обрывается на карточке.
	 */
	documents: readonly ReportDocumentRef[];
	learningGroups: readonly ReportLearningGroupRef[];
};

/** Колонка в выдаче — каталог плюс пометка сорта, посчитанная на дату. */
export type ReportColumnView = {
	key: ReportColumnKey;
	label: string;
	kind: ReportCellKind;
	sort: ReportColumnSort;
	/** «на 31.12.2026» у исторических, «сейчас» у текущих. */
	note: string;
};

/** Фильтр словами — для шапки выгрузки и для листа «Фильтры». */
export type ReportFilterView = { label: string; value: string };

export type ReportMeta = {
	schemaVersion: number;
	/** Момент сборки отчёта. */
	generatedAt: string;
	/** Момент среза `T`. */
	asOf: string;
	mode: ReportMode;
	period: { start: string; end: string };
	filters: readonly ReportFilterView[];
	/** Область доступа словами: «все организации» или сколько именно видно. */
	scope: string;
	semantics: string;
	columns: readonly ReportColumnView[];
};

/** Столбик диаграммы и разреза: он же строка листа «Сводка». */
export type ReportBucket = {
	key: string;
	label: string;
	value: number;
	/** Ссылка на тот же отчёт, суженный до этого столбика. */
	filter: { param: string; value: string } | null;
	/** Стадии нет в действующем процессе: название взято из снимка. */
	retired?: boolean;
};

/**
 * Воронка одной группы процесса.
 *
 * Стадии разных групп в одну воронку не складываются: у B2B и B2C свои процессы
 * и свои стадии, а одинаковые ключи в них — законная ситуация. Полоса «Встреча»
 * рядом с полосой «Оплата» из другого процесса выглядит как один путь, которым
 * она не является.
 */
export type ReportFunnelGroup = {
	groupId: string;
	/** Ключ группы (`b2b`, `b2c`) — им же сужается отчёт по клику на полосу. */
	groupKey: string;
	groupName: string;
	stages: readonly ReportBucket[];
};

/** Воронка: распределение на дату, не конверсия. */
export type ReportFunnelChart = {
	/** По одной воронке на группу процесса, в порядке групп. */
	groups: readonly ReportFunnelGroup[];
	closed: readonly ReportBucket[];
	note: string;
};

/** Динамика переходов: столбцы с накоплением по неделям или месяцам. */
export type ReportMovementChart = {
	step: 'week' | 'month';
	/**
	 * Полуоткрытые интервалы по московскому календарю. `from` и `to` —
	 * календарные дни: клик по столбцу сужает период отчёта до них, и второго
	 * способа узнать, какой это был интервал, диаграмме не нужно.
	 */
	buckets: readonly { key: string; label: string; from: string; to: string }[];
	series: readonly { key: ReportEventKind; label: string; values: readonly number[] }[];
	/** Переносы при изменении процесса: в серии не входят, но и не прячутся. */
	migrated: number;
	note: string;
};

/**
 * Разрез по многозначному признаку. Сумма по строкам законно больше числа
 * строк отчёта, и об этом предупреждает подпись, а не тест.
 */
export type ReportBreakdown = {
	key: 'organizations' | 'directions' | 'products' | 'owners';
	label: string;
	points: readonly ReportBucket[];
	/** Сколько записей выборки учтено в двух и более строках разреза. */
	doubleCounted: number;
};

/**
 * Диаграммы отчёта. Их две, и каждая отвечает на вопрос своего режима: воронка
 * — на «где всё стоит», динамика — на «что произошло». В чужом режиме диаграмма
 * не строится вовсе, а не рисуется пустой: сумма её столбцов обязана равняться
 * числу строк таблицы, и диаграмма, которая считает не то же, что таблица,
 * приглашает сравнить несравнимое.
 */
export type ReportCharts = {
	funnel: ReportFunnelChart | null;
	movement: ReportMovementChart | null;
	breakdowns: readonly ReportBreakdown[];
};

export type ReportTotals = {
	/** Строк выборки: взаимодействий в срезе, событий в движении. */
	rowCount: number;
	/** Различных взаимодействий: в движении меньше числа строк. */
	interactionCount: number;
	/** Срез: сколько из показанных стоят на паузе на момент `T`. */
	paused: number;
	/** Срез: сколько просрочено на момент `T`. */
	overdue: number;
};

/**
 * Объект отчёта — один на экран, на диаграммы и на все четыре формата.
 * Писатель не ходит в базу: отчёт, который считает сам, однажды разойдётся с
 * экраном.
 */
export type ReportView = {
	meta: ReportMeta;
	rows: readonly ReportRow[];
	totals: ReportTotals;
	charts: ReportCharts;
};

/** Значение, из которого выбирают фильтр: что уходит в адрес и что видно. */
export type FilterOption = { value: string; label: string };

/** Списки значений для панели фильтров. Собирает их сервер, читает экран. */
export type ReportFilterOptions = {
	organizations: FilterOption[];
	directions: FilterOption[];
	programs: FilterOption[];
	products: FilterOption[];
	owners: FilterOption[];
	stages: FilterOption[];
	groups: FilterOption[];
	parties: FilterOption[];
	states: FilterOption[];
	transferStatuses: FilterOption[];
};

/** Состояние взаимодействия словами — теми же, что в списке. */
export const REPORT_STATE_LABELS: Record<InteractionStatus, string> = {
	active: 'В работе',
	completed: 'Завершено',
	cancelled: 'Отменено'
};

/** Тип контрагента словами — теми же, что в справочнике организаций. */
export const REPORT_PARTY_LABELS: Record<OrganizationKind, string> = {
	educational_institution: 'Учебное заведение',
	customer_company: 'Компания-заказчик',
	operator: 'Оператор',
	individual: 'Физическое лицо',
	legal_entity: 'Юридическое лицо'
};

/**
 * Потолок выборки. Строки, итоги и серии диаграмм считаются из одного набора,
 * поэтому набор обязан помещаться в память: это и есть цена того, что экран,
 * диаграмма и файл не могут разойтись. Выше порога отчёт не режется молча, а
 * отвечает понятным отказом с предложением сузить период или фильтр.
 */
export const REPORT_MAX_ROWS = 50_000;

/**
 * Сколько строк таблицы печатается в PDF.
 *
 * PDF отчёта — **сводка**: условия выборки, итоги, таблицы воронки и динамики и
 * начало таблицы строк. Выше этого числа файл не отказывает и не режет молча, а
 * печатает пометку «показаны первые N из M» и отсылает за полной таблицей в
 * XLSX или JSON.
 *
 * Пятьсот — это тринадцать альбомных страниц A4 при шрифте в десять пунктов:
 * столько ещё листают. Дальше растёт только время: разметку страниц Chromium
 * считает нелинейно, и на двух тысячах строк (прежний потолок, при котором
 * годовой отчёт не выгружался вовсе) сборка занимала минуты и упиралась в
 * потолок ожидания службы печати.
 */
export const REPORT_PDF_ROWS = 500;

/** Сколько строк таблицы показывает одна страница экрана. */
export const REPORT_PAGE_SIZE = 50;
