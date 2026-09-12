/**
 * Данные об обучении: снимки импорта, их строки и показатели.
 *
 * Число обучающихся — это не поле записи, а факт, у которого есть источник,
 * период и момент загрузки. Поэтому единица хранения — **снимок**: откуда
 * пришли данные, за какой период, какую область они описывают и что с ними
 * сделал человек (сопоставил колонки, проверил, подтвердил или отклонил).
 * Показатель считается только по подтверждённым снимкам, и у каждого числа
 * можно спросить, из какой загрузки оно взялось.
 *
 * **Ноль и отсутствие данных — разные вещи.** «Ноль заявок» — это результат,
 * «нет данных» — это незаполненная колонка, и отчёт обязан их различать,
 * поэтому у каждого показателя тип `number | null`, а не `number`.
 *
 * Набор полей — гипотеза до технического задания: имена нейтральные, смысл
 * каждого описан рядом, переименование после уточнения требований ожидаемо.
 */
import { z } from 'zod';
import { optionalId, optionalText, pageQuerySchema, searchQuery } from './common';

/** Откуда пришли данные снимка. */
export const STAT_SOURCES = ['file', 'lms', 'site', 'manual'] as const;

export type StatSource = (typeof STAT_SOURCES)[number];

export const STAT_SOURCE_LABELS: Record<StatSource, string> = {
	file: 'Файл',
	lms: 'Выгрузка LMS',
	site: 'Заявки с сайта',
	manual: 'Ручной ввод'
};

/**
 * Как снимок относится к тому, что уже подтверждено.
 *
 * `full` — полная выгрузка за период: подтверждение делает её текущей, а
 * прежнюю текущую той же области помечает замещённой. `append` — добавление
 * строк, ничего не вытесняет. `correction` — исправление: строка получает
 * новую версию, а прежняя перестаёт учитываться.
 */
export const STAT_SNAPSHOT_MODES = ['full', 'append', 'correction'] as const;

export type StatSnapshotMode = (typeof STAT_SNAPSHOT_MODES)[number];

export const STAT_SNAPSHOT_MODE_LABELS: Record<StatSnapshotMode, string> = {
	full: 'Полный',
	append: 'Дополнение',
	correction: 'Исправление'
};

/** Чем режим отличается от соседнего — текстом рядом с выбором в форме. */
export const STAT_SNAPSHOT_MODE_HINTS: Record<StatSnapshotMode, string> = {
	full: 'Замещает прежнюю выгрузку того же источника за тот же период и ту же область.',
	append: 'Добавляет строки к уже подтверждённым, ничего не вытесняя.',
	correction: 'Заменяет отдельные строки: у строки появляется новая версия.'
};

/** Каким календарём размечен период: учебным годом или обычными датами. */
export const STAT_PERIOD_KINDS = ['academic', 'calendar'] as const;

export type StatPeriodKind = (typeof STAT_PERIOD_KINDS)[number];

export const STAT_PERIOD_KIND_LABELS: Record<StatPeriodKind, string> = {
	academic: 'Учебный год',
	calendar: 'Календарный период'
};

/**
 * Состояние снимка. Это не стадии одного процесса «загрузки»: отклонённый
 * снимок остаётся в системе со своими строками и ошибками — по нему видно,
 * что именно не приняли и почему.
 */
export const STAT_SNAPSHOT_STATUSES = [
	'uploading',
	'mapped',
	'validated',
	'confirmed',
	'rejected'
] as const;

export type StatSnapshotStatus = (typeof STAT_SNAPSHOT_STATUSES)[number];

export const STAT_SNAPSHOT_STATUS_LABELS: Record<StatSnapshotStatus, string> = {
	uploading: 'Файл принят',
	mapped: 'Колонки сопоставлены',
	validated: 'Проверен',
	confirmed: 'Подтверждён',
	rejected: 'Отклонён'
};

/**
 * Поля строки снимка — то, во что сопоставляются колонки файла.
 *
 * `organization` принимает и ИНН, и название: в выгрузках встречается и то и
 * другое, а различить их можно по самому значению, не заводя второго поля.
 */
