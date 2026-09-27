/**
 * Справочники: организации и их площадки, люди и их роли в организациях,
 * образовательные программы и продукты.
 *
 * Набор полей — гипотеза до получения технического задания заказчика, поэтому
 * имена нейтральные, а смысл каждого поля описан рядом. Значения перечислений
 * объявлены здесь один раз и переиспользуются схемой базы (`pgEnum`), чтобы
 * список вариантов не разъехался между формой и таблицей.
 */
import { z } from 'zod';
import { isValidInn } from '$lib/validation/inn';
import {
	id,
	isoDate,
	optionalId,
	optionalIsoDate,
	optionalText,
	pageQuerySchema,
	requiredText,
	searchQuery
} from './common';
import { CONTRACT_STATUSES, editVersionField, type ContractStatus } from './interactions';

/**
 * Кем организация приходится процессу: вуз, юридическое или физическое лицо,
 * компания-заказчик, оператор, вендор.
 *
 * Первые три бывают основной стороной взаимодействия, и по ним считается группа
 * процесса; компания-заказчик и оператор стоят рядом, но процесс не задают.
 * Вендор — правообладатель ПО (на него ссылается `products.vendor_organization_id`):
 * стороной взаимодействия он не бывает вовсе, пространства и маршрута приёма у
 * него нет.
 * Физическое лицо — организация вида `individual` с обязательной ссылкой на
 * человека: отдельного контура персональных данных для него не заводится.
 * Порядок значений менять нельзя — он же порядок значений перечисления в базе.
 */
export const ORGANIZATION_KINDS = [
	'educational_institution',
	'customer_company',
	'operator',
	'individual',
	'legal_entity',
	'vendor'
] as const;

/**
 * Виды, которые заводит форма справочника. Физическое лицо в неё не входит: его
 * строка неотделима от строки человека (`organizations.person_id`), и такой
 * контрагент появляется вместе с заявкой, а не отдельной карточкой.
 */
export const ORGANIZATION_FORM_KINDS = [
	'educational_institution',
	'customer_company',
	'operator',
	'legal_entity',
	'vendor'
] as const;
/** Уровень образования: высшее, среднее профессиональное, школа. */
export const EDUCATION_LEVELS = ['vo', 'spo', 'school'] as const;
/** Чем является площадка организации. */
export const SITE_KINDS = ['campus', 'branch', 'department', 'other'] as const;
/**
 * Роль человека в организации — от ректора до координатора. `vendor_contact` —
 * человек вендора, который отвечает за его продукты; его заводит загрузка
 * вендоров.
 */
export const AFFILIATION_ROLE_KINDS = [
	'rector',
	'vice_rector',
	'dean',
	'head_of_department',
	'teacher',
	'coordinator',
	'other',
	'vendor_contact'
] as const;
/** Уровень образовательной программы. */
export const PROGRAM_LEVELS = ['bachelor', 'master', 'specialist', 'spo', 'school', 'dpo'] as const;
/** Жизненный цикл записи справочника: черновик → действует → в архиве. */
export const LIFECYCLE_STATUSES = ['draft', 'active', 'archived'] as const;
/**
 * На каком основании обрабатываются персональные данные человека. Список
 * закрытый: основание — это ссылка на норму закона, а не заметка, и по нему
 * отвечают на вопрос «почему эти данные вообще у нас лежат».
 */
export const CONSENT_BASES = ['consent', 'contract', 'legal'] as const;

export type OrganizationKind = (typeof ORGANIZATION_KINDS)[number];
export type OrganizationFormKind = (typeof ORGANIZATION_FORM_KINDS)[number];
export type EducationLevel = (typeof EDUCATION_LEVELS)[number];
export type SiteKind = (typeof SITE_KINDS)[number];
export type AffiliationRoleKind = (typeof AFFILIATION_ROLE_KINDS)[number];
export type ProgramLevel = (typeof PROGRAM_LEVELS)[number];
export type LifecycleStatus = (typeof LIFECYCLE_STATUSES)[number];
export type ConsentBasis = (typeof CONSENT_BASES)[number];

type ExternalRef = { externalSource: string | null; externalId: string | null };

/**
 * Источник и идентификатор указывают только вместе: идентификатор без системы
 * не с чем сопоставить, система без идентификатора ничего не адресует.
 */
