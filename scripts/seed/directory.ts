/**
 * Справочники демонстрационного стенда: организации и площадки, люди и их роли,
 * образовательные программы с версиями, продукты.
 *
 * Данные полностью выдуманы. Ни одна организация, площадка, фамилия, почта или
 * телефон не принадлежит настоящему лицу: наименования собраны из
 * географических и отраслевых слов, почта — на `example.org`, телефоны — из
 * диапазона `+7 900 000-00-NN`. Реквизиты (ИНН, КПП, ОГРН) фиктивные, но
 * проходят контрольные суммы: иначе форма организации отвергла бы собственные
 * демонстрационные данные.
 *
 * Каждая строка перед вставкой проходит тот же контракт, что и форма, — сид не
 * имеет права положить в базу то, чего не примет интерфейс.
 */
import { z } from 'zod';
import {
	createAffiliationSchema,
	createOrganizationSchema,
	createPersonSchema,
	createProductSchema,
	createProgramSchema,
	createProgramVersionSchema,
	createSiteSchema,
	recordConsentSchema,
	type AffiliationRoleKind
} from '$lib/contracts/directory';
import {
	affiliations,
	consents,
	directions,
	organizationResponsibles,
	organizations,
	people,
	productDirections,
	products,
	programs,
	programVersions,
	sites
} from '$lib/server/db/schema';
import type { Tx } from '$lib/server/db/transaction';
import { seedId } from './ids';

/**
 * Проверка строки набора контрактом. Контракт бросает ошибку без имени строки,
 * а в наборе из сорока человек это бесполезно, поэтому ключ подставляется сюда.
 */
function checked<TSchema extends z.ZodType>(
	schema: TSchema,
	kind: string,
	key: string,
	raw: z.input<TSchema>
): z.output<TSchema> {
	const result = schema.safeParse(raw);

	if (!result.success) {
		throw new Error(
			`Сид «${kind}/${key}» не прошёл проверку контракта:\n${z.prettifyError(result.error)}`
		);
	}

	return result.data;
}

/**
 * ИТ-направления оператора. Разрез, в котором распределяют ответственность и
 * собирают отчёт: по направлению назначают ответственного за вуз, к нему же
 * привязаны продукты и программы.
 */
const DIRECTIONS: readonly { key: string; code: string; name: string }[] = [
	{ key: 'development', code: 'DEV', name: 'Разработка' },
	{ key: 'devops', code: 'OPS', name: 'Инфраструктура и DevOps' },
	{ key: 'qa', code: 'QA', name: 'Тестирование' },
	{ key: 'analytics', code: 'ANL', name: 'Данные и аналитика' },
	{ key: 'security', code: 'SEC', name: 'Информационная безопасность' }
];

/** Направление программы: у каждой ровно одно, у направления — сколько угодно. */
const PROGRAM_DIRECTIONS: Record<string, string> = {
	'vo-bak-01': 'development',
	'vo-bak-02': 'devops',
	'vo-bak-03': 'development',
	'vo-mag-01': 'analytics',
	'vo-mag-02': 'security',
	'spo-01': 'development',
	'spo-02': 'devops',
	'school-01': 'development',
	'dpo-01': 'development',
	'dpo-02': 'devops'
};

/** Направления продукта: их бывает несколько, и это не ошибка набора. */
const PRODUCT_DIRECTIONS: readonly { productKey: string; directionKeys: readonly string[] }[] = [
	{ productKey: 'lms', directionKeys: ['development'] },
	{ productKey: 'analytics', directionKeys: ['analytics'] },
	{ productKey: 'lab', directionKeys: ['devops'] },
	{ productKey: 'cloud', directionKeys: ['development', 'devops'] },
	{ productKey: 'security', directionKeys: ['security'] },
	{ productKey: 'archive', directionKeys: ['analytics'] }
];

type ResponsibleSeed = {
	key: string;
	organizationKey: string;
	userKey: string;
	/** Направление назначения; без него — ответственный за вуз целиком. */
	directionKey?: string;
	validFrom: string;
	/** Закрытое назначение: так на стенде видно историю, а не только «сейчас». */
	validTo?: string;
};

/**
 * Кто за какой вуз отвечает. У СЗПУ ответственность разделена по направлениям,
 * а прежнее общее назначение закрыто: общее и назначения по направлениям на
 * одном вузе не сосуществуют, и на стенде это видно историей, а не словами.
 */
const RESPONSIBLES: readonly ResponsibleSeed[] = [
	{
		key: 'szpu-general',
		organizationKey: 'szpu',
		userKey: 'zotov',
		validFrom: '2025-09-01T09:00:00+03:00',
		validTo: '2026-06-30T18:00:00+03:00'
	},
	{
		key: 'szpu-development',
		organizationKey: 'szpu',
		userKey: 'demo-manager',
		directionKey: 'development',
		validFrom: '2026-06-30T18:00:00+03:00'
	},
	{
		key: 'szpu-analytics',
		organizationKey: 'szpu',
		userKey: 'veresova',
		directionKey: 'analytics',
		validFrom: '2026-06-30T18:00:00+03:00'
	},
	{
		key: 'paid',
		organizationKey: 'paid',
		userKey: 'demo-manager',
		validFrom: '2026-01-15T09:00:00+03:00'
	},
	{
		key: 'school47',
		organizationKey: 'school47',
		userKey: 'demo-manager',
		validFrom: '2026-02-01T09:00:00+03:00'
	},
	{
		key: 'sruit',
		organizationKey: 'sruit',
		userKey: 'demo-manager',
		validFrom: '2026-02-01T09:00:00+03:00'
	},
	{
		key: 'bit',
		organizationKey: 'bit',
		userKey: 'demo-manager',
		validFrom: '2026-03-10T09:00:00+03:00'
	},
	{
		key: 'nkis',
		organizationKey: 'nkis',
		userKey: 'demo-manager',
		validFrom: '2026-03-10T09:00:00+03:00'
	},
	{
		key: 'pupi',
		organizationKey: 'pupi',
		userKey: 'veresova',
		validFrom: '2026-01-20T09:00:00+03:00'
	},
	{
		key: 'uguis',
		organizationKey: 'uguis',
		userKey: 'veresova',
		validFrom: '2026-01-20T09:00:00+03:00'
	},
	{
		key: 'vkgtu',
		organizationKey: 'vkgtu',
		userKey: 'veresova',
		validFrom: '2026-02-16T09:00:00+03:00'
	},
	{ key: 'vts', organizationKey: 'vts', userKey: 'zotov', validFrom: '2026-01-20T09:00:00+03:00' },
	{
		key: 'skpa',
		organizationKey: 'skpa',
		userKey: 'zotov',
		validFrom: '2026-02-16T09:00:00+03:00'
	},
	{
		key: 'ukct',
		organizationKey: 'ukct',
		userKey: 'zotov',
		validFrom: '2026-03-02T09:00:00+03:00'
	},
	{ key: 'sivt', organizationKey: 'sivt', userKey: 'zotov', validFrom: '2026-03-02T09:00:00+03:00' }
];

type OrganizationSeed = { key: string } & z.input<typeof createOrganizationSchema>;