export const STAT_FIELDS = [
	'organization',
	'site',
	'program',
	'periodStart',
	'periodEnd',
	'applications',
	'enrolled',
	'parallelStreams',
	'completed',
	'coveragePlan',
	'coverageFact'
] as const;

export type StatField = (typeof STAT_FIELDS)[number];

export const STAT_FIELD_LABELS: Record<StatField, string> = {
	organization: 'Организация (название или ИНН)',
	site: 'Площадка',
	program: 'Программа (код или название)',
	periodStart: 'Начало периода',
	periodEnd: 'Конец периода',
	applications: 'Заявки',
	enrolled: 'Зачислено',
	parallelStreams: 'Параллельные потоки',
	completed: 'Завершили обучение',
	coveragePlan: 'Охват, план',
	coverageFact: 'Охват, факт'
};

/** Числовые поля: из них складываются показатели и рейтинг. */
export const STAT_MEASURE_FIELDS = [
	'applications',
	'enrolled',
	'parallelStreams',
	'completed',
	'coveragePlan',
	'coverageFact'
] as const;

export type StatMeasureField = (typeof STAT_MEASURE_FIELDS)[number];

/** Поля, без которых строку не к чему отнести. */
export const STAT_REQUIRED_FIELDS: readonly StatField[] = ['organization', 'program'];

/**
 * Сопоставление колонок: имя колонки файла → поле строки. Колонка, которой не
 * назначено поле, в сопоставление не попадает вовсе — «не сопоставлено» это
 * отсутствие ключа, а не пустое значение.
 */
export const statMappingSchema = z
	.record(z.string(), z.enum(STAT_FIELDS))
	.refine((mapping) => new Set(Object.values(mapping)).size === Object.values(mapping).length, {
		error: 'Одно поле назначено сразу нескольким колонкам'
	});

export type StatMapping = z.output<typeof statMappingSchema>;

/**
 * «Колонку не берём» в форме сопоставления. Пустая строка для списка означает
 * «ничего не выбрано» и сделала бы этот пункт неотличимым от пустоты, поэтому
 * у отказа есть собственное значение — и оно же разбирается на сервере.
 */
export const STAT_FIELD_NONE = '__none';

/**
 * Область покрытия снимка: что именно он описывает. Пустая область означает
 * «всё, что есть в файле», и тогда замещение считается по источнику и периоду.
 */
export const statCoverageSchema = z.object({
	organizationIds: z.array(z.uuid({ error: 'Некорректный идентификатор организации' })).default([]),
	siteIds: z.array(z.uuid({ error: 'Некорректный идентификатор площадки' })).default([]),
	programIds: z.array(z.uuid({ error: 'Некорректный идентификатор программы' })).default([])
});

export type StatCoverage = z.output<typeof statCoverageSchema>;

export const EMPTY_STAT_COVERAGE: StatCoverage = {
	organizationIds: [],
	siteIds: [],
	programIds: []
};

/** Пустая ли область покрытия — то есть «снимок описывает всё, что в файле». */
export function isEmptyCoverage(coverage: StatCoverage): boolean {
	return (
		coverage.organizationIds.length === 0 &&
		coverage.siteIds.length === 0 &&
		coverage.programIds.length === 0
	);
}

/**
 * Потолок на число строк файла. Импорт разбирает файл целиком в памяти, и
 * граница обязана быть названной: отказ с числом понятнее, чем упавший процесс.
 */
export const MAX_STAT_FILE_ROWS = 20_000;

/** Сколько строк файла разбирается ради превью на шаге сопоставления. */
export const STAT_PREVIEW_PARSE_LIMIT = 200;

/** Сколько строк превью показывается человеку. */
export const STAT_PREVIEW_ROWS = 5;

export const createStatSnapshotSchema = z
	.object({
		source: z.enum(STAT_SOURCES, { error: 'Выберите источник данных' }),
		mode: z.enum(STAT_SNAPSHOT_MODES, { error: 'Выберите режим загрузки' }),
		periodKind: z.enum(STAT_PERIOD_KINDS, { error: 'Выберите вид периода' }),
		periodStart: z.iso.date({ error: 'Укажите начало периода' }),
		periodEnd: z.iso.date({ error: 'Укажите конец периода' }),
		coverage: statCoverageSchema.default(EMPTY_STAT_COVERAGE),
		note: optionalText(1000)
	})
	.refine((input) => input.periodEnd >= input.periodStart, {
		error: 'Конец периода раньше его начала',
		path: ['periodEnd']
	});