function externalRefIsPaired(value: ExternalRef): boolean {
	return (value.externalSource === null) === (value.externalId === null);
}

const externalRefError = {
	error: 'Внешний идентификатор указывают вместе с внешней системой',
	path: ['externalId']
};

const externalRefFields = {
	/** Система, из которой приехала запись: `moodle`, `1c`, имя выгрузки. */
	externalSource: optionalText(100),
	/** Идентификатор записи в этой системе; пара с `externalSource` уникальна. */
	externalId: optionalText(200)
};

const innField = optionalText(12).refine((value) => value === null || isValidInn(value), {
	error: 'ИНН должен состоять из 10 или 12 цифр и проходить проверку контрольной суммы'
});

/**
 * Примечание карточки организации. Отдельным именем по той же причине, что и
 * должность: импорт каталога дописывает в него комментарий строки и обязан
 * отказать по строке, а не уронить загрузку на записи.
 */
export const organizationNotesSchema = optionalText(4000);

const organizationFields = {
	kind: z.enum(ORGANIZATION_KINDS, { error: 'Выберите тип организации' }),
	/**
	 * Бывает только у учебных заведений — это же правило проверяет база. У вуза
	 * необязателен: его заводят и из ЕГРЮЛ, где уровня нет, и уточняют позже.
	 */
	educationLevel: z
		.enum(EDUCATION_LEVELS, { error: 'Выберите уровень образования' })
		.nullable()
		.default(null),
	legalName: requiredText(500, 'Укажите полное наименование организации'),
	shortName: requiredText(200, 'Укажите краткое наименование организации'),
	inn: innField,
	kpp: optionalText(9),
	ogrn: optionalText(15),
	region: optionalText(200),
	website: z
		.url({ error: 'Сайт указывают полным адресом, вместе с https://' })
		.nullable()
		.default(null),
	notes: organizationNotesSchema,
	isActive: z.boolean().default(true),
	...externalRefFields
};

function educationLevelMatchesKind(value: {
	kind: OrganizationKind;
	educationLevel: EducationLevel | null;
}): boolean {
	return value.educationLevel === null || value.kind === 'educational_institution';
}

const educationLevelError = {
	error: 'Уровень образования заполняют только у учебных заведений',
	path: ['educationLevel']
};

function kindIsCreatableByForm(value: { kind: OrganizationKind }): boolean {
	return (ORGANIZATION_FORM_KINDS as readonly OrganizationKind[]).includes(value.kind);
}

const organizationKindError = {
	error: 'Физическое лицо заводится вместе с карточкой человека, а не формой справочника',
	path: ['kind']
};

export const createOrganizationSchema = z
	.object(organizationFields)
	.refine(externalRefIsPaired, externalRefError)
	.refine(educationLevelMatchesKind, educationLevelError)
	.refine(kindIsCreatableByForm, organizationKindError);

export const updateOrganizationSchema = createOrganizationSchema.extend({
	id: id('Некорректный идентификатор организации')
});

export const organizationListQuerySchema = z.object({
	kind: z.enum(ORGANIZATION_KINDS).nullable().default(null),
	q: searchQuery,
	...pageQuerySchema.shape
});

const siteFields = {
	organizationId: id('Выберите организацию'),
	kind: z.enum(SITE_KINDS, { error: 'Выберите тип площадки' }),
	name: requiredText(300, 'Укажите название площадки'),
	address: optionalText(500),
	region: optionalText(200),
	...externalRefFields
};

export const createSiteSchema = z.object(siteFields).refine(externalRefIsPaired, externalRefError);

export const updateSiteSchema = createSiteSchema.extend({
	id: id('Некорректный идентификатор площадки')
});

const personFields = {
	lastName: requiredText(100, 'Укажите фамилию'),
	firstName: requiredText(100, 'Укажите имя'),
	middleName: optionalText(100),
	email: z.email({ error: 'Электронная почта указана неверно' }).nullable().default(null),
	phone: optionalText(50).refine((value) => value === null || /^[\d\s+()-]{5,}$/.test(value), {
		error: 'Телефон может содержать только цифры, пробелы и знаки + ( ) -'
	}),
	notes: optionalText(4000)
};

export const createPersonSchema = z.object(personFields);
export const updatePersonSchema = createPersonSchema.extend({
	id: id('Некорректный идентификатор человека')
});

