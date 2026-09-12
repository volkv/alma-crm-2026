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

/** Кем организация приходится процессу: вуз, компания-заказчик, оператор. */
export const ORGANIZATION_KINDS = [
	'educational_institution',
	'customer_company',
	'operator'
] as const;
/** Уровень образования: высшее, среднее профессиональное, школа. */
export const EDUCATION_LEVELS = ['vo', 'spo', 'school'] as const;
/** Чем является площадка организации. */
export const SITE_KINDS = ['campus', 'branch', 'department', 'other'] as const;
/** Роль человека в организации — от ректора до координатора. */
export const AFFILIATION_ROLE_KINDS = [
	'rector',
	'vice_rector',
	'dean',
	'head_of_department',
	'teacher',
	'coordinator',
	'other'
] as const;
/** Уровень образовательной программы. */
export const PROGRAM_LEVELS = ['bachelor', 'master', 'specialist', 'spo', 'school', 'dpo'] as const;
/** Жизненный цикл записи справочника: черновик → действует → в архиве. */
export const LIFECYCLE_STATUSES = ['draft', 'active', 'archived'] as const;

export type OrganizationKind = (typeof ORGANIZATION_KINDS)[number];
export type EducationLevel = (typeof EDUCATION_LEVELS)[number];
export type SiteKind = (typeof SITE_KINDS)[number];
export type AffiliationRoleKind = (typeof AFFILIATION_ROLE_KINDS)[number];
export type ProgramLevel = (typeof PROGRAM_LEVELS)[number];
export type LifecycleStatus = (typeof LIFECYCLE_STATUSES)[number];

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

const organizationFields = {
	kind: z.enum(ORGANIZATION_KINDS, { error: 'Выберите тип организации' }),
	/** Заполнен ровно у учебных заведений — это же правило проверяет база. */
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
	notes: optionalText(4000),
	isActive: z.boolean().default(true),
	...externalRefFields
};

function educationLevelMatchesKind(value: {
	kind: OrganizationKind;
	educationLevel: EducationLevel | null;
}): boolean {
	return (value.educationLevel !== null) === (value.kind === 'educational_institution');
}

const educationLevelError = {
	error: 'Уровень образования заполняют только у учебных заведений и обязательно у них',
	path: ['educationLevel']
};

export const createOrganizationSchema = z
	.object(organizationFields)
	.refine(externalRefIsPaired, externalRefError)
	.refine(educationLevelMatchesKind, educationLevelError);

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

const affiliationFields = {
	personId: id('Выберите человека'),
	organizationId: id('Выберите организацию'),
	/** Площадка обязана принадлежать той же организации — это проверяет база. */
	siteId: optionalId('Некорректный идентификатор площадки'),
	position: requiredText(300, 'Укажите должность'),
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

export const createAffiliationSchema = z
	.object(affiliationFields)
	.refine(affiliationPeriodIsOrdered, affiliationPeriodError);

export const updateAffiliationSchema = createAffiliationSchema.extend({
	id: id('Некорректный идентификатор роли')
});

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

export const organizationDirectoryQuerySchema = z.object({
	kind: z.enum(ORGANIZATION_KINDS).nullable().catch(null),
	educationLevel: z.enum(EDUCATION_LEVELS).nullable().catch(null),
	q: searchQuery,
	sortBy: z.enum(ORGANIZATION_SORT_KEYS).catch('shortName'),
	sortDirection,
	...pageQuerySchema.shape
});

export const PEOPLE_SORT_KEYS = ['lastName', 'firstName'] as const;

export const peopleListQuerySchema = z.object({
	/** Показать только тех, у кого есть роль в этой организации. */
	organizationId: optionalId('Некорректный идентификатор организации'),
	q: searchQuery,
	sortBy: z.enum(PEOPLE_SORT_KEYS).catch('lastName'),
	sortDirection,
	...pageQuerySchema.shape
});

export const PROGRAM_SORT_KEYS = ['code', 'name', 'level', 'status'] as const;

export const programDirectoryQuerySchema = z.object({
	level: z.enum(PROGRAM_LEVELS).nullable().catch(null),
	sortBy: z.enum(PROGRAM_SORT_KEYS).catch('code'),
	sortDirection,
	...catalogListQuerySchema.shape
});

export const PRODUCT_SORT_KEYS = ['code', 'name', 'status'] as const;

export const productDirectoryQuerySchema = z.object({
	sortBy: z.enum(PRODUCT_SORT_KEYS).catch('code'),
	sortDirection,
	...catalogListQuerySchema.shape
});

export type CreateOrganizationInput = z.output<typeof createOrganizationSchema>;
export type UpdateOrganizationInput = z.output<typeof updateOrganizationSchema>;
export type OrganizationListQuery = z.output<typeof organizationListQuerySchema>;
export type CreateSiteInput = z.output<typeof createSiteSchema>;
export type UpdateSiteInput = z.output<typeof updateSiteSchema>;
export type CreatePersonInput = z.output<typeof createPersonSchema>;
export type UpdatePersonInput = z.output<typeof updatePersonSchema>;
export type CreateAffiliationInput = z.output<typeof createAffiliationSchema>;
export type UpdateAffiliationInput = z.output<typeof updateAffiliationSchema>;
export type EndAffiliationInput = z.output<typeof endAffiliationSchema>;
export type CreateProgramInput = z.output<typeof createProgramSchema>;
export type UpdateProgramInput = z.output<typeof updateProgramSchema>;
export type CreateProgramVersionInput = z.output<typeof createProgramVersionSchema>;
export type CreateProductInput = z.output<typeof createProductSchema>;
export type UpdateProductInput = z.output<typeof updateProductSchema>;
export type CatalogListQuery = z.output<typeof catalogListQuerySchema>;
export type OrganizationDirectoryQuery = z.output<typeof organizationDirectoryQuerySchema>;
export type PeopleListQuery = z.output<typeof peopleListQuerySchema>;
export type ProgramDirectoryQuery = z.output<typeof programDirectoryQuerySchema>;
export type ProductDirectoryQuery = z.output<typeof productDirectoryQuerySchema>;

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
	status: LifecycleStatus;
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

/** Строка списка организаций: сама организация и число её площадок. */
export type OrganizationRow = {
	organization: OrganizationView;
	siteCount: number;
};

/** Строка списка людей: человек и организации, где у него есть роль. */
export type PersonListItem = {
	person: PersonView;
	organizations: LookupOption[];
};

/** Роль человека вместе с названиями организации и площадки. */
export type PersonAffiliationView = {
	affiliation: AffiliationView;
	organization: LookupOption;
	site: LookupOption | null;
};