const ORGANIZATIONS: readonly OrganizationSeed[] = [
	{
		key: 'szpu',
		kind: 'educational_institution',
		educationLevel: 'vo',
		legalName:
			'Федеральное государственное бюджетное образовательное учреждение высшего образования «Северо-Западный политехнический университет»',
		shortName: 'СЗПУ',
		inn: '7802450127',
		kpp: '780201450',
		ogrn: '1057802450122',
		region: 'г. Санкт-Петербург',
		website: 'https://szpu.example.org',
		notes: 'Опорный партнёр по направлению прикладной информатики.'
	},
	{
		key: 'pupi',
		kind: 'educational_institution',
		educationLevel: 'vo',
		legalName:
			'Федеральное государственное автономное образовательное учреждение высшего образования «Приволжский университет прикладной информатики»',
		shortName: 'ПУПИ',
		inn: '5203660080',
		kpp: '520301660',
		ogrn: '1065203660081',
		region: 'Нижегородская область',
		website: 'https://pupi.example.org'
	},
	{
		key: 'uguis',
		kind: 'educational_institution',
		educationLevel: 'vo',
		legalName:
			'Федеральное государственное бюджетное образовательное учреждение высшего образования «Уральский государственный университет инженерных систем»',
		shortName: 'УГУИС',
		inn: '6604170038',
		kpp: '660401170',
		ogrn: '1046604170030',
		region: 'Свердловская область',
		website: 'https://uguis.example.org'
	},
	{
		key: 'sivt',
		kind: 'educational_institution',
		educationLevel: 'vo',
		legalName: 'Автономная некоммерческая организация «Сибирский институт вычислительной техники»',
		shortName: 'СИВТ',
		inn: '5405900217',
		kpp: '540501900',
		ogrn: '1075405900217',
		region: 'Новосибирская область',
		website: 'https://sivt.example.org'
	},
	{
		key: 'yutus',
		kind: 'educational_institution',
		educationLevel: 'vo',
		legalName:
			'Федеральное государственное бюджетное образовательное учреждение высшего образования «Южный технологический университет связи»',
		shortName: 'ЮТУС',
		inn: '6106330049',
		kpp: '610601330',
		ogrn: '1036106330040',
		region: 'Ростовская область',
		website: 'https://yutus.example.org'
	},
	{
		key: 'batse',
		kind: 'educational_institution',
		educationLevel: 'vo',
		legalName: 'Частное образовательное учреждение «Балтийская академия цифровой экономики»',
		shortName: 'БАЦЭ',
		inn: '3901070023',
		kpp: '390101070',
		ogrn: '1113901070029',
		region: 'Калининградская область',
		website: 'https://batse.example.org'
	},
	{
		key: 'vkgtu',
		kind: 'educational_institution',
		educationLevel: 'vo',
		legalName:
			'Федеральное государственное бюджетное образовательное учреждение высшего образования «Волго-Камский государственный технический университет»',
		shortName: 'ВКГТУ',
		inn: '1607540030',
		kpp: '160701540',
		ogrn: '1021607540030',
		region: 'Республика Татарстан',
		website: 'https://vkgtu.example.org'
	},
	{
		key: 'sruit',
		kind: 'educational_institution',
		educationLevel: 'vo',
		legalName:
			'Федеральное государственное автономное образовательное учреждение высшего образования «Среднерусский университет информационных технологий»',
		shortName: 'СУИТ',
		inn: '5008280045',
		kpp: '500801280',
		ogrn: '1095008280047',
		region: 'Московская область',
		website: 'https://sruit.example.org'
	},
	{
		key: 'bit',
		kind: 'educational_institution',
		educationLevel: 'vo',
		legalName: 'Автономная некоммерческая организация «Беломорский институт телекоммуникаций»',
		shortName: 'БИТ',
		inn: '2901010054',
		kpp: '290101010',
		ogrn: '1102901010057',
		region: 'Архангельская область',
		website: 'https://bit-edu.example.org'
	},
	{
		key: 'puts',
		kind: 'educational_institution',
		educationLevel: 'vo',
		legalName:
			'Федеральное государственное бюджетное образовательное учреждение высшего образования «Прибайкальский университет транспорта и связи»',
		shortName: 'ПУТС',
		inn: '3802440065',
		kpp: '380201440',
		ogrn: '1083802440061',
		region: 'Иркутская область',
		website: 'https://puts.example.org'
	},
	{
		key: 'zipm',
		kind: 'educational_institution',
		educationLevel: 'vo',
		legalName: 'Частное образовательное учреждение «Заволжский институт прикладной математики»',
		shortName: 'ЗИПМ',
		inn: '6403550079',
		kpp: '640301550',
		ogrn: '1126403550074',
		region: 'Саратовская область',
		website: 'https://zipm.example.org',
		isActive: false,
		notes: 'Сотрудничество приостановлено до пересмотра программы подготовки.'
	},
	{
		key: 'paid',
		kind: 'educational_institution',
		educationLevel: 'vo',
		legalName:
			'Федеральное государственное автономное образовательное учреждение высшего образования «Приморская академия инженерии данных»',
		shortName: 'ПАИД',
		inn: '2504330080',
		kpp: '250401330',
		ogrn: '1132504330089',
		region: 'Приморский край',
		website: 'https://paid-edu.example.org'
	},
	{
		key: 'ukct',
		kind: 'educational_institution',
		educationLevel: 'spo',
		legalName:
			'Государственное автономное профессиональное образовательное учреждение «Уральский колледж цифровых технологий»',
		shortName: 'УКЦТ',
		inn: '6605170094',
		kpp: '660501170',
		ogrn: '1146605170095',
		region: 'Свердловская область',
		website: 'https://ukct.example.org'
	},
	{
		key: 'nkis',
		kind: 'educational_institution',
		educationLevel: 'spo',
		legalName:
			'Государственное бюджетное профессиональное образовательное учреждение «Невский колледж информационных систем»',
		shortName: 'НКИС',
		inn: '7806450209',
		kpp: '780601450',
		ogrn: '1157806450207',
		region: 'г. Санкт-Петербург',
		website: 'https://nkis.example.org'
	},
	{
		key: 'vts',
		kind: 'educational_institution',
		educationLevel: 'spo',
		legalName:
			'Государственное профессиональное образовательное учреждение «Верхневолжский техникум связи»',
		shortName: 'ВТС',
		inn: '7607040110',
		kpp: '760701040',
		ogrn: '1107607040111',
		region: 'Ярославская область',
		website: 'https://vts.example.org'
	},
	{
		key: 'skpa',
		kind: 'educational_institution',
		educationLevel: 'spo',
		legalName:
			'Государственное автономное профессиональное образовательное учреждение «Степной колледж промышленной автоматики»',
		shortName: 'СКПА',
		inn: '5608020120',
		kpp: '560801020',
		ogrn: '1165608020126',
		region: 'Оренбургская область',
		website: 'https://skpa.example.org'
	},
	{
		key: 'lyceum306',
		kind: 'educational_institution',
		educationLevel: 'school',
		legalName: 'Государственное бюджетное общеобразовательное учреждение «Лицей № 306 „Гравитон“»',
		shortName: 'Лицей № 306 «Гравитон»',
		inn: '5009360335',
		kpp: '500901360',
		ogrn: '1015009360332',
		region: 'Московская область',
		website: 'https://lyceum306.example.org'
	},
	{
		key: 'school47',
		kind: 'educational_institution',
		educationLevel: 'school',
		legalName:
			'Муниципальное бюджетное общеобразовательное учреждение «Инженерная школа № 47 „Вектор“»',
		shortName: 'Школа № 47 «Вектор»',
		inn: '5410900340',
		kpp: '541001900',
		ogrn: '1125410900340',
		region: 'Новосибирская область',
		website: 'https://school47.example.org'
	},
	{
		key: 'digital',
		kind: 'customer_company',
		legalName: 'Общество с ограниченной ответственностью «Цифровые решения»',
		shortName: 'Цифровые решения',
		inn: '7711360451',
		kpp: '771101360',
		ogrn: '1177711360452',
		region: 'г. Москва',
		website: 'https://digital-solutions.example.com',
		notes: 'Берёт стажёров на направление прикладной информатики.'
	},
	{
		key: 'technosphere',
		kind: 'customer_company',
		legalName: 'Общество с ограниченной ответственностью «ТехноСфера Софт»',
		shortName: 'ТехноСфера Софт',
		inn: '6312100562',
		kpp: '631201100',
		ogrn: '1186312100567',
		region: 'Самарская область',
		website: 'https://technosphere-soft.example.com'
	},
	{
		key: 'irbis',
		kind: 'customer_company',
		legalName: 'Общество с ограниченной ответственностью «Ирбис Аналитика»',
		shortName: 'Ирбис Аналитика',
		inn: '5913020670',
		kpp: '591301020',
		ogrn: '1195913020676',
		region: 'Пермский край',
		website: 'https://irbis-analytics.example.com'
	},
	{
		key: 'meridian',
		kind: 'customer_company',
		legalName: 'Общество с ограниченной ответственностью «Меридиан Инжиниринг»',
		shortName: 'Меридиан Инжиниринг',
		inn: '3614040787',
		kpp: '361401040',
		ogrn: '1163614040787',
		region: 'Воронежская область',
		website: 'https://meridian-eng.example.com'
	},
	{
		key: 'ladoga',
		kind: 'customer_company',
		legalName: 'Акционерное общество «Ладога Датасистемс»',
		shortName: 'Ладога Датасистемс',
		inn: '7815450893',
		kpp: '781501450',
		ogrn: '1147815450892',
		region: 'г. Санкт-Петербург',
		website: 'https://ladoga-data.example.com'
	},
	{
		key: 'polarcode',
		kind: 'customer_company',
		legalName: 'Общество с ограниченной ответственностью «Полярный код»',
		shortName: 'Полярный код',
		inn: '2916010900',
		kpp: '291601010',
		ogrn: '1202916010901',
		region: 'Архангельская область',
		website: 'https://polarcode.example.com'
	},
	{
		key: 'operator',
		kind: 'operator',
		legalName:
			'Автономная некоммерческая организация дополнительного профессионального образования «Учебный центр цифровых компетенций»',
		shortName: 'УЦЦК',
		inn: '7717361010',
		kpp: '771701361',
		ogrn: '1137717361011',
		region: 'г. Москва',
		website: 'https://ucck.example.org',
		notes: 'Оператор образовательных программ; от его имени ведётся весь процесс.'
	}
];