/**
 * Фамилия обезличенного человека. Имя и отчество при обезличивании стираются,
 * поэтому в списках и карточках остаётся одно это слово: запись нужна тем
 * взаимодействиям, где человек был контактом, а его данных в ней уже нет.
 */
export const ANONYMIZED_PERSON_LAST_NAME = 'Обезличено';

/**
 * Чем заменяется сохранённый текст, в котором стояли ФИО или контакты: тема и
 * тело отправленного уведомления, прежнее значение правленого поля, текст
 * заявки с сайта.
 *
 * Текст заменяется целиком, а не чистится по образцу. Искать в нём фамилию и
 * номер подстрокой — значит однажды и не найти («Иванов И.И.», перенос строки
 * посреди номера), и испортить чужой текст совпадением. Пометка вместо текста
 * честнее пустоты: видно, что запись была и что её содержание уничтожено, а не
 * что письма не отправляли и правки не делали.
 */
export const ANONYMIZED_TEXT = 'Текст удалён при обезличивании данных';

/**
 * Согласие на обработку персональных данных как запись, а не галочка: у него
 * есть основание, версия текста, дата получения и, возможно, дата отзыва.
 * Дата здесь календарная: согласие подписывают днём, на бумаге или в кабинете,
 * и точность до секунды в нём ничего не значит.
 */
export const recordConsentSchema = z.object({
	personId: id('Некорректный идентификатор человека'),
	basis: z.enum(CONSENT_BASES, { error: 'Выберите основание обработки' }),
	/** Версия текста, под которым человек подписался: `2026-09-01`, `v3`. */
	textVersion: requiredText(50, 'Укажите версию текста согласия'),
	givenAt: isoDate('Укажите дату получения согласия')
});

/**
 * Отзыв согласия. Запись не удаляется: отозванное согласие — это факт, который
 * обязан остаться, иначе на вопрос «на каком основании данные лежали до
 * отзыва» ответить будет нечем.
 */
export const withdrawConsentSchema = z.object({
	id: id('Некорректный идентификатор согласия'),
	withdrawnAt: isoDate('Укажите дату отзыва согласия')
});

/**
 * Срок хранения персональных данных. Пустое значение — «срок не назначен», а
 * не «хранить вечно»: назначает его человек, и до тех пор запись просто ждёт
 * решения.
 */
export const setRetentionSchema = z.object({
	personId: id('Некорректный идентификатор человека'),
	retentionUntil: optionalIsoDate('Срок хранения указан неверно')
});

/**
 * Должность в роли человека. Отдельным именем, потому что её проверяет не
 * только форма: импорт каталога собирает должность из ячейки контактов и
 * обязан отказать по строке той же мерой, а не уронить всю загрузку на записи.
 */
export const affiliationPositionSchema = requiredText(300, 'Укажите должность');

const affiliationFields = {
	personId: id('Выберите человека'),
	organizationId: id('Выберите организацию'),
	/** Площадка обязана принадлежать той же организации — это проверяет база. */
	siteId: optionalId('Некорректный идентификатор площадки'),
	position: affiliationPositionSchema,
	roleKind: z.enum(AFFILIATION_ROLE_KINDS, { error: 'Выберите роль в организации' }),
	/** Основной контакт организации по процессу: такой отмечают для быстрой связи. */
	isPrimary: z.boolean().default(false),
	validFrom: isoDate('Укажите дату начала полномочий'),
	validTo: optionalIsoDate('Дата окончания полномочий указана неверно'),
	/** Как договорились общаться: почта, телефон, мессенджер, портал. */
	channel: optionalText(200)
};

function affiliationPeriodIsOrdered(value: { validFrom: string; validTo: string | null }): boolean {
	return value.validTo === null || value.validTo >= value.validFrom;
}

const affiliationPeriodError = {
	error: 'Дата окончания полномочий не может быть раньше даты начала',
	path: ['validTo']
};

/**
 * Роль действует, пока её последний день не прошёл. Дата окончания бывает
 * заранее известной — срок полномочий по приказу, — и роль с ней остаётся
 * действующей до этого дня включительно. `today` — день по Москве
 * (`formatIsoDay`): по нему живёт процесс.
 */
export function isAffiliationCurrent(row: { validTo: string | null }, today: string): boolean {
	return row.validTo === null || row.validTo >= today;
}

