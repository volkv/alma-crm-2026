/**
 * Паспорт организации из внешних источников.
 *
 * Сотрудник знает про вуз одно из двух: как он называется или какой у него ИНН.
 * Всё остальное — полное и краткое наименование, КПП, ОГРН, регион, сайт —
 * приходится собирать руками из выписки и с сайта. Форма организации делает
 * это за него: по названию или ИНН спрашивает Dadata (ЕГРЮЛ), а по сайту из
 * карточки читает раздел «Сведения об образовательной организации», который по
 * приказу Рособрнадзора живёт по адресу `/sveden` и размечен микроданными.
 *
 * Здесь — то, что нужно обеим сторонам: вид паспорта (он же формат снимка JSON,
 * который загружают файлом, когда внешние источники выключены), отметки о
 * принятых полях и происхождение значения, которое остаётся в журнале.
 *
 * Паспорт — это **предложение**, а не запись. Ни одно поле не попадает в
 * справочник само: сотрудник видит разницу «сейчас в карточке → из источника»,
 * отмечает, что принять, и сохраняет форму. У каждого значения указаны
 * источник и дата — внешний источник ошибается и отстаёт от жизни.
 */
import { z } from 'zod';
import { isValidInn } from '$lib/validation/inn';
import { requiredText } from './common';
import {
	EDUCATION_LEVELS,
	ORGANIZATION_FORM_KINDS,
	ORGANIZATION_KINDS,
	type EducationLevel,
	type OrganizationKind
} from './directory';
import type { PartyRole } from './interactions';

/** Потолок строки поиска: длиннее любого названия вуза вместе с формой. */
export const LOOKUP_QUERY_MAX = 300;

export const registryLookupSchema = z.object({
	query: requiredText(LOOKUP_QUERY_MAX, 'Введите название вуза или его ИНН')
});

/** Сайт для чтения раздела `/sveden` — тот, что сейчас стоит в карточке. */
export const siteLookupSchema = z.object({
	website: requiredText(2000, 'Сначала укажите сайт организации в карточке')
});

/** Чем была строка поиска: ИНН ищут точным совпадением, название — подсказкой. */
export type LookupQueryKind = 'inn' | 'name';

/**
 * Вид строки поиска. ИНН отличается от названия сам, без переключателя в форме:
 * десять или двенадцать цифр с верной контрольной суммой названием не бывают.
 * Пробелы и разделители, которыми ИНН копируют из документов, снимаются здесь
 * же — сотрудник не обязан чистить строку за буфером обмена.
 */
export function lookupQueryKind(raw: string): { kind: LookupQueryKind; query: string } {
	const digits = raw.replace(/[\s-]/g, '');

	return isValidInn(digits) ? { kind: 'inn', query: digits } : { kind: 'name', query: raw.trim() };
}

/**
 * Состояние юридического лица по ЕГРЮЛ. Важно не меньше самих реквизитов:
 * ликвидированный вуз в справочнике — это договор, который некому исполнять.
 */
export const LEGAL_STATUSES = [
	'active',
	'liquidating',
	'liquidated',
	'reorganizing',
	'bankrupt',
	'unknown'
] as const;

export type LegalStatus = (typeof LEGAL_STATUSES)[number];

/**
 * Откуда взялось значение: выписка ЕГРЮЛ через Dadata, раздел `/sveden` сайта,
 * снимок мониторинга вузов Минобрнауки (сайт по ИНН) или догадка (вид
 * организации по ОКВЭД, сайт по домену почты).
 *
 * Источник хранится строкой — в копии паспорта и в подробностях журнала, — а не
 * перечислением базы: новый источник миграции не требует.
 */
export const FIELD_SOURCES = ['dadata', 'sveden', 'monitoring', 'guess'] as const;

export type FieldSource = (typeof FIELD_SOURCES)[number];

/** Поля карточки организации, которые паспорт умеет предложить. */
export const PASSPORT_FIELDS = [
	'kind',
	'educationLevel',
	'legalName',
	'shortName',
	'inn',
	'kpp',
	'ogrn',
	'region',
	'website'
] as const;

export type PassportField = (typeof PASSPORT_FIELDS)[number];

/** Потолок строки из внешнего источника: это реквизит, а не документ. */
const VALUE_MAX = 1000;
const text = z.string().max(VALUE_MAX);
const nullableText = text.nullable();
/** Момент получения из источника — с часовым поясом, как его пишет сервер. */
const moment = z.iso.datetime({ offset: true });

/**
 * Одно предложенное значение: что, откуда и когда получено. Дата — момент
 * ответа источника, а не момент показа: ответ живёт в кэше сутки, и сотрудник
 * обязан видеть, насколько он свеж.
 */