type SiteSeed = {
	key: string;
	organizationKey: string;
} & Omit<z.input<typeof createSiteSchema>, 'organizationId'>;

const SITES: readonly SiteSeed[] = [
	{
		key: 'szpu-main',
		organizationKey: 'szpu',
		kind: 'campus',
		name: 'Главный кампус',
		address: 'г. Санкт-Петербург, Инженерный проезд, 4',
		region: 'г. Санкт-Петербург'
	},
	{
		key: 'szpu-branch-pskov',
		organizationKey: 'szpu',
		kind: 'branch',
		name: 'Псковский филиал',
		address: 'Псковская область, г. Псков, ул. Заводская, 12',
		region: 'Псковская область'
	},
	{
		key: 'szpu-dept-is',
		organizationKey: 'szpu',
		kind: 'department',
		name: 'Кафедра информационных систем',
		address: 'г. Санкт-Петербург, Инженерный проезд, 4, корпус Б',
		region: 'г. Санкт-Петербург'
	},
	{
		key: 'pupi-main',
		organizationKey: 'pupi',
		kind: 'campus',
		name: 'Кампус на Волжской набережной',
		address: 'Нижегородская область, г. Нижний Новгород, Волжская набережная, 21',
		region: 'Нижегородская область'
	},
	{
		key: 'pupi-dept-ai',
		organizationKey: 'pupi',
		kind: 'department',
		name: 'Факультет прикладной информатики',
		address: 'Нижегородская область, г. Нижний Новгород, Волжская набережная, 21, корпус 3',
		region: 'Нижегородская область'
	},
	{
		key: 'uguis-main',
		organizationKey: 'uguis',
		kind: 'campus',
		name: 'Учебный городок',
		address: 'Свердловская область, г. Екатеринбург, ул. Машинная, 38',
		region: 'Свердловская область'
	},
	{
		key: 'uguis-dept-auto',
		organizationKey: 'uguis',
		kind: 'department',
		name: 'Кафедра автоматизации производств',
		address: 'Свердловская область, г. Екатеринбург, ул. Машинная, 38, корпус В',
		region: 'Свердловская область'
	},
	{
		key: 'sivt-main',
		organizationKey: 'sivt',
		kind: 'campus',
		name: 'Учебный корпус на Русской',
		address: 'Новосибирская область, г. Новосибирск, ул. Русская, 7',
		region: 'Новосибирская область'
	},
	{
		key: 'vkgtu-main',
		organizationKey: 'vkgtu',
		kind: 'campus',
		name: 'Главный корпус',
		address: 'Республика Татарстан, г. Казань, ул. Волжская, 19',
		region: 'Республика Татарстан'
	},
	{
		key: 'vkgtu-branch-chelny',
		organizationKey: 'vkgtu',
		kind: 'branch',
		name: 'Филиал в Набережных Челнах',
		address: 'Республика Татарстан, г. Набережные Челны, проспект Мира, 88',
		region: 'Республика Татарстан'
	},
	{
		key: 'vkgtu-dept-comm',
		organizationKey: 'vkgtu',
		kind: 'department',
		name: 'Кафедра систем связи',
		address: 'Республика Татарстан, г. Казань, ул. Волжская, 19, корпус 2',
		region: 'Республика Татарстан'
	},
	{
		key: 'ukct-main',
		organizationKey: 'ukct',
		kind: 'campus',
		name: 'Учебный корпус',
		address: 'Свердловская область, г. Екатеринбург, ул. Тепличная, 5',
		region: 'Свердловская область'
	},
	{
		key: 'nkis-main',
		organizationKey: 'nkis',
		kind: 'campus',
		name: 'Учебный корпус на Обводном',
		address: 'г. Санкт-Петербург, Обводный канал, 134',
		region: 'г. Санкт-Петербург'
	},
	{
		key: 'nkis-lab',
		organizationKey: 'nkis',
		kind: 'other',
		name: 'Лаборатория сетевых технологий',
		address: 'г. Санкт-Петербург, Обводный канал, 134, литера А',
		region: 'г. Санкт-Петербург'
	},
	{
		key: 'paid-main',
		organizationKey: 'paid',
		kind: 'campus',
		name: 'Кампус на Океанском проспекте',
		address: 'Приморский край, г. Владивосток, Океанский проспект, 62',
		region: 'Приморский край'
	}
];