export const createAffiliationSchema = z
	.object(affiliationFields)
	.refine(affiliationPeriodIsOrdered, affiliationPeriodError);

/**
 * Правка уже заведённой роли. Человека и организацию у роли не меняют: роль в
 * другой организации — это другая роль, и взаимодействия, где человек был
 * контактом, не должны задним числом переехать в чужой вуз. Площадку правят с
 * карточки организации — там известен её список.
 */
export const updateAffiliationSchema = z
	.object({
		id: id('Некорректный идентификатор роли'),
		position: affiliationFields.position,
		roleKind: affiliationFields.roleKind,
		isPrimary: affiliationFields.isPrimary,
		validFrom: affiliationFields.validFrom,
		validTo: affiliationFields.validTo,
		channel: affiliationFields.channel
	})
	.refine(affiliationPeriodIsOrdered, affiliationPeriodError);

/**
 * Закрытие периода полномочий. Роль не удаляют: человек действительно занимал
 * должность, и взаимодействия, где он был контактом, обязаны это помнить.
 */
export const endAffiliationSchema = z.object({
	id: id('Некорректный идентификатор роли'),
	/** Последний день полномочий; он ещё входит в период. */
	validTo: isoDate('Укажите дату окончания полномочий')
});

const programFields = {
	/** Код программы в номенклатуре оператора; по нему сверяют планы и отчёты. */
	code: requiredText(50, 'Укажите код программы'),
	name: requiredText(500, 'Укажите название программы'),
	level: z.enum(PROGRAM_LEVELS, { error: 'Выберите уровень программы' }),
	/** Код направления подготовки, например 09.03.01. */
	directionCode: optionalText(20),
	/**
	 * Ручной приоритет показа: 1 — самая важная программа, пусто — приоритет не
	 * назначен. Ноль сюда не годится: он читался бы как настоящее значение, а
	 * «не назначен» и «наименее важная» — разные вещи, и в списке они стоят в
	 * разных местах.
	 */
	priority: z
		.number({ error: 'Приоритет — целое число от 1 до 999' })
		.int({ error: 'Приоритет — целое число от 1 до 999' })
		.min(1, { error: 'Самый высокий приоритет — 1' })
		.max(999, { error: 'Приоритет не больше 999' })
		.nullable()
		.default(null),
	status: z.enum(LIFECYCLE_STATUSES).default('draft'),
	...externalRefFields
};

export const createProgramSchema = z
	.object(programFields)
	.refine(externalRefIsPaired, externalRefError);

export const updateProgramSchema = createProgramSchema.extend({
	id: id('Некорректный идентификатор программы')
});

export const createProgramVersionSchema = z.object({
	programId: id('Выберите программу'),
	summary: requiredText(4000, 'Опишите, что изменилось в этой версии'),
	effectiveFrom: isoDate('Укажите дату вступления версии в силу')
});

/**
 * ИТ-направление — разрез продуктов и ответственности (DevOps, тестирование), а
 * не код направления подготовки ФГОС. Позиция в списке своя: у направлений есть
 * порядок значимости, и алфавит его не выражает. Назначает позицию сервис, а не
 * форма, поэтому в схеме её нет.
 */
export const createDirectionSchema = z.object({
	code: requiredText(50, 'Укажите код направления'),
	name: requiredText(200, 'Укажите название направления')
});

export const updateDirectionSchema = createDirectionSchema.extend({
	id: id('Некорректный идентификатор направления')
});

/**
 * Связь продукта с направлением. Она многие ко многим: один продукт закрывает и
 * DevOps, и администрирование, и делить его надвое ради разреза отчёта значило
 * бы заводить два продукта там, где заказчик видит один.
 */
export const linkProductDirectionSchema = z.object({
	directionId: id('Некорректный идентификатор направления'),
	productId: id('Выберите продукт')
});

export type CreateDirectionInput = z.output<typeof createDirectionSchema>;
export type UpdateDirectionInput = z.output<typeof updateDirectionSchema>;
export type LinkProductDirectionInput = z.output<typeof linkProductDirectionSchema>;