export const passportValueSchema = z.object({
	value: text.min(1),
	/**
	 * Другие написания того же поля в том же источнике: раздел «Сведения» даёт
	 * краткое наименование перечнем («ФГАОУ ВО СПбПУ, СПбПУ, Политех»).
	 * `value` — предложенное из них; сотрудник вправе принять любое другое, и
	 * источник у него тот же.
	 */
	variants: z.array(text.min(1)).max(10).optional(),
	source: z.enum(FIELD_SOURCES),
	fetchedAt: moment
});

export type PassportValue = z.infer<typeof passportValueSchema>;

/**
 * Одна организация в ответе справочника юридических лиц.
 *
 * Имена полей — наши, а не Dadata: карточка справочника не обязана знать, что
 * у поставщика краткое наименование лежит в `data.name.short_with_opf`.
 */
export const legalEntitySchema = z.object({
	inn: nullableText,
	kpp: nullableText,
	ogrn: nullableText,
	/** Полное наименование с организационно-правовой формой. */
	legalName: text,
	/** Краткое — то, которым вуз называют в переписке. */
	shortName: text,
	region: nullableText,
	/** Адрес одной строкой, как его отдал поставщик. */
	address: nullableText,
	status: z.enum(LEGAL_STATUSES),
	/** Головная организация или филиал: у филиала свой КПП и общий ИНН. */
	isBranch: z.boolean(),
	/** Руководитель: ФИО и должность, если поставщик их отдал. */
	management: z.object({ name: text, post: nullableText }).nullable(),
	/** Почта из выписки — она же единственная зацепка для догадки о сайте. */
	emails: z.array(text).max(20),
	/** Основной вид деятельности (ОКВЭД) кодом: по нему видно, вуз ли это. */
	okved: nullableText
});

export type LegalEntity = z.infer<typeof legalEntitySchema>;

/**
 * Подраздел `/sveden/common` — «Основные сведения».
 *
 * Раздел проверяется не только ради полей: сам факт, что по `/sveden` лежит
 * размеченная страница, отличает сайт вуза от сайта однофамильца в домене.
 */
export const svedenCommonSchema = z.object({
	/** Адрес, по которому подраздел нашёлся или по которому его искали. */
	url: text,
	/** Нашлась ли страница с микроразметкой. */
	found: z.boolean(),
	fields: z.object({
		fullName: nullableText,
		shortName: nullableText,
		/** Дата создания образовательной организации. */
		regDate: nullableText,
		address: nullableText,
		telephone: nullableText,
		email: nullableText,
		/** Учредитель — у государственного вуза это министерство. */
		founder: nullableText,
		/** ФИО руководителя по разделу: в ЕГРЮЛ он же, но пишется иначе. */
		headName: nullableText,
		headPost: nullableText
	}),
	/** Сколько размеченных свойств встретилось всего: мера полноты раздела. */
	propertyCount: z.number().int().min(0),
	/** Почему подраздел не прочитался; пусто — прочитался. */
	problem: nullableText
});

export type SvedenReport = z.infer<typeof svedenCommonSchema>;

/**
 * Руководитель подразделения из `/sveden/struct` — **кандидат** в контакты вуза.
 * Человеком справочника он не становится сам: страница бывает устаревшей, а
 * контакт — это персональные данные со своим основанием обработки.
 */
export const contactCandidateSchema = z.object({
	/** Подразделение или орган управления. */
	unit: text,
	/** ФИО руководителя: строка без него кандидатом не считается. */
	name: text,
	post: nullableText,
	email: nullableText,
	/** Номер из той же ячейки, что и почта: вузы пишут их вместе. */
	phone: nullableText,
	address: nullableText
});

export type ContactCandidate = z.infer<typeof contactCandidateSchema>;

/**
 * Подпись, под которой в кандидаты попадают люди из подраздела «Руководство»
 * (`/sveden/managers`): своего подразделения у ректора и проректоров в этой
 * таблице нет, а по подписи сотрудник видит, откуда человек взялся.
 */
export const MANAGEMENT_UNIT = 'Руководство';

/**
 * Подразделение из `/sveden/struct` — **кандидат** в площадки организации.
 *
 * Отдельно от кандидатов в контакты: подразделение нужно карточке дела и
 * тогда, когда руководителя у него на сайте не назвали, — работа идёт с
 * кафедрой, а не с человеком. Почта и телефон здесь — общие ящик и номер
 * подразделения, а не сведения о человеке.
 */
export const unitCandidateSchema = z.object({
	name: text,
	address: nullableText,
	email: nullableText,
	phone: nullableText,
	/** Страница подразделения на сайте вуза, если её указали. */
	site: nullableText
});

export type UnitCandidate = z.infer<typeof unitCandidateSchema>;