type PersonSeed = z.input<typeof createPersonSchema> & {
	key: string;
	/** Первая роль человека; остальные — в `EXTRA_AFFILIATIONS`. */
	affiliation: AffiliationSeedFields;
	/**
	 * До какого дня хранятся персональные данные. Даты абсолютные: набор должен
	 * выглядеть одинаково и сегодня, и через месяц.
	 */
	retentionUntil?: string;
};

/** Согласие демонстрационного человека на обработку его данных. */
type ConsentSeed = {
	key: string;
	personKey: string;
	basis: z.input<typeof recordConsentSchema>['basis'];
	textVersion: string;
	givenAt: string;
	withdrawnAt?: string;
};

/**
 * Учёт персональных данных на стенде: согласия трёх видов, отозванное согласие
 * и истёкший срок хранения. Без них панель «Персональные данные» на карточке
 * человека пуста, и показать, чем она отвечает на 152-ФЗ, нечем.
 */
const CONSENTS: readonly ConsentSeed[] = [
	{
		key: 'belskaya-2026',
		personKey: 'belskaya',
		basis: 'consent',
		textVersion: '2026-01-12',
		givenAt: '2026-01-12'
	},
	{
		key: 'astakhov-2025',
		personKey: 'astakhov',
		basis: 'contract',
		textVersion: '2025-09-01',
		givenAt: '2025-09-01'
	},
	{
		key: 'guryev-2024',
		personKey: 'guryev',
		basis: 'consent',
		textVersion: '2024-02-20',
		givenAt: '2024-02-20',
		withdrawnAt: '2026-03-04'
	},
	{
		key: 'drozdova-2026',
		personKey: 'drozdova',
		basis: 'legal',
		textVersion: '2026-02-01',
		givenAt: '2026-02-01'
	}
];

type AffiliationSeedFields = {
	organizationKey: string;
	siteKey?: string;
	position: string;
	roleKind: AffiliationRoleKind;
	isPrimary?: boolean;
	validFrom: string;
	validTo?: string;
	channel?: string;
};