const productFields = {
	code: requiredText(50, 'Укажите код продукта'),
	name: requiredText(500, 'Укажите название продукта'),
	/** Правообладатель или поставщик продукта, если он известен. */
	vendorOrganizationId: optionalId('Некорректный идентификатор организации-поставщика'),
	description: optionalText(4000),
	status: z.enum(LIFECYCLE_STATUSES).default('draft'),
	...externalRefFields
};

export const createProductSchema = z
	.object(productFields)
	.refine(externalRefIsPaired, externalRefError);

export const updateProductSchema = createProductSchema.extend({
	id: id('Некорректный идентификатор продукта')
});

/**
 * Договор с контрагентом.
 *
 * Договор принадлежит контрагенту, а не взаимодействию: один договор
 * обслуживает несколько записей процесса (`docs/domain.md`, раздел 3.2).
 * Поэтому его команды живут среди справочников, а состояние берётся из
 * перечисления `CONTRACT_STATUSES` — оно объявлено рядом с таблицей, в
 * контракте взаимодействий, и второй копии у него быть не должно.
 */
const contractFields = {
	/**
	 * Заводим новый договор или правим существующий. Форма справочника
	 * присылает запись целиком, поэтому команда одна: «завести» отличается от
	 * «исправить» только тем, есть ли уже идентификатор. Слияние по правилу
	 * «пустое ничего не стирает» к форме отношения не имеет — оно принадлежит
	 * импорту, где пустая ячейка означает «данных нет».
	 */
	id: optionalId('Некорректный идентификатор договора'),
	organizationId: id('Выберите организацию'),
	number: requiredText(200, 'Укажите номер договора'),
	signedOn: optionalIsoDate('Дата подписания указана неверно'),
	validUntil: optionalIsoDate('Дата окончания действия указана неверно'),
	status: z.enum(CONTRACT_STATUSES, { error: 'Выберите состояние договора' }).default('draft'),
	/**
	 * Версия договора, с которой открыта форма правки; у нового договора её нет.
	 * Чужая правка договора или его позиций после неё — отказ, а не перезапись.
	 */
	editVersion: editVersionField.nullable()
};

function contractPeriodIsOrdered(value: {
	signedOn: string | null;
	validUntil: string | null;
}): boolean {
	return value.signedOn === null || value.validUntil === null || value.validUntil >= value.signedOn;
}

export const saveContractSchema = z
	.object(contractFields)
	.refine(contractPeriodIsOrdered, {
		error: 'Договор не может истечь раньше, чем подписан',
		path: ['validUntil']
	})
	.refine((value) => (value.id === null) === (value.editVersion === null), {
		error: 'Форма не знает версию договора: обновите карточку',
		path: ['editVersion']
	});

/**
 * Позиция договора: коммерческие условия по одному продукту.
 *
 * Состав продуктов взаимодействия позиция не задаёт — его держит
 * `interaction_products`; позиция добавляет к продукту сроки лицензии и статус
 * по передаче. Словарь статусов передачи свободный: каталога заказчика ещё нет,
 * и значения приезжают из его же файла (`docs/directory.md`).
 */
const contractItemFields = {
	/** Как и у договора: пусто — заводим позицию, заполнено — правим её. */
	id: optionalId('Некорректный идентификатор позиции договора'),
	contractId: id('Выберите договор'),
	productId: id('Выберите продукт'),
	licenseSignedAt: optionalIsoDate('Дата подписания лицензии указана неверно'),
	licenseUntil: optionalIsoDate('Срок действия лицензии указан неверно'),
	transferStatus: requiredText(100, 'Укажите статус по передаче'),
	/** Версия договора позиции: версия одна на договор и все его позиции. */
	editVersion: editVersionField
};

function licensePeriodIsOrdered(value: {
	licenseSignedAt: string | null;
	licenseUntil: string | null;
}): boolean {
	return (
		value.licenseSignedAt === null ||
		value.licenseUntil === null ||
		value.licenseUntil >= value.licenseSignedAt
	);
}

export const saveContractItemSchema = z.object(contractItemFields).refine(licensePeriodIsOrdered, {
	error: 'Лицензия не может истечь раньше, чем подписана',
	path: ['licenseUntil']
});

/** Страница списка договоров: фильтр по контрагенту и состоянию. */
export const contractListQuerySchema = z.object({
	organizationId: optionalId('Некорректный идентификатор организации'),
	status: z.enum(CONTRACT_STATUSES).nullable().default(null),
	...pageQuerySchema.shape
});