export type CreateStatSnapshotInput = z.output<typeof createStatSnapshotSchema>;

export const rejectStatSnapshotSchema = z.object({
	reason: z
		.string({ error: 'Объясните, почему снимок отклонён' })
		.trim()
		.min(1, { error: 'Объясните, почему снимок отклонён' })
		.max(1000, { error: 'Причина не длиннее 1000 символов' })
});

/** Колонки, по которым сортируется список снимков. */
export const STAT_SNAPSHOT_SORT_KEYS = [
	'createdAt',
	'periodStart',
	'rowCount',
	'errorCount'
] as const;

/**
 * Разбор строки запроса — это чтение пользовательского ввода: `status=чушь` в
 * адресе не должен ронять страницу, он просто не фильтр.
 */
export const statSnapshotListQuerySchema = z.object({
	status: z.enum(STAT_SNAPSHOT_STATUSES).nullable().catch(null),
	source: z.enum(STAT_SOURCES).nullable().catch(null),
	q: searchQuery,
	sortBy: z.enum(STAT_SNAPSHOT_SORT_KEYS).catch('createdAt'),
	sortDirection: z.enum(['asc', 'desc']).catch('desc'),
	...pageQuerySchema.shape
});

export type StatSnapshotListQuery = z.output<typeof statSnapshotListQuerySchema>;

/** Отчётный период показателя: границы дат вместе с видом календаря. */
export type StatPeriod = {
	kind: StatPeriodKind;
	start: string;
	end: string;
};

/**
 * Период в адресе списка: `2025-09-01..2026-08-31`. Показатель считается по
 * явно выбранному периоду и никогда не суммируется между пересекающимися —
 * значит, период обязан быть частью ссылки, а не состоянием страницы.
 */
export function statPeriodKey(period: { start: string; end: string }): string {
	return `${period.start}..${period.end}`;
}

const PERIOD_KEY = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/;

/** Период из адреса или `null`, если параметр испорчен. */
export function parseStatPeriodKey(raw: string | null): { start: string; end: string } | null {
	const parts = PERIOD_KEY.exec(raw ?? '');

	return parts === null ? null : { start: parts[1], end: parts[2] };
}

export const statIndicatorQuerySchema = z.object({
	programId: optionalId('Некорректный идентификатор программы'),
	organizationId: optionalId('Некорректный идентификатор организации'),
	...pageQuerySchema.shape
});

export type StatIndicatorQuery = z.output<typeof statIndicatorQuerySchema> & {
	/** Отчётный период; `null` — все периоды подряд, без сложения между ними. */
	period: { start: string; end: string } | null;
};

/** Что советчик видит: названия колонок и несколько первых строк файла. */
export type MappingRequest = {
	headers: readonly string[];
	/** Первые строки файла: колонка → значение. */
	sample: readonly Record<string, string>[];
};

/**
 * Совет по одной колонке. Это предложение, а не решение: интерфейс помечает
 * его значком, а в базу уходит то, что подтвердил человек.
 */
export type MappingAdvice = {
	column: string;
	/** `null` — советчик не знает, во что сопоставить колонку. */
	field: StatField | null;
	/** Уверенность от 0 до 1. */
	confidence: number;
	/** Почему именно так — это видит человек, а не только журнал. */
	reason: string;
};

/** Претензия к строке файла: к какому полю и в чём дело. */
export type StatRowIssue = {
	/** `null` — претензия к строке целиком (дубль, нечего разбирать). */
	field: StatField | null;
	message: string;
};

/** Снимок в том виде, в каком его отдают наружу. */
export type StatSnapshotView = {
	id: string;
	source: StatSource;
	mode: StatSnapshotMode;
	periodKind: StatPeriodKind;
	periodStart: string;
	periodEnd: string;
	coverage: StatCoverage;
	status: StatSnapshotStatus;
	fileDocumentId: string | null;
	rowCount: number;
	errorCount: number;
	mapping: StatMapping;
	/** Снимок учитывается в показателях: подтверждён и ещё не замещён. */
	isCurrent: boolean;
	supersedesSnapshotId: string | null;
	note: string | null;
	createdBy: string | null;
	createdAt: Date;
	confirmedAt: Date | null;
	confirmedBy: string | null;
};