const PEOPLE: readonly PersonSeed[] = [
	{
		key: 'astakhov',
		lastName: 'Астахов',
		firstName: 'Игорь',
		middleName: 'Леонидович',
		email: 'i.astakhov@szpu.example.org',
		phone: '+7 900 000-00-01',
		affiliation: {
			organizationKey: 'szpu',
			siteKey: 'szpu-main',
			position: 'Ректор',
			roleKind: 'rector',
			validFrom: '2019-09-01',
			channel: 'Почта'
		}
	},
	{
		key: 'belskaya',
		retentionUntil: '2029-01-12',
		lastName: 'Бельская',
		firstName: 'Марина',
		middleName: 'Юрьевна',
		email: 'm.belskaya@szpu.example.org',
		phone: '+7 900 000-00-02',
		affiliation: {
			organizationKey: 'szpu',
			siteKey: 'szpu-main',
			position: 'Проректор по цифровому развитию',
			roleKind: 'vice_rector',
			isPrimary: true,
			validFrom: '2021-02-15',
			channel: 'Почта, телефон'
		}
	},
	{
		key: 'guryev',
		// Согласие отозвано, а срок хранения прошёл: этот человек и есть очередь
		// на уничтожение данных, которую показывает фильтр списка.
		retentionUntil: '2026-06-30',
		lastName: 'Гурьев',
		firstName: 'Никита',
		middleName: 'Павлович',
		email: 'n.guryev@szpu.example.org',
		phone: '+7 900 000-00-03',
		affiliation: {
			organizationKey: 'szpu',
			siteKey: 'szpu-dept-is',
			position: 'Декан факультета информационных технологий',
			roleKind: 'dean',
			validFrom: '2020-09-01'
		}
	},
	{
		key: 'drozdova',
		retentionUntil: '2028-02-01',
		lastName: 'Дроздова',
		firstName: 'Елена',
		middleName: 'Аркадьевна',
		email: 'e.drozdova@szpu.example.org',
		phone: '+7 900 000-00-04',
		affiliation: {
			organizationKey: 'szpu',
			siteKey: 'szpu-dept-is',
			position: 'Заведующая кафедрой информационных систем',
			roleKind: 'head_of_department',
			validFrom: '2018-09-01'
		}
	},
	{
		key: 'efimov',
		lastName: 'Ефимов',
		firstName: 'Роман',
		middleName: 'Сергеевич',
		email: 'r.efimov@szpu.example.org',
		phone: '+7 900 000-00-05',
		affiliation: {
			organizationKey: 'szpu',
			siteKey: 'szpu-dept-is',
			position: 'Доцент кафедры информационных систем',
			roleKind: 'teacher',
			validFrom: '2022-09-01'
		}
	},
	{
		key: 'zharova',
		lastName: 'Жарова',
		firstName: 'Ксения',
		middleName: 'Дмитриевна',
		email: 'k.zharova@pupi.example.org',
		phone: '+7 900 000-00-06',
		affiliation: {
			organizationKey: 'pupi',
			siteKey: 'pupi-main',
			position: 'Ректор',
			roleKind: 'rector',
			validFrom: '2017-06-01'
		}
	},
	{
		key: 'zimin',
		lastName: 'Зимин',
		firstName: 'Артём',
		middleName: 'Валерьевич',
		email: 'a.zimin@pupi.example.org',
		phone: '+7 900 000-00-07',
		affiliation: {
			organizationKey: 'pupi',
			siteKey: 'pupi-main',
			position: 'Проректор по учебной работе',
			roleKind: 'vice_rector',
			validFrom: '2019-03-01',
			validTo: '2024-08-31'
		}
	},
	{
		key: 'ignatyeva',
		lastName: 'Игнатьева',
		firstName: 'Ольга',
		middleName: 'Николаевна',
		email: 'o.ignatyeva@pupi.example.org',
		phone: '+7 900 000-00-08',
		affiliation: {
			organizationKey: 'pupi',
			siteKey: 'pupi-dept-ai',
			position: 'Координатор партнёрских программ',
			roleKind: 'coordinator',
			isPrimary: true,
			validFrom: '2023-01-10',
			channel: 'Почта'
		}
	},
	{
		key: 'koltsov',
		lastName: 'Кольцов',
		firstName: 'Денис',
		middleName: 'Анатольевич',
		email: 'd.koltsov@uguis.example.org',
		phone: '+7 900 000-00-09',
		affiliation: {
			organizationKey: 'uguis',
			siteKey: 'uguis-main',
			position: 'Ректор',
			roleKind: 'rector',
			isPrimary: true,
			validFrom: '2016-11-01'
		}
	},
	{
		key: 'lapina',
		lastName: 'Лапина',
		firstName: 'Светлана',
		middleName: 'Егоровна',
		email: 's.lapina@uguis.example.org',
		phone: '+7 900 000-00-10',
		affiliation: {
			organizationKey: 'uguis',
			siteKey: 'uguis-main',
			position: 'Декан инженерного факультета',
			roleKind: 'dean',
			validFrom: '2020-01-20'
		}
	},
	{
		key: 'mukhin',
		lastName: 'Мухин',
		firstName: 'Тимур',
		middleName: 'Рустамович',
		email: 't.mukhin@uguis.example.org',
		phone: '+7 900 000-00-11',
		affiliation: {
			organizationKey: 'uguis',
			siteKey: 'uguis-dept-auto',
			position: 'Заведующий кафедрой автоматизации производств',
			roleKind: 'head_of_department',
			validFrom: '2021-09-01'
		}
	},
	{
		key: 'nesterov',
		lastName: 'Нестеров',
		firstName: 'Виктор',
		middleName: 'Ильич',
		email: 'v.nesterov@sivt.example.org',
		phone: '+7 900 000-00-12',
		affiliation: {
			organizationKey: 'sivt',
			siteKey: 'sivt-main',
			position: 'Директор института',
			roleKind: 'other',
			isPrimary: true,
			validFrom: '2015-04-01'
		}
	},
	{
		key: 'orekhova',
		lastName: 'Орехова',
		firstName: 'Алина',
		middleName: 'Максимовна',
		email: 'a.orekhova@sivt.example.org',
		phone: '+7 900 000-00-13',
		affiliation: {
			organizationKey: 'sivt',
			siteKey: 'sivt-main',
			position: 'Заместитель директора по развитию',
			roleKind: 'vice_rector',
			validFrom: '2018-08-15'
		}
	},
	{
		key: 'pankratov',
		lastName: 'Панкратов',
		firstName: 'Сергей',
		middleName: 'Львович',
		email: 's.pankratov@sivt.example.org',
		phone: '+7 900 000-00-14',
		affiliation: {
			organizationKey: 'sivt',
			position: 'Преподаватель курса разработки',
			roleKind: 'teacher',
			validFrom: '2019-09-01',
			validTo: '2023-06-30'
		}
	},
	{
		key: 'rodionova',
		lastName: 'Родионова',
		firstName: 'Вера',
		middleName: 'Степановна',
		email: 'v.rodionova@yutus.example.org',
		phone: '+7 900 000-00-15',
		affiliation: {
			organizationKey: 'yutus',
			position: 'Ректор',
			roleKind: 'rector',
			isPrimary: true,
			validFrom: '2018-05-14'
		}
	},
	{
		key: 'savelyev',
		lastName: 'Савельев',
		firstName: 'Артур',
		middleName: 'Геннадьевич',
		email: 'a.savelyev@yutus.example.org',
		phone: '+7 900 000-00-16',
		affiliation: {
			organizationKey: 'yutus',
			position: 'Координатор образовательных проектов',
			roleKind: 'coordinator',
			validFrom: '2022-02-01',
			channel: 'Телефон'
		}
	},
	{
		key: 'tarasyuk',
		lastName: 'Тарасюк',
		firstName: 'Илья',
		middleName: 'Борисович',
		email: 'i.tarasyuk@batse.example.org',
		phone: '+7 900 000-00-17',
		affiliation: {
			organizationKey: 'batse',
			position: 'Ректор',
			roleKind: 'rector',
			isPrimary: true,
			validFrom: '2020-10-01'
		}
	},
	{
		key: 'ulyanova',
		lastName: 'Ульянова',
		firstName: 'Дарья',
		middleName: 'Кирилловна',
		email: 'd.ulyanova@batse.example.org',
		phone: '+7 900 000-00-18',
		affiliation: {
			organizationKey: 'batse',
			position: 'Заведующая кафедрой цифровой экономики',
			roleKind: 'head_of_department',
			validFrom: '2021-09-01'
		}
	},
	{
		key: 'fedotov',
		lastName: 'Федотов',
		firstName: 'Марат',
		middleName: 'Наилевич',
		email: 'm.fedotov@vkgtu.example.org',
		phone: '+7 900 000-00-19',
		affiliation: {
			organizationKey: 'vkgtu',
			siteKey: 'vkgtu-main',
			position: 'Ректор',
			roleKind: 'rector',
			validFrom: '2014-12-01'
		}
	},
	{
		key: 'khabibullina',
		lastName: 'Хабибуллина',
		firstName: 'Лилия',
		middleName: 'Ринатовна',
		email: 'l.khabibullina@vkgtu.example.org',
		phone: '+7 900 000-00-20',
		affiliation: {
			organizationKey: 'vkgtu',
			siteKey: 'vkgtu-main',
			position: 'Проректор по внешним связям',
			roleKind: 'vice_rector',
			isPrimary: true,
			validFrom: '2019-07-01',
			channel: 'Почта'
		}
	},
	{
		key: 'tsvetkov',
		lastName: 'Цветков',
		firstName: 'Егор',
		middleName: 'Михайлович',
		email: 'e.tsvetkov@vkgtu.example.org',
		phone: '+7 900 000-00-21',
		affiliation: {
			organizationKey: 'vkgtu',
			siteKey: 'vkgtu-dept-comm',
			position: 'Декан факультета связи',
			roleKind: 'dean',
			validFrom: '2020-09-01'
		}
	},
	{
		key: 'chernysheva',
		lastName: 'Чернышёва',
		firstName: 'Полина',
		middleName: 'Олеговна',
		email: 'p.chernysheva@sruit.example.org',
		phone: '+7 900 000-00-22',
		affiliation: {
			organizationKey: 'sruit',
			position: 'Ректор',
			roleKind: 'rector',
			isPrimary: true,
			validFrom: '2021-01-11'
		}
	},
	{
		key: 'shilov',
		lastName: 'Шилов',
		firstName: 'Кирилл',
		middleName: 'Андреевич',
		email: 'k.shilov@sruit.example.org',
		phone: '+7 900 000-00-23',
		affiliation: {
			organizationKey: 'sruit',
			position: 'Координатор программ дополнительного образования',
			roleKind: 'coordinator',
			validFrom: '2022-09-01'
		}
	},
	{
		key: 'shcherbak',
		lastName: 'Щербак',
		firstName: 'Антон',
		middleName: 'Валентинович',
		email: 'a.shcherbak@bit-edu.example.org',
		phone: '+7 900 000-00-24',
		affiliation: {
			organizationKey: 'bit',
			position: 'Директор института',
			roleKind: 'other',
			isPrimary: true,
			validFrom: '2016-02-01'
		}
	},
	{
		key: 'eldarova',
		lastName: 'Эльдарова',
		firstName: 'Замира',
		middleName: 'Руслановна',
		email: 'z.eldarova@bit-edu.example.org',
		phone: '+7 900 000-00-25',
		affiliation: {
			organizationKey: 'bit',
			position: 'Преподаватель кафедры телекоммуникаций',
			roleKind: 'teacher',
			validFrom: '2020-09-01'
		}
	},
	{
		key: 'yurchenko',
		lastName: 'Юрченко',
		firstName: 'Глеб',
		middleName: 'Максимович',
		email: 'g.yurchenko@puts.example.org',
		phone: '+7 900 000-00-26',
		affiliation: {
			organizationKey: 'puts',
			position: 'Ректор',
			roleKind: 'rector',
			isPrimary: true,
			validFrom: '2017-09-01'
		}
	},
	{
		key: 'yakovleva',
		lastName: 'Яковлева',
		firstName: 'Нина',
		middleName: 'Петровна',
		email: 'n.yakovleva@puts.example.org',
		phone: '+7 900 000-00-27',
		affiliation: {
			organizationKey: 'puts',
			position: 'Заведующая кафедрой телекоммуникаций',
			roleKind: 'head_of_department',
			validFrom: '2019-09-01'
		}
	},
	{
		key: 'abramov',
		lastName: 'Абрамов',
		firstName: 'Леонид',
		middleName: 'Тимофеевич',
		email: 'l.abramov@zipm.example.org',
		phone: '+7 900 000-00-28',
		affiliation: {
			organizationKey: 'zipm',
			position: 'Директор',
			roleKind: 'other',
			isPrimary: true,
			validFrom: '2018-03-01',
			validTo: '2025-02-28'
		}
	},
	{
		key: 'belov',
		lastName: 'Белов',
		firstName: 'Станислав',
		middleName: 'Юрьевич',
		email: 's.belov@zipm.example.org',
		phone: '+7 900 000-00-29',
		affiliation: {
			organizationKey: 'zipm',
			position: 'Преподаватель прикладной математики',
			roleKind: 'teacher',
			validFrom: '2019-09-01',
			validTo: '2025-02-28'
		}
	},
	{
		key: 'vikhrova',
		lastName: 'Вихрова',
		firstName: 'Юлия',
		middleName: 'Андреевна',
		email: 'y.vikhrova@paid-edu.example.org',
		phone: '+7 900 000-00-30',
		affiliation: {
			organizationKey: 'paid',
			siteKey: 'paid-main',
			position: 'Ректор',
			roleKind: 'rector',
			isPrimary: true,
			validFrom: '2020-06-15'
		}
	},
	{
		key: 'gorbunova',
		lastName: 'Горбунова',
		firstName: 'Ирина',
		middleName: 'Валентиновна',
		email: 'i.gorbunova@paid-edu.example.org',
		phone: '+7 900 000-00-31',
		affiliation: {
			organizationKey: 'paid',
			siteKey: 'paid-main',
			position: 'Координатор практик и стажировок',
			roleKind: 'coordinator',
			validFrom: '2023-09-01',
			channel: 'Почта'
		}
	},
	{
		key: 'dementyev',
		lastName: 'Дементьев',
		firstName: 'Олег',
		middleName: 'Романович',
		email: 'o.dementyev@ukct.example.org',
		phone: '+7 900 000-00-32',
		affiliation: {
			organizationKey: 'ukct',
			siteKey: 'ukct-main',
			position: 'Директор колледжа',
			roleKind: 'other',
			isPrimary: true,
			validFrom: '2019-08-01'
		}
	},
	{
		key: 'ershova',
		lastName: 'Ершова',
		firstName: 'Наталья',
		middleName: 'Викторовна',
		email: 'n.ershova@ukct.example.org',
		phone: '+7 900 000-00-33',
		affiliation: {
			organizationKey: 'ukct',
			siteKey: 'ukct-main',
			position: 'Заместитель директора по учебной работе',
			roleKind: 'other',
			validFrom: '2020-09-01'
		}
	},
	{
		key: 'zueva',
		lastName: 'Зуева',
		firstName: 'Маргарита',
		middleName: 'Львовна',
		email: 'm.zueva@nkis.example.org',
		phone: '+7 900 000-00-34',
		affiliation: {
			organizationKey: 'nkis',
			siteKey: 'nkis-main',
			position: 'Директор колледжа',
			roleKind: 'other',
			isPrimary: true,
			validFrom: '2017-08-01'
		}
	},
	{
		key: 'ilyin',
		lastName: 'Ильин',
		firstName: 'Роман',
		middleName: 'Денисович',
		email: 'r.ilyin@nkis.example.org',
		phone: '+7 900 000-00-35',
		affiliation: {
			organizationKey: 'nkis',
			siteKey: 'nkis-lab',
			position: 'Преподаватель специальных дисциплин',
			roleKind: 'teacher',
			validFrom: '2021-09-01'
		}
	},
	{
		key: 'karpov',
		lastName: 'Карпов',
		firstName: 'Вадим',
		middleName: 'Игоревич',
		email: 'v.karpov@vts.example.org',
		phone: '+7 900 000-00-36',
		affiliation: {
			organizationKey: 'vts',
			position: 'Заведующий отделением связи',
			roleKind: 'head_of_department',
			isPrimary: true,
			validFrom: '2018-09-01'
		}
	},
	{
		key: 'lebedeva',
		lastName: 'Лебедева',
		firstName: 'Оксана',
		middleName: 'Тимуровна',
		email: 'o.lebedeva@skpa.example.org',
		phone: '+7 900 000-00-37',
		affiliation: {
			organizationKey: 'skpa',
			position: 'Директор техникума',
			roleKind: 'other',
			isPrimary: true,
			validFrom: '2016-08-15'
		}
	},
	{
		key: 'morozov',
		lastName: 'Морозов',
		firstName: 'Пётр',
		middleName: 'Аркадьевич',
		email: 'p.morozov@lyceum306.example.org',
		phone: '+7 900 000-00-38',
		affiliation: {
			organizationKey: 'lyceum306',
			position: 'Директор лицея',
			roleKind: 'other',
			isPrimary: true,
			validFrom: '2015-09-01'
		}
	},
	{
		key: 'novikova',
		lastName: 'Новикова',
		firstName: 'Алиса',
		middleName: 'Германовна',
		email: 'a.novikova@school47.example.org',
		phone: '+7 900 000-00-39',
		affiliation: {
			organizationKey: 'school47',
			position: 'Заместитель директора по проектной работе',
			roleKind: 'other',
			isPrimary: true,
			validFrom: '2021-09-01',
			channel: 'Почта'
		}
	},
	{
		key: 'orlov',
		lastName: 'Орлов',
		firstName: 'Кирилл',
		middleName: 'Вадимович',
		email: 'k.orlov@ucck.example.org',
		phone: '+7 900 000-00-40',
		affiliation: {
			organizationKey: 'operator',
			position: 'Руководитель направления партнёрств',
			roleKind: 'coordinator',
			isPrimary: true,
			validFrom: '2022-04-01',
			channel: 'Почта, телефон'
		}
	}
];