export const catalogListQuerySchema = z.object({
	status: z.enum(LIFECYCLE_STATUSES).nullable().default(null),
	q: searchQuery,
	...pageQuerySchema.shape
});

/**
 * Сортировка списка. Направление транспорт уже разобрал (`-name` в адресе), а
 * колонку выбирают из закрытого списка: имя столбца из запроса в `order by`
 * подставлять нельзя.
 */
const sortDirection = z.enum(['asc', 'desc']).catch('asc');

/**
 * Разбор строки запроса — это чтение пользовательского ввода: `kind=чушь` в
 * адресе не должен ронять страницу, он просто не фильтр. Поэтому у каждого
 * поля есть `catch`, а не `parse`, который бросает.
 */
export const ORGANIZATION_SORT_KEYS = [
	'shortName',
	'kind',
	'inn',
	'region',
	'siteCount',
	'isActive'
] as const;

/**
 * Многозначный фильтр из адреса: `kind=a,b` — несколько значений работают
 * как «или». Незнакомые значения отбрасываются по одному, а не обнуляют весь
 * отбор; пустой список — фильтра нет.
 */
function enumList<const T extends readonly [string, ...string[]]>(values: T) {
	const known = new Set<string>(values);

	// `catch` — и для чужого типа, и для отсутствующего ключа: без него поле
	// объекта стало бы необязательным и пропадало бы из результата.
	return z
		.union([z.string(), z.array(z.unknown())])
		.catch('')
		.transform((raw): T[number][] => {
			const items = typeof raw === 'string' ? raw.split(',') : raw;

			return [
				...new Set(
					items.filter((item): item is T[number] => typeof item === 'string' && known.has(item))
				)
			];
		});
}

export const organizationDirectoryQuerySchema = z.object({
	kind: enumList(ORGANIZATION_KINDS),
	educationLevel: enumList(EDUCATION_LEVELS),
	q: searchQuery,
	sortBy: z.enum(ORGANIZATION_SORT_KEYS).catch('shortName'),
	sortDirection,
	...pageQuerySchema.shape
});

export const PEOPLE_SORT_KEYS = ['lastName', 'firstName'] as const;

/**
 * Отбор по сроку хранения. Ответ на вопрос «чьи данные пора уничтожать»:
 * срок назначен и прошёл, а человек ещё не обезличен.
 */
export const PEOPLE_RETENTION_FILTERS = ['expired'] as const;

export type PeopleRetentionFilter = (typeof PEOPLE_RETENTION_FILTERS)[number];

export const peopleListQuerySchema = z.object({
	/** Показать только тех, у кого есть роль в этой организации. */
	organizationId: optionalId('Некорректный идентификатор организации'),
	retention: z.enum(PEOPLE_RETENTION_FILTERS).nullable().catch(null),
	q: searchQuery,
	sortBy: z.enum(PEOPLE_SORT_KEYS).catch('lastName'),
	sortDirection,
	...pageQuerySchema.shape
});

export const PROGRAM_SORT_KEYS = ['priority', 'code', 'name', 'level', 'status'] as const;

/**
 * По умолчанию программы идут по ручному приоритету: справочник существует
 * ради того, чтобы оператор сам решал, что предлагать вузу первым, и алфавит
 * этого решения не выражает. Программы без приоритета идут следом, по названию.
 */
export const programDirectoryQuerySchema = z.object({
	level: z.enum(PROGRAM_LEVELS).nullable().catch(null),
	sortBy: z.enum(PROGRAM_SORT_KEYS).catch('priority'),
	sortDirection,
	...catalogListQuerySchema.shape
});

export const PRODUCT_SORT_KEYS = ['code', 'name', 'status'] as const;

export const productDirectoryQuerySchema = z.object({
	sortBy: z.enum(PRODUCT_SORT_KEYS).catch('code'),
	sortDirection,
	...catalogListQuerySchema.shape
});

/** Состояние направления в фильтре списка: действующие или архивные. */
export const DIRECTION_STATES = ['active', 'archived'] as const;

export type DirectionState = (typeof DIRECTION_STATES)[number];

export const DIRECTION_SORT_KEYS = ['position', 'code', 'name'] as const;

/**
 * Список направлений. По умолчанию — в своём порядке значимости: позиция для
 * того и заведена, а алфавит по коду поставил бы «Аналитику» перед «DevOps»
 * только потому, что так устроена азбука.
 */
