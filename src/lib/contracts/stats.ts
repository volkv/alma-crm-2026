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
import type { ProgramLevel } from './directory';
import type { RankingView } from './ranking';

/**
 * Откуда пришли данные снимка.
 *
 * `lms` — результаты системы обучения, каким бы путём они ни приехали: файлом
 * выгрузки или сборкой из результатов учебных групп, которые система обучения
 * уже прислала по обмену (`stats/groups.ts`). Источник один, потому что и
 * данные одни: полная сборка за период замещает полную выгрузку того же
 * периода и наоборот, а два текущих снимка одних и тех же групп посчитали бы
 * людей дважды. Путь виден по снимку: у сборки нет файла.
 */
export const STAT_SOURCES = ['file', 'lms', 'site', 'manual'] as const;

export type StatSource = (typeof STAT_SOURCES)[number];

export const STAT_SOURCE_LABELS: Record<StatSource, string> = {
	file: 'Файл',
	lms: 'Результаты LMS',
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

/**
 * Потолок на число колонок. Шапку шире этой человек всё равно не разметит
 * руками, а приходит она не из выгрузки, а из ошибки — развёрнутого в ширину
 * JSON или книги, у которой размеченная область осталась на весь лист.
 */
export const MAX_STAT_FILE_COLUMNS = 200;

/**
 * Глубина вложенности JSON, дальше которой колонки не разворачиваются. Дерево
 * глубже — это не таблица: колонок из него получится больше, чем строк.
 */
export const MAX_STAT_JSON_DEPTH = 5;

/** Форматы файлов, которые читает импорт. */
export const STAT_FILE_FORMATS = ['xls', 'xlsx', 'csv', 'json'] as const;

export type StatFileFormat = (typeof STAT_FILE_FORMATS)[number];

export const STAT_FILE_FORMAT_LABELS: Record<StatFileFormat, string> = {
	xls: 'книга XLS',
	xlsx: 'книга XLSX',
	csv: 'текстовая таблица',
	json: 'JSON'
};

/**
 * Что импорт читает. Одна и та же фраза стоит в подсказке под полем файла и в
 * отказе формы: два списка форматов однажды разошлись бы.
 */
export const STAT_FILE_FORMATS_HINT = 'Импорт читает книги XLS и XLSX, таблицы CSV и файлы JSON';

/**
 * Из чего прочитан файл снимка.
 *
 * Это показывается человеку на шаге сопоставления: «прочитано как текстовая
 * таблица в windows-1251 с разделителем `;`» объясняет съехавшие колонки
 * лучше, чем любое сообщение об ошибке, а «лист „Лист2“» — почему строк
 * оказалось не столько, сколько он ждал.
 */
export type StatFileSummary = {
	fileName: string;
	format: StatFileFormat;
	/** Кодировка текста; у книг её нет — там это внутреннее дело файла. */
	encoding: string | null;
	/** Разделитель колонок; у книг и JSON — `null`. */
	delimiter: string | null;
	/** Лист, с которого прочитаны строки; у JSON — `null`. */
	sheetName: string | null;
	/** Все листы книги: по ним видно, что прочитан не единственный. */
	sheetNames: string[];
};

/** Разделители, у которых есть название: символ в тексте не разглядеть. */
const DELIMITER_LABELS: Record<string, string> = {
	';': 'точка с запятой',
	',': 'запятая',
	'\t': 'табуляция'
};

/** Как прочитан файл — одной строкой рядом с таблицей сопоставления. */
export function describeStatFile(file: StatFileSummary): string {
	const parts = [STAT_FILE_FORMAT_LABELS[file.format]];

	if (file.encoding !== null) {
		parts.push(`кодировка ${file.encoding}`);
	}

	if (file.delimiter !== null) {
		parts.push(`разделитель — ${DELIMITER_LABELS[file.delimiter] ?? `«${file.delimiter}»`}`);
	}

	if (file.sheetName !== null) {
		parts.push(`лист «${file.sheetName}»`);
	}

	return parts.join(', ');
}

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

/**
 * Период сборки снимка из результатов учебных групп. Файла у сборки нет, и
 * от формы загрузки остаётся только период: источник у неё всегда `lms`, режим
 * всегда полный.
 */
export const groupSnapshotPeriodSchema = z
	.object({
		periodKind: z.enum(STAT_PERIOD_KINDS, { error: 'Выберите вид периода' }),
		periodStart: z.iso.date({ error: 'Укажите начало периода' }),
		periodEnd: z.iso.date({ error: 'Укажите конец периода' })
	})
	.refine((input) => input.periodEnd >= input.periodStart, {
		error: 'Конец периода раньше его начала',
		path: ['periodEnd']
	});

export type GroupSnapshotPeriod = z.output<typeof groupSnapshotPeriodSchema>;

/** Строка будущего снимка: организация × программа, сложенные по группам. */
export type GroupSnapshotRow = {
	organizationId: string;
	organizationName: string;
	programId: string;
	programCode: string;
	programName: string;
	/** Групп в строке — они же параллельные потоки. */
	streams: number;
	/** Сколько из них уже прислали хотя бы один результат. */
	withResult: number;
	enrolled: number | null;
	completed: number | null;
	/** Имена групп в системе обучения — происхождение строки. */
	groupLabels: string[];
};

/** Текущий снимок, который полная сборка заместит при подтверждении. */
export type GroupSnapshotReplaced = {
	snapshotId: string;
	fileName: string | null;
	confirmedAt: Date | null;
	rowCount: number;
};

/** Что попадёт в снимок и что нет — до того, как его соберут. */
export type GroupSnapshotPreview = {
	period: GroupSnapshotPeriod;
	rows: GroupSnapshotRow[];
	totals: {
		groups: number;
		withResult: number;
		enrolled: number | null;
		completed: number | null;
	};
	/** Группы периода, которые не к чему отнести, — с причиной. */
	skipped: { withoutProgram: number; withoutOrganization: number };
	replaces: GroupSnapshotReplaced[];
};

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

/**
 * Снимок собран сервером из результатов учебных групп, а не загружен файлом.
 *
 * Отдельного признака у снимка нет — и не нужен: мастер загрузки всегда
 * оставляет файл и сопоставление колонок, а сборка не оставляет ни того, ни
 * другого. Правило одно на все экраны, чтобы «собран из групп» не значило на
 * списке одно, а на карточке другое.
 */
export function isCollectedSnapshot(snapshot: {
	fileDocumentId: string | null;
	mapping: StatMapping;
}): boolean {
	return snapshot.fileDocumentId === null && Object.keys(snapshot.mapping).length === 0;
}

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
 * Группы программ на дашборде: школьные отдельно от вузовских.
 *
 * Уровень программы (`ProgramLevel`) — это справочник, а группа — то, как на
 * портфель смотрит оператор: бакалавриат, магистратура и специалитет для него
 * одно, а школа — совсем другое, и складывать их в одно число значит потерять
 * разницу между вузовским набором и профориентацией школьников.
 */
export const STAT_PROGRAM_GROUPS = ['university', 'vocational', 'school', 'professional'] as const;

export type StatProgramGroup = (typeof STAT_PROGRAM_GROUPS)[number];

export const STAT_PROGRAM_GROUP_LABELS: Record<StatProgramGroup, string> = {
	university: 'Вузовские программы',
	vocational: 'Программы СПО',
	school: 'Школьные программы',
	professional: 'Программы ДПО'
};

const PROGRAM_GROUP_BY_LEVEL: Record<ProgramLevel, StatProgramGroup> = {
	bachelor: 'university',
	master: 'university',
	specialist: 'university',
	spo: 'vocational',
	school: 'school',
	dpo: 'professional'
};

export function statProgramGroupOf(level: ProgramLevel): StatProgramGroup {
	return PROGRAM_GROUP_BY_LEVEL[level];
}

/**
 * Числа показателей в одном месте: у каждого тип `number | null`, потому что
 * ноль и отсутствие данных — разные ответы (см. заголовок файла).
 */
export type StatMeasures = {
	applications: number | null;
	enrolled: number | null;
	parallelStreams: number | null;
	completed: number | null;
	coveragePlan: number | null;
	coverageFact: number | null;
};

/** Портфель периода целиком: счётчики записей и сумма показателей. */
export type StatDashboardTotals = StatMeasures & {
	/** Программ, по которым за период есть подтверждённые строки. */
	programCount: number;
	organizationCount: number;
	/** Площадок, названных в этих строках; площадка в строке необязательна. */
	siteCount: number;
};

/** Строка разбивки по группам программ. */
export type StatDashboardGroupRow = StatMeasures & {
	group: StatProgramGroup;
	/**
	 * Программ в группе. Организации здесь не считаются: один вуз ведёт
	 * программы разных уровней, и сумма по группам была бы больше, чем вузов.
	 */
	programCount: number;
};

/** Строка распределения по вузам. */
export type StatDashboardOrganizationRow = StatMeasures & {
	organizationId: string;
	organizationName: string;
	programCount: number;
};

/**
 * Снимок, из которого сложилась картина периода. Момент подтверждения —
 * строкой ISO: представление дашборда лежит в кэше как JSON, а `Date` через
 * него не переживает.
 */
export type StatDashboardSource = {
	snapshotId: string;
	source: StatSource;
	mode: StatSnapshotMode;
	fileName: string | null;
	/** Кто загрузил; `null` — если учётной записи уже нет. */
	authorName: string | null;
	confirmedAt: string | null;
	/** Строк этого снимка, попавших в период. */
	rowCount: number;
};

/**
 * Дашборд портфеля данных за один отчётный период.
 *
 * Период всегда один: пересекающиеся периоды не складываются, иначе одни и те
 * же обучающиеся посчитались бы дважды (правило показателей).
 */
export type StatDashboardView = {
	period: StatPeriod;
	totals: StatDashboardTotals;
	groups: StatDashboardGroupRow[];
	organizations: StatDashboardOrganizationRow[];
	/**
	 * Рейтинг программ и направлений за тот же период. Считается по фактам
	 * системы, а не по снимкам (`contracts/ranking.ts`): плитки отвечают «что
	 * загружено и принято», рейтинг — «что происходит в работе».
	 */
	ranking: RankingView;
	sources: StatDashboardSource[];
	/**
	 * Когда картина периода последний раз менялась: момент подтверждения
	 * последнего снимка. Актуальность данных — это подтверждение импорта, а не
	 * время загрузки файла.
	 */
	updatedAt: string | null;
};

/**
 * Доля факта от плана в процентах.
 *
 * `null` — доли нет: либо одного из чисел нет вовсе, либо план нулевой, и
 * тогда доля не определена. Ноль вместо этого означал бы «плана не выполнили
 * совсем» — утверждение, которого данные не делают.
 */
export function coverageShare(plan: number | null, fact: number | null): number | null {
	if (plan === null || fact === null || plan === 0) {
		return null;
	}

	return Math.round((fact / plan) * 100);
}

export const STAT_DASHBOARD_TILE_KEYS = [
	'programs',
	'organizations',
	'applications',
	'enrolled',
	'parallelStreams',
	'coverage'
] as const;

export type StatDashboardTileKey = (typeof STAT_DASHBOARD_TILE_KEYS)[number];

/**
 * Плитка дашборда. `value === null` — данных нет, и показывать вместо них ноль
 * нельзя: ноль это результат, а прочерк — незаполненная колонка.
 */
export type StatDashboardTile = {
	key: StatDashboardTileKey;
	label: string;
	value: number | null;
	unit: 'count' | 'percent';
	/** Что именно посчитано. */
	hint: string;
	/** Числа, без которых первое не объясняется; пусто у большинства плиток. */
	extra: { label: string; value: number | null }[];
};

/**
 * Плитки из итогов периода. Функция чистая и общая для экрана и для выгрузки:
 * лист «Сводка» обязан показывать те же числа, что и дашборд, а собранные по
 * отдельности они однажды разойдутся.
 */
export function statDashboardTiles(totals: StatDashboardTotals): StatDashboardTile[] {
	return [
		{
			key: 'programs',
			label: 'Программы',
			value: totals.programCount,
			unit: 'count',
			hint: 'программ с данными за период',
			extra: []
		},
		{
			key: 'organizations',
			label: 'Вузы и площадки',
			value: totals.organizationCount,
			unit: 'count',
			hint: 'организаций с данными за период',
			extra: [{ label: 'площадок названо', value: totals.siteCount }]
		},
		{
			key: 'applications',
			label: 'Заявки',
			value: totals.applications,
			unit: 'count',
			hint: 'подано за период',
			extra: []
		},
		{
			key: 'enrolled',
			label: 'Обучающиеся',
			value: totals.enrolled,
			unit: 'count',
			hint: 'зачислено на программы',
			extra: [{ label: 'завершили обучение', value: totals.completed }]
		},
		{
			key: 'parallelStreams',
			label: 'Параллельные потоки',
			value: totals.parallelStreams,
			unit: 'count',
			hint: 'групп идёт одновременно',
			extra: []
		},
		{
			key: 'coverage',
			label: 'Охват, факт к плану',
			value: coverageShare(totals.coveragePlan, totals.coverageFact),
			unit: 'percent',
			hint: 'факт от плана за период',
			extra: [
				{ label: 'план', value: totals.coveragePlan },
				{ label: 'факт', value: totals.coverageFact }
			]
		}
	];
}

/**
 * Колонки, по которым сортируется распределение по вузам на дашборде.
 *
 * Список объявлен в контрактах, а не в загрузчике страницы: ключ едет в адрес,
 * а адрес читают обе стороны — и загрузчик, и ссылки в заголовках таблицы.
 */
export const STAT_DASHBOARD_SORT_KEYS = [
	'organization',
	'programs',
	'applications',
	'enrolled',
	'coverage'
] as const;

export type StatDashboardSortKey = (typeof STAT_DASHBOARD_SORT_KEYS)[number];