/**
 * Вторые роли: человек ведёт занятия и параллельно координирует проект,
 * перешёл из колледжа в университет, читает курс по совместительству.
 */
const EXTRA_AFFILIATIONS: readonly ({ key: string; personKey: string } & AffiliationSeedFields)[] =
	[
		{
			key: 'efimov-coordinator',
			personKey: 'efimov',
			organizationKey: 'szpu',
			siteKey: 'szpu-main',
			position: 'Координатор совместного проекта',
			roleKind: 'coordinator',
			validFrom: '2021-09-01',
			validTo: '2023-06-30'
		},
		{
			key: 'mukhin-ukct',
			personKey: 'mukhin',
			organizationKey: 'ukct',
			siteKey: 'ukct-main',
			position: 'Преподаватель отделения автоматики',
			roleKind: 'teacher',
			validFrom: '2018-09-01',
			validTo: '2021-08-31'
		},
		{
			key: 'tsvetkov-teacher',
			personKey: 'tsvetkov',
			organizationKey: 'vkgtu',
			siteKey: 'vkgtu-branch-chelny',
			position: 'Преподаватель кафедры систем связи',
			roleKind: 'teacher',
			validFrom: '2016-09-01'
		},
		{
			key: 'ilyin-vts',
			personKey: 'ilyin',
			organizationKey: 'vts',
			position: 'Преподаватель по совместительству',
			roleKind: 'teacher',
			validFrom: '2023-09-01',
			channel: 'Почта'
		}
	];