export const directionDirectoryQuerySchema = z.object({
	state: z.enum(DIRECTION_STATES).nullable().catch(null),
	q: searchQuery,
	sortBy: z.enum(DIRECTION_SORT_KEYS).catch('position'),
	sortDirection,
	...pageQuerySchema.shape
});

export type CreateOrganizationInput = z.output<typeof createOrganizationSchema>;
export type UpdateOrganizationInput = z.output<typeof updateOrganizationSchema>;
export type OrganizationListQuery = z.output<typeof organizationListQuerySchema>;
export type CreateSiteInput = z.output<typeof createSiteSchema>;
export type UpdateSiteInput = z.output<typeof updateSiteSchema>;
export type CreatePersonInput = z.output<typeof createPersonSchema>;
export type UpdatePersonInput = z.output<typeof updatePersonSchema>;
export type RecordConsentInput = z.output<typeof recordConsentSchema>;
export type WithdrawConsentInput = z.output<typeof withdrawConsentSchema>;
export type SetRetentionInput = z.output<typeof setRetentionSchema>;
export type CreateAffiliationInput = z.output<typeof createAffiliationSchema>;
export type UpdateAffiliationInput = z.output<typeof updateAffiliationSchema>;
export type EndAffiliationInput = z.output<typeof endAffiliationSchema>;
export type CreateProgramInput = z.output<typeof createProgramSchema>;
export type UpdateProgramInput = z.output<typeof updateProgramSchema>;
export type CreateProgramVersionInput = z.output<typeof createProgramVersionSchema>;
export type CreateProductInput = z.output<typeof createProductSchema>;
export type UpdateProductInput = z.output<typeof updateProductSchema>;
export type SaveContractInput = z.output<typeof saveContractSchema>;
export type SaveContractItemInput = z.output<typeof saveContractItemSchema>;
export type ContractListQuery = z.output<typeof contractListQuerySchema>;
export type CatalogListQuery = z.output<typeof catalogListQuerySchema>;
export type OrganizationDirectoryQuery = z.output<typeof organizationDirectoryQuerySchema>;
export type PeopleListQuery = z.output<typeof peopleListQuerySchema>;
export type ProgramDirectoryQuery = z.output<typeof programDirectoryQuerySchema>;
export type ProductDirectoryQuery = z.output<typeof productDirectoryQuerySchema>;
export type DirectionDirectoryQuery = z.output<typeof directionDirectoryQuerySchema>;

/**
 * Представления, которые сервер отдаёт наружу. Строки таблиц Drizzle за
 * границу сервера не выходят: тип ответа описан здесь и не меняется от того,
 * что происходит со схемой базы.
 */
export type OrganizationView = {
	id: string;
	kind: OrganizationKind;
	educationLevel: EducationLevel | null;
	legalName: string;
	shortName: string;
	inn: string | null;
	kpp: string | null;
	ogrn: string | null;
	region: string | null;
	website: string | null;
	notes: string | null;
	isActive: boolean;
	externalSource: string | null;
	externalId: string | null;
	createdAt: Date;
	updatedAt: Date;
};

export type SiteView = {
	id: string;
	organizationId: string;
	kind: SiteKind;
	name: string;
	address: string | null;
	region: string | null;
};

/**
 * Человек в том виде, в каком его можно показать. Контакты заполнены только
 * при праве `people.read_pii`; иначе они замаскированы, и `contactsMasked`
 * говорит интерфейсу, что показывать «скрыто», а не «не указано».
 */
export type PersonView = {
	id: string;
	lastName: string;
	firstName: string;
	middleName: string | null;
	email: string | null;
	phone: string | null;
	notes: string | null;
	contactsMasked: boolean;
	/** До какого дня хранятся данные; `null` — срок не назначен. */
	retentionUntil: string | null;
	/** Когда данные уничтожили. Обезличивание необратимо. */
	anonymizedAt: Date | null;
};

/** Согласие на обработку данных в том виде, в каком его показывает карточка. */
export type ConsentView = {
	id: string;
	personId: string;
	basis: ConsentBasis;
	textVersion: string;
	givenAt: string;
	withdrawnAt: string | null;
	/** Кто зафиксировал и кто отозвал; `null` — если учётной записи уже нет. */
	recordedByName: string | null;
	withdrawnByName: string | null;
};