/**
 * Название подразделения в виде для сверки со справочником: регистр, «ё»,
 * кавычки и знаки препинания не делают двух разных кафедр. Сверяются и
 * площадки, заведённые руками, поэтому правило терпимо к набору, а не
 * к смыслу: «Кафедра ИБ» и «Кафедра информационной безопасности» остаются
 * разными.
 */
export function normalizeUnitName(value: string): string {
	return value
		.toLocaleLowerCase('ru')
		.replace(/ё/g, 'е')
		.replace(/[«»"'„“”.,;:()[\]№-]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

/**
 * Подразделение кандидата для показа: у строки руководства («Проректор по
 * АХР») подразделение и есть должность, и второй раз его не пишут.
 */
export function candidateUnitLabel(
	candidate: Pick<ContactCandidate, 'unit' | 'post'>
): string | null {
	return candidate.post !== null &&
		candidate.post.toLocaleLowerCase('ru').includes(candidate.unit.toLocaleLowerCase('ru'))
		? null
		: candidate.unit;
}

/** Реализуемая программа из `/sveden/education` с кодом направления. */
export const programCandidateSchema = z.object({
	/** Код специальности или направления подготовки: `09.03.01`. */
	code: text,
	name: text,
	level: nullableText,
	/** Направленность (профиль) — у одного кода их бывает десяток. */
	profile: nullableText,
	forms: z.array(text).max(10)
});

export type ProgramCandidate = z.infer<typeof programCandidateSchema>;

/** Как прочитался один подраздел: адрес, итог, обрезана ли страница. */
export const svedenSectionSchema = z.object({
	url: text,
	found: z.boolean(),
	/** Страница длиннее потолка и прочитана не целиком: список неполон. */
	truncated: z.boolean(),
	problem: nullableText
});

export type SvedenSection = z.infer<typeof svedenSectionSchema>;

/** Потолки списков: паспорт показывают на экране и загружают файлом. */
export const CONTACT_CANDIDATES_MAX = 300;
export const PROGRAM_CANDIDATES_MAX = 600;
export const UNIT_CANDIDATES_MAX = 400;

/**
 * Что прочиталось на сайте организации.
 *
 * Подразделения и «Руководство» появились в отчёте позже остального, поэтому у
 * них умолчания: снимок паспорта, скачанный раньше, загружается как был.
 */
export const siteReportSchema = z.object({
	/** Происхождение сайта, по которому шли: `https://www.spbstu.ru`. */
	website: text,
	fetchedAt: moment,
	common: svedenCommonSchema,
	struct: svedenSectionSchema,
	/** Подраздел «Руководство»; `null` — не читали (отчёт старого вида). */
	managers: svedenSectionSchema.nullable().default(null),
	education: svedenSectionSchema,
	/** Руководители подразделений и люди из «Руководства» — одним списком. */
	contacts: z.array(contactCandidateSchema).max(CONTACT_CANDIDATES_MAX),
	/** Подразделения из «Структуры», в том числе без названного руководителя. */
	units: z.array(unitCandidateSchema).max(UNIT_CANDIDATES_MAX).default([]),
	programs: z.array(programCandidateSchema).max(PROGRAM_CANDIDATES_MAX),
	/**
	 * Хоть одна страница прочитана без проверки сертификата: он у сайта истёк,
	 * самоподписан или выдан центром, которому среда не доверяет. Нет поля —
	 * отчёт старого вида или всё прочитано с проверкой.
	 */
	insecureTls: z.boolean().optional()
});

export type SiteReport = z.infer<typeof siteReportSchema>;

/**
 * Паспорт организации — ответ поиска и формат снимка JSON.
 *
 * Снимок, скачанный с одного стенда, загружается на другом, где внешние
 * источники выключены, и проходит тот же дифф с подтверждением: поэтому схема
 * строгая, а не «что пришло».
 */
export const organizationPassportSchema = z.object({
	version: z.literal(1),
	/** Строка поиска по реестру; `null` — паспорт собран по сайту. */
	query: z.string().max(LOOKUP_QUERY_MAX).nullable(),
	/** Организация, по которой собраны реквизиты; `null` — реестр не спрашивали. */
	entity: legalEntitySchema.nullable(),
	/**
	 * Остальные попавшие под запрос — по названию их бывает десяток, и выбор
	 * между «Политехническим университетом» и его филиалом делает человек.
	 */
	others: z.array(legalEntitySchema).max(20),
	fields: z.partialRecord(z.enum(PASSPORT_FIELDS), passportValueSchema),
	/** Раздел `/sveden`; `null` — сайт не читали. */
	site: siteReportSchema.nullable(),
	/** Замечания сотруднику: что не сошлось и на что посмотреть глазами. */
	warnings: z.array(z.string().max(VALUE_MAX)).max(30)
});

export type OrganizationPassport = z.infer<typeof organizationPassportSchema>;

/**
 * Значение поля в том виде, в каком его допускает карточка. Проверяется при
 * загрузке снимка: иначе файл принёс бы «вид организации», которого нет.
 */
export function passportValueFits(field: PassportField, value: string): boolean {
	switch (field) {
		case 'kind':
			return (ORGANIZATION_KINDS as readonly string[]).includes(value);
		case 'educationLevel':
			return (EDUCATION_LEVELS as readonly string[]).includes(value);
		default:
			return true;
	}
}

/**
 * Как пришёл паспорт: живым ответом источника или снимком из файла. Снимок
 * помечается отдельно — источник и дату в нём назвал тот, кто его собрал, а не
 * этот стенд.
 */
export const PASSPORT_VIA = ['live', 'snapshot'] as const;

export type PassportVia = (typeof PASSPORT_VIA)[number];

/** Выданный сервером паспорт: по номеру сервер узнаёт его при сохранении формы. */
export type IssuedPassport = {
	token: string;
	via: PassportVia;
	passport: OrganizationPassport;
};

/**
 * Отметка «это поле принято из паспорта». Форма отправляет их вместе с
 * реквизитами; значение и источник сервер берёт из выданного им паспорта, а не
 * из отметки, — подделать происхождение браузером нельзя.
 */
export const passportAcceptanceSchema = z
	.array(
		z.object({
			token: z.uuid(),
			field: z.enum(PASSPORT_FIELDS)
		})
	)
	.max(PASSPORT_FIELDS.length * 4);

export type PassportAcceptance = z.infer<typeof passportAcceptanceSchema>;

/** Происхождение принятого значения — то, что остаётся в журнале. */
export type PassportProvenance = {
	field: PassportField;
	source: FieldSource;
	fetchedAt: string;
	via: PassportVia;
};

/** Квота и включённость — то, что форма показывает до первого нажатия. */
export type PassportAvailability = {
	/** Внешние источники включены настройкой. */
	enabled: boolean;
	/** Ключ Dadata задан: без него реестр не спросить даже при включённом флаге. */
	registryConfigured: boolean;
	/** Сколько обращений к источникам осталось сотруднику на сегодня. */
	remaining: number;
	dailyQuota: number;
};

/**
 * Подбор стороны взаимодействия из реестра.
 *
 * Поле формы взаимодействия ищет организацию сначала в справочнике, а не нашло
 * — в ЕГРЮЛ. Выбранная строка реестра становится организацией справочника
 * сразу, без формы карточки: вид задаёт поле, в котором её выбрали, реквизиты
 * — выписка, уровень образования и сайт — догадка.
 */
export const REGISTRY_PICK_ROLES = [
	'educational_institution',
	'customer'
] as const satisfies readonly PartyRole[];

export type RegistryPickRole = (typeof REGISTRY_PICK_ROLES)[number];

/** Вид заводимой организации по полю, в котором её выбрали. */
export const REGISTRY_PICK_KINDS = {
	educational_institution: 'educational_institution',
	customer: 'customer_company'
} as const satisfies Record<RegistryPickRole, OrganizationKind>;

export const registryPickQuerySchema = z.object({
	q: requiredText(LOOKUP_QUERY_MAX, 'Введите название организации или её ИНН')
});

const registryToken = z.uuid({ error: 'Строка реестра устарела: повторите поиск' });

/** Заведение стороны взаимодействия из строки реестра: вид — по полю формы. */
export const registryPickSchema = z.object({
	token: registryToken,
	role: z.enum(REGISTRY_PICK_ROLES, { error: 'Неизвестное поле формы' })
});

/**
 * Заведение организации из строки реестра на странице новой организации: вид
 * угадан по ОКВЭД и названию или выбран сотрудником.
 */
export const registryCreateSchema = z.object({
	token: registryToken,
	kind: z.enum(ORGANIZATION_FORM_KINDS, { error: 'Выберите тип организации' })
});

/** Строка реестра в выпадающем списке поля. */
export type RegistryCandidate = {
	/**
	 * Номер выданного паспорта, по которому организацию заведут; `null` —
	 * заводить нечего: она уже в справочнике или выбрать её нельзя.
	 */
	token: string | null;
	legalName: string;
	shortName: string;
	inn: string;
	kpp: string | null;
	region: string | null;
	status: LegalStatus;
	isBranch: boolean;
	/**
	 * Уровень, который получит организация, если её заведут учебным заведением;
	 * `null` — не угадан, останется пустым.
	 */
	educationLevel: EducationLevel | null;
	/** По ОКВЭД и названию похожа на учебное заведение. */
	looksEducational: boolean;
	/** Та же организация (по ИНН) уже в справочнике и доступна — выбирается она. */
	existing: { id: string; label: string } | null;
	/** Почему строку выбрать нельзя; `null` — можно. */
	unavailable: string | null;
};