type ProgramSeed = { key: string } & z.input<typeof createProgramSchema> & {
		versions: readonly { summary: string; effectiveFrom: string }[];
	};

const PROGRAMS: readonly ProgramSeed[] = [
	{
		key: 'vo-bak-01',
		code: 'VO-BAK-01',
		name: 'Прикладная информатика в цифровых сервисах',
		level: 'bachelor',
		directionCode: '09.03.03',
		status: 'active',
		versions: [
			{ summary: 'Первая редакция программы.', effectiveFrom: '2023-09-01' },
			{
				summary: 'Добавлен модуль по промышленной разработке и практика на площадке партнёра.',
				effectiveFrom: '2025-09-01'
			}
		]
	},
	{
		key: 'vo-bak-02',
		code: 'VO-BAK-02',
		name: 'Информационные системы и технологии связи',
		level: 'bachelor',
		directionCode: '09.03.02',
		status: 'active',
		versions: [
			{ summary: 'Первая редакция программы.', effectiveFrom: '2022-09-01' },
			{
				summary: 'Переработан раздел сетевых технологий, добавлены лабораторные работы.',
				effectiveFrom: '2024-09-01'
			}
		]
	},
	{
		key: 'vo-bak-03',
		code: 'VO-BAK-03',
		name: 'Программная инженерия учебных платформ',
		level: 'bachelor',
		directionCode: '09.03.04',
		status: 'active',
		versions: [{ summary: 'Первая редакция программы.', effectiveFrom: '2024-09-01' }]
	},
	{
		key: 'vo-mag-01',
		code: 'VO-MAG-01',
		name: 'Инженерия данных и машинное обучение',
		level: 'master',
		directionCode: '09.04.01',
		status: 'active',
		versions: [
			{ summary: 'Первая редакция программы.', effectiveFrom: '2023-09-01' },
			{
				summary: 'Уточнены требования к выпускной работе и состав проектного модуля.',
				effectiveFrom: '2025-02-01'
			}
		]
	},
	{
		key: 'vo-mag-02',
		code: 'VO-MAG-02',
		name: 'Безопасность информационных систем организации',
		level: 'master',
		directionCode: '09.04.02',
		status: 'draft',
		versions: [
			{
				summary: 'Черновик первой редакции, согласуется с партнёрами.',
				effectiveFrom: '2026-09-01'
			}
		]
	},
	{
		key: 'spo-01',
		code: 'SPO-01',
		name: 'Информационные системы и программирование',
		level: 'spo',
		directionCode: '09.02.07',
		status: 'active',
		versions: [{ summary: 'Первая редакция программы.', effectiveFrom: '2022-09-01' }]
	},
	{
		key: 'spo-02',
		code: 'SPO-02',
		name: 'Сетевое и системное администрирование',
		level: 'spo',
		directionCode: '09.02.06',
		status: 'active',
		versions: [
			{ summary: 'Первая редакция программы.', effectiveFrom: '2021-09-01' },
			{
				summary: 'Добавлен модуль по эксплуатации отечественных операционных систем.',
				effectiveFrom: '2024-09-01'
			}
		]
	},
	{
		key: 'school-01',
		code: 'SCH-01',
		name: 'Основы программирования для школьников',
		level: 'school',
		status: 'active',
		versions: [{ summary: 'Первая редакция программы.', effectiveFrom: '2023-09-01' }]
	},
	{
		key: 'dpo-01',
		code: 'DPO-01',
		name: 'Повышение квалификации преподавателей по промышленной разработке',
		level: 'dpo',
		status: 'active',
		versions: [{ summary: 'Первая редакция программы.', effectiveFrom: '2024-02-01' }]
	},
	{
		key: 'dpo-02',
		code: 'DPO-02',
		name: 'Переподготовка: администрирование облачных платформ',
		level: 'dpo',
		status: 'archived',
		versions: [{ summary: 'Первая редакция программы.', effectiveFrom: '2021-03-01' }]
	}
];

type ProductSeed = { key: string; vendorKey: string } & Omit<
	z.input<typeof createProductSchema>,
	'vendorOrganizationId'
>;

const PRODUCTS: readonly ProductSeed[] = [
	{
		key: 'lms',
		vendorKey: 'digital',
		code: 'PRD-LMS-01',
		name: 'Платформа учебных курсов «Ориентир»',
		description: 'Среда, в которой партнёры ведут занятия по программам оператора.',
		status: 'active'
	},
	{
		key: 'analytics',
		vendorKey: 'irbis',
		code: 'PRD-ANL-02',
		name: 'Аналитический модуль «Радар»',
		description: 'Сводки по набору и успеваемости для отчётности перед заказчиком.',
		status: 'active'
	},
	{
		key: 'lab',
		vendorKey: 'technosphere',
		code: 'PRD-SIM-03',
		name: 'Тренажёр сетевых лабораторий «Полигон»',
		description: 'Виртуальные стенды для практических занятий по сетям.',
		status: 'active'
	},
	{
		key: 'docs',
		vendorKey: 'digital',
		code: 'PRD-DOC-04',
		name: 'Конструктор учебных документов «Бланк»',
		description: 'Шаблоны договоров и актов под образовательные проекты.',
		status: 'draft'
	},
	{
		key: 'cloud',
		vendorKey: 'ladoga',
		code: 'PRD-CLD-05',
		name: 'Облачная среда разработки «Верстак»',
		description: 'Рабочие места для студентов без установки на личные компьютеры.',
		status: 'active'
	},
	{
		key: 'security',
		vendorKey: 'meridian',
		code: 'PRD-SEC-06',
		name: 'Учебный стенд по защите информации «Барьер»',
		description: 'Стенд для курсов по информационной безопасности.',
		status: 'active'
	},
	{
		key: 'assistant',
		vendorKey: 'polarcode',
		code: 'PRD-BOT-07',
		name: 'Помощник куратора «Маяк»',
		description: 'Напоминания и рассылки по учебным группам.',
		status: 'draft'
	},
	{
		key: 'archive',
		vendorKey: 'technosphere',
		code: 'PRD-ARC-08',
		name: 'Архив выпускных работ «Свод»',
		description: 'Хранилище выпускных работ с поиском по темам.',
		status: 'archived'
	}
];