/** Строка списка снимков: имена вместо идентификаторов, счётчики рядом. */
export type StatSnapshotListItem = StatSnapshotView & {
	/** Кто загрузил; `null` — если учётной записи уже нет. */
	authorName: string | null;
	/** Название исходного файла в хранилище документов. */
	fileName: string | null;
	/** Сколько записей названо в области покрытия. */
	coverageSize: number;
};

/** Строка снимка с разобранными значениями и претензиями к ним. */
export type StatRowView = {
	id: string;
	rowNo: number;
	organizationId: string | null;
	organizationName: string | null;
	siteId: string | null;
	siteName: string | null;
	programId: string | null;
	programName: string | null;
	periodStart: string;
	periodEnd: string;
	applications: number | null;
	enrolled: number | null;
	parallelStreams: number | null;
	completed: number | null;
	coveragePlan: number | null;
	coverageFact: number | null;
	issues: StatRowIssue[];
	isValid: boolean;
	version: number;
	/** Строка заменена исправлением и больше не учитывается. */
	replacedByRowId: string | null;
	/** Исходная строка файла: колонка → значение как есть. */
	raw: Record<string, string>;
};

/**
 * Показатель по программе, организации и периоду. Все числа — `number | null`:
 * ноль и отсутствие данных различаются (см. заголовок файла).
 */
export type StatIndicatorRow = {
	programId: string;
	programCode: string;
	programName: string;
	organizationId: string;
	organizationName: string;
	periodKind: StatPeriodKind;
	periodStart: string;
	periodEnd: string;
	applications: number | null;
	enrolled: number | null;
	parallelStreams: number | null;
	completed: number | null;
	coveragePlan: number | null;
	coverageFact: number | null;
	/** Сколько строк снимков сложилось в эту клетку. */
	rowCount: number;
	snapshotCount: number;
};

/**
 * Веса рейтинга программ — **гипотеза до технического задания**.
 *
 * Смысл: заявка — это спрос, зачисление — подтверждённый спрос, а параллельный
 * поток — целая дополнительная группа, то есть спрос, который уже потребовал
 * от вуза отдельного расписания. Отсюда порядок величин; точные веса и сам
 * набор слагаемых определяются по датасету заказчика.
 *
 * Веса объявлены здесь, а не в запросе, потому что рейтинг обязан объясняться:
 * интерфейс показывает разложение на слагаемые, а не только итоговое число.
 */
export const RANKING_WEIGHTS = {
	applications: 1,
	enrolled: 2,
	parallelStreams: 5
} as const satisfies Partial<Record<StatMeasureField, number>>;

export type RankingComponentKey = keyof typeof RANKING_WEIGHTS;

export const RANKING_COMPONENT_KEYS = Object.keys(RANKING_WEIGHTS) as RankingComponentKey[];

/** Одно слагаемое рейтинга: что взяли, с каким весом и сколько это дало. */
export type RankingComponent = {
	component: RankingComponentKey;
	/** `null` — данных нет; в сумму такое слагаемое входит нулём. */
	value: number | null;
	weight: number;
	contribution: number;
};

export type ProgramRankingItem = {
	programId: string;
	programCode: string;
	programName: string;
	score: number;
	/** Сумма вкладов равна `score` — иначе объяснение не объясняет. */
	explanation: RankingComponent[];
	/** По скольким организациям сложился показатель. */
	organizationCount: number;
};

/**
 * Разложение рейтинга на слагаемые. Чистая функция: одна и та же на сервере и
 * в проверках, потому что «почему такой порядок» — это часть ответа, а не
 * оформление.
 */
export function explainScore(values: Record<RankingComponentKey, number | null>): {
	score: number;
	explanation: RankingComponent[];
} {
	const explanation = RANKING_COMPONENT_KEYS.map((component) => {
		const value = values[component];
		const weight = RANKING_WEIGHTS[component];

		return { component, value, weight, contribution: (value ?? 0) * weight };
	});

	return {
		score: explanation.reduce((total, part) => total + part.contribution, 0),
		explanation
	};
}