export type AffiliationView = {
	id: string;
	person: PersonView;
	organizationId: string;
	siteId: string | null;
	position: string;
	roleKind: AffiliationRoleKind;
	isPrimary: boolean;
	validFrom: string;
	validTo: string | null;
	channel: string | null;
};

export type ProgramView = {
	id: string;
	code: string;
	name: string;
	level: ProgramLevel;
	directionCode: string | null;
	/** Ручной приоритет показа; `null` — не назначен. */
	priority: number | null;
	status: LifecycleStatus;
};

export type DirectionView = {
	id: string;
	code: string;
	name: string;
	position: number;
	/** Архивное направление остаётся в списке и в истории, но не предлагается. */
	isActive: boolean;
};

/** Строка списка направлений: само направление и что на него ссылается. */
export type DirectionListItem = {
	direction: DirectionView;
	productCount: number;
	programCount: number;
};

/**
 * Направление вместе со всем, что на него ссылается, — то, что показывает его
 * карточка. Продукты связаны многие ко многим, у программы направление одно.
 */
export type DirectionDetail = {
	direction: DirectionView;
	products: LookupOption[];
	programs: LookupOption[];
};

export type ProductView = {
	id: string;
	code: string;
	name: string;
	vendorOrganizationId: string | null;
	description: string | null;
	status: LifecycleStatus;
};

/** Строка выпадающего списка: показать и вернуть идентификатор. */
export type LookupOption = {
	id: string;
	label: string;
};

/** Версия образовательной программы: что изменилось и с какого дня действует. */
export type ProgramVersionView = {
	id: string;
	programId: string;
	version: number;
	summary: string;
	effectiveFrom: string;
	createdAt: Date;
};

/** Строка списка программ: программа и номер её последней версии. */
export type ProgramListItem = {
	program: ProgramView;
	latestVersion: number | null;
};

/** Программа вместе с историей версий — то, что показывает её карточка. */
export type ProgramDetail = {
	program: ProgramView;
	versions: ProgramVersionView[];
};

/** Продукт вместе с поставщиком: карточка и список показывают его названием. */
export type ProductDetail = {
	product: ProductView;
	vendor: LookupOption | null;
};

/**
 * Контакт вендора по продукту: человек и его роль у правообладателя — кем он
 * там работает и как с ним договорились общаться. Роли нет (`null`), если
 * вендора у продукта сменили, а человек остался связан с прежним.
 */
export type ProductContactView = {
	person: PersonView;
	position: string | null;
	roleKind: AffiliationRoleKind | null;
	channel: string | null;
	/**
	 * Открывается ли карточка человека вызывающему. Контакт вендора виден всем
	 * без области, а карточка человека — по общему правилу видимости людей;
	 * без него имя показывают текстом, а не ссылкой, которая ответит «не найден».
	 */
	openable: boolean;
};

/** Строка списка организаций: сама организация и число её площадок. */
export type OrganizationRow = {
	organization: OrganizationView;
	siteCount: number;
};

/** Строка списка людей: человек и организации, где у него есть роль. */
export type PersonListItem = {
	person: PersonView;
	organizations: LookupOption[];
	/** Срок хранения назначен и прошёл: данные пора уничтожать. */
	retentionExpired: boolean;
};

/**
 * Позиция договора в том виде, в каком её показывают карточка вуза и карточка
 * взаимодействия: продукт назван, а не назван идентификатором.
 */
export type ContractItemView = {
	id: string;
	contractId: string;
	productId: string;
	productCode: string;
	productName: string;
	licenseSignedAt: string | null;
	licenseUntil: string | null;
	transferStatus: string;
};

/** Договор контрагента вместе со своими позициями. */
export type ContractView = {
	id: string;
	organizationId: string;
	number: string;
	signedOn: string | null;
	validUntil: string | null;
	status: ContractStatus;
	items: ContractItemView[];
	/** Версия договора с позициями: форма правки несёт её обратно. */
	editVersion: number;
	createdAt: Date;
	updatedAt: Date;
};

/** Роль человека вместе с названиями организации и площадки. */
export type PersonAffiliationView = {
	affiliation: AffiliationView;
	organization: LookupOption;
	site: LookupOption | null;
};