function affiliationValues(key: string, personKey: string, fields: AffiliationSeedFields) {
	const input = checked(createAffiliationSchema, 'affiliation', key, {
		personId: seedId('person', personKey),
		organizationId: seedId('organization', fields.organizationKey),
		siteId: fields.siteKey === undefined ? null : seedId('site', fields.siteKey),
		position: fields.position,
		roleKind: fields.roleKind,
		isPrimary: fields.isPrimary ?? false,
		validFrom: fields.validFrom,
		validTo: fields.validTo ?? null,
		channel: fields.channel ?? null
	});

	return { id: seedId('affiliation', key), ...input };
}

/**
 * Заливает справочники. Существующие строки не трогает: у сидированной записи
 * идентификатор известен заранее, поэтому повторный запуск натыкается на
 * первичный ключ и пропускает строку — правки, сделанные на стенде руками,
 * переживают перезапуск контейнера.
 */
export async function seedDirectory(tx: Tx, options: { authorUserId: string }): Promise<void> {
	await tx
		.insert(directions)
		.values(
			DIRECTIONS.map((direction, index) => ({
				id: seedId('direction', direction.key),
				code: direction.code,
				name: direction.name,
				position: index + 1
			}))
		)
		.onConflictDoNothing({ target: directions.id });

	await tx
		.insert(organizations)
		.values(
			ORGANIZATIONS.map(({ key, ...raw }) => ({
				id: seedId('organization', key),
				...checked(createOrganizationSchema, 'organization', key, raw)
			}))
		)
		.onConflictDoNothing({ target: organizations.id });

	await tx
		.insert(sites)
		.values(
			SITES.map(({ key, organizationKey, ...raw }) => ({
				id: seedId('site', key),
				...checked(createSiteSchema, 'site', key, {
					...raw,
					organizationId: seedId('organization', organizationKey)
				})
			}))
		)
		.onConflictDoNothing({ target: sites.id });

	await tx
		.insert(people)
		.values(
			PEOPLE.map(({ key, affiliation: _affiliation, retentionUntil, ...raw }) => ({
				id: seedId('person', key),
				// Срок хранения контракт создания человека не описывает: его
				// назначают отдельным действием, и в наборе он лежит рядом.
				retentionUntil: retentionUntil ?? null,
				...checked(createPersonSchema, 'person', key, raw)
			}))
		)
		.onConflictDoNothing({ target: people.id });

	await tx
		.insert(consents)
		.values(
			CONSENTS.map(({ key, personKey, withdrawnAt, ...raw }) => ({
				id: seedId('consent', key),
				withdrawnAt: withdrawnAt ?? null,
				// Отозвал согласие тот же сотрудник, что и завёл справочник: автор
				// у действия на стенде должен быть, а не «система».
				withdrawnBy: withdrawnAt === undefined ? null : options.authorUserId,
				recordedBy: options.authorUserId,
				...checked(recordConsentSchema, 'consent', key, {
					...raw,
					personId: seedId('person', personKey)
				})
			}))
		)
		.onConflictDoNothing({ target: consents.id });

	await tx
		.insert(affiliations)
		.values([
			...PEOPLE.map((person) =>
				affiliationValues(`${person.key}-primary`, person.key, person.affiliation)
			),
			...EXTRA_AFFILIATIONS.map(({ key, personKey, ...fields }) =>
				affiliationValues(key, personKey, fields)
			)
		])
		.onConflictDoNothing({ target: affiliations.id });

	await tx
		.insert(programs)
		.values(
			PROGRAMS.map(({ key, versions: _versions, ...raw }) => ({
				id: seedId('program', key),
				// ИТ-направление контракт программы не описывает: оно про разрез
				// ответственности, а не про саму программу, и лежит в наборе рядом.
				directionId: seedId('direction', PROGRAM_DIRECTIONS[key]),
				...checked(createProgramSchema, 'program', key, raw)
			}))
		)
		.onConflictDoNothing({ target: programs.id });

	await tx
		.insert(programVersions)
		.values(
			PROGRAMS.flatMap((program) =>
				program.versions.map((version, index) => {
					const key = `${program.key}-v${index + 1}`;

					return {
						id: seedId('program-version', key),
						version: index + 1,
						createdBy: options.authorUserId,
						...checked(createProgramVersionSchema, 'program-version', key, {
							programId: seedId('program', program.key),
							summary: version.summary,
							effectiveFrom: version.effectiveFrom
						})
					};
				})
			)
		)
		.onConflictDoNothing({ target: programVersions.id });

	await tx
		.insert(products)
		.values(
			PRODUCTS.map(({ key, vendorKey, ...raw }) => ({
				id: seedId('product', key),
				...checked(createProductSchema, 'product', key, {
					...raw,
					vendorOrganizationId: seedId('organization', vendorKey)
				})
			}))
		)
		.onConflictDoNothing({ target: products.id });

	await tx
		.insert(productDirections)
		.values(
			PRODUCT_DIRECTIONS.flatMap(({ productKey, directionKeys }) =>
				directionKeys.map((directionKey) => ({
					productId: seedId('product', productKey),
					directionId: seedId('direction', directionKey)
				}))
			)
		)
		.onConflictDoNothing();

	await tx
		.insert(organizationResponsibles)
		.values(
			RESPONSIBLES.map((responsible) => ({
				id: seedId('responsible', responsible.key),
				organizationId: seedId('organization', responsible.organizationKey),
				userId: seedId('user', responsible.userKey),
				directionId:
					responsible.directionKey === undefined
						? null
						: seedId('direction', responsible.directionKey),
				validFrom: new Date(responsible.validFrom),
				validTo: responsible.validTo === undefined ? null : new Date(responsible.validTo),
				// Назначает руководитель — он же тот, кто отвечает за распределение
				// нагрузки. Автор справочника здесь не при чём.
				assignedByUserId: seedId('user', 'demo-lead')
			}))
		)
		.onConflictDoNothing({ target: organizationResponsibles.id });
}

/**
 * Сколько строк каждого набора описано в коде. Тест сверяет с этим то, что
 * оказалось в базе: расхождение означает, что часть строк молча не вставилась.
 */
export const DIRECTORY_SEED_SIZES = {
	directions: DIRECTIONS.length,
	productDirections: PRODUCT_DIRECTIONS.reduce(
		(total, product) => total + product.directionKeys.length,
		0
	),
	responsibles: RESPONSIBLES.length,
	organizations: ORGANIZATIONS.length,
	sites: SITES.length,
	people: PEOPLE.length,
	consents: CONSENTS.length,
	affiliations: PEOPLE.length + EXTRA_AFFILIATIONS.length,
	programs: PROGRAMS.length,
	programVersions: PROGRAMS.reduce((total, program) => total + program.versions.length, 0),
	products: PRODUCTS.length
} as const;
