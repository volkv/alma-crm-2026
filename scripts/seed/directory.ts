/**
 * Справочники демонстрационного стенда: организации и площадки, люди и их роли,
 * образовательные программы с версиями, продукты.
 *
 * Демонстрационные данные. Публичные здесь только названия вузов и продуктов
 * оператора: вуз на стенде должен быть узнаваемым, иначе демонстрация читается
 * как выдумка. Всё остальное вымышлено — люди, должности, почта, телефоны,
 * площадки, адреса, реквизиты, договоры, сроки и числа, а также колледжи,
 * школы и компании-заказчики. Почта — на `example.org` и `example.com`,
 * телефоны — из диапазона `+7 900 000-00-NN`.
 *
 * ИНН заведомо синтетические: первые четыре цифры `0000`, то есть код налогового
 * органа, которого не существует. Контрольную сумму они при этом проходят —
 * иначе форма организации отвергла бы собственные демонстрационные данные. КПП
 * и ОГРН собраны по той же схеме, вокруг несуществующего кода региона `00`.
 *
 * Состояния каталога — `draft`, `archived`, неактивный партнёр — показывают
 * фильтры интерфейса, а не положение дел у названной организации или продукта.
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
import { contactColumns } from '$lib/server/people/pii';
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
	{ key: 'devops', code: 'OPS', name: 'DevOps' },
	{ key: 'analytics', code: 'ANL', name: 'Аналитика данных и ИИ' },
	{ key: 'development', code: 'WEB', name: 'Web-разработка' },
	{ key: 'mobile', code: 'MOB', name: 'Мобильная разработка' },
	{ key: 'ledger', code: 'DLT', name: 'Распределённый реестр' },
	{ key: 'prompt', code: 'PRM', name: 'Промпт-инжиниринг' },
	{ key: 'project', code: 'PRJ', name: 'Управление проектами' }
];

/** Направление программы: у каждой ровно одно, у направления — сколько угодно. */
const PROGRAM_DIRECTIONS: Record<string, string> = {
	'vo-bak-01': 'devops',
	'vo-bak-02': 'development',
	'vo-bak-03': 'mobile',
	'vo-mag-01': 'analytics',
	'vo-mag-02': 'ledger',
	'spo-01': 'analytics',
	'spo-02': 'analytics',
	'school-01': 'prompt',
	'dpo-01': 'project'
};

/** Направления продукта: их бывает несколько, и это не ошибка набора. */
const PRODUCT_DIRECTIONS: readonly { productKey: string; directionKeys: readonly string[] }[] = [
	{ productKey: 'lms', directionKeys: ['devops', 'development'] },
	{ productKey: 'analytics', directionKeys: ['analytics'] },
	{ productKey: 'lab', directionKeys: ['development'] },
	{ productKey: 'docs', directionKeys: ['project'] },
	{ productKey: 'cloud', directionKeys: ['mobile'] },
	{ productKey: 'security', directionKeys: ['ledger'] },
	{ productKey: 'assistant', directionKeys: ['analytics'] },
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
 * Кто за какой вуз отвечает. У СПбПУ ответственность разделена по направлениям,
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
		userKey: 'demo-manager',
		validFrom: '2026-02-16T09:00:00+03:00'
	},
	{
		key: 'puts',
		organizationKey: 'puts',
		userKey: 'demo-manager',
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
	{
		key: 'sivt',
		organizationKey: 'sivt',
		userKey: 'zotov',
		validFrom: '2026-03-02T09:00:00+03:00'
	},
	// Контрагенты группы B2C ведёт тот же менеджер: без действующего назначения
	// ни физлицо, ни юрлицо не попали бы в его область доступа, а вместе с ними
	// и взаимодействия по ним.
	{
		key: 'individual-sorokin',
		organizationKey: 'individual-sorokin',
		userKey: 'demo-manager',
		validFrom: '2026-03-02T09:00:00+03:00'
	},
	{
		key: 'mayak',
		organizationKey: 'mayak',
		userKey: 'demo-manager',
		validFrom: '2026-02-16T09:00:00+03:00'
	}
];

type OrganizationSeed = { key: string } & z.input<typeof createOrganizationSchema>;

const ORGANIZATIONS: readonly OrganizationSeed[] = [
	{
		key: 'szpu',
		kind: 'educational_institution',
		educationLevel: 'vo',
		legalName:
			'Федеральное государственное автономное образовательное учреждение высшего образования «Санкт-Петербургский политехнический университет Петра Великого»',
		shortName: 'СПбПУ',
		inn: '0000000018',
		kpp: '000001001',
		ogrn: '1260000000017',
		region: 'г. Санкт-Петербург',
		website: 'https://spbpu.example.org',
		notes: 'Опорный партнёр: ответственность разделена по направлениям.'
	},
	{
		key: 'pupi',
		kind: 'educational_institution',
		educationLevel: 'vo',
		legalName:
			'Федеральное государственное автономное образовательное учреждение высшего образования «Московский физико-технический институт (национальный исследовательский университет)»',
		shortName: 'МФТИ',
		inn: '0000000025',
		kpp: '000001002',
		ogrn: '1260000000028',
		region: 'Московская область',
		website: 'https://mipt.example.org'
	},
	{
		key: 'uguis',
		kind: 'educational_institution',
		educationLevel: 'vo',
		legalName:
			'Федеральное государственное автономное образовательное учреждение высшего образования «Национальный исследовательский Томский политехнический университет»',
		shortName: 'ТПУ',
		inn: '0000000032',
		kpp: '000001003',
		ogrn: '1260000000039',
		region: 'Томская область',
		website: 'https://tpu.example.org'
	},
	{
		key: 'sivt',
		kind: 'educational_institution',
		educationLevel: 'vo',
		legalName:
			'Федеральное государственное бюджетное образовательное учреждение высшего образования «Новосибирский государственный университет экономики и управления „НИНХ“»',
		shortName: 'НГУЭУ',
		inn: '0000000040',
		kpp: '000001004',
		ogrn: '1260000000040',
		region: 'Новосибирская область',
		website: 'https://nsuem.example.org'
	},
	{
		key: 'yutus',
		kind: 'educational_institution',
		educationLevel: 'vo',
		legalName:
			'Федеральное государственное бюджетное образовательное учреждение высшего образования «Волгоградский государственный технический университет»',
		shortName: 'ВолгГТУ',
		inn: '0000000057',
		kpp: '000001005',
		ogrn: '1260000000050',
		region: 'Волгоградская область',
		website: 'https://vstu.example.org'
	},
	{
		key: 'batse',
		kind: 'educational_institution',
		educationLevel: 'vo',
		legalName: 'Автономная некоммерческая организация высшего образования «Университет Иннополис»',
		shortName: 'Университет Иннополис',
		inn: '0000000064',
		kpp: '000001006',
		ogrn: '1260000000061',
		region: 'Республика Татарстан',
		website: 'https://innopolis.example.org'
	},
	{
		key: 'vkgtu',
		kind: 'educational_institution',
		educationLevel: 'vo',
		legalName:
			'Федеральное государственное бюджетное образовательное учреждение высшего образования «Чувашский государственный университет имени И. Н. Ульянова»',
		shortName: 'ЧГУ им. И. Н. Ульянова',
		inn: '0000000071',
		kpp: '000001007',
		ogrn: '1260000000072',
		region: 'Чувашская Республика',
		website: 'https://chuvsu.example.org'
	},
	{
		key: 'sruit',
		kind: 'educational_institution',
		educationLevel: 'vo',
		legalName:
			'Федеральное государственное автономное образовательное учреждение высшего образования «Московский политехнический университет»',
		shortName: 'Московский Политех',
		inn: '0000000089',
		kpp: '000001008',
		ogrn: '1260000000083',
		region: 'г. Москва',
		website: 'https://mospolytech.example.org'
	},
	{
		key: 'bit',
		kind: 'educational_institution',
		educationLevel: 'vo',
		legalName:
			'Федеральное государственное бюджетное образовательное учреждение высшего образования «Московский технический университет связи и информатики»',
		shortName: 'МТУСИ',
		inn: '0000000096',
		kpp: '000001009',
		ogrn: '1260000000094',
		region: 'г. Москва',
		website: 'https://mtuci.example.org'
	},
	{
		key: 'puts',
		kind: 'educational_institution',
		educationLevel: 'vo',
		legalName:
			'Федеральное государственное бюджетное образовательное учреждение высшего образования «Саратовский государственный технический университет имени Гагарина Ю. А.»',
		shortName: 'СГТУ им. Гагарина Ю. А.',
		inn: '0000000106',
		kpp: '000001010',
		ogrn: '1260000000105',
		region: 'Саратовская область',
		website: 'https://sstu.example.org'
	},
	{
		key: 'zipm',
		kind: 'educational_institution',
		educationLevel: 'vo',
		legalName:
			'Федеральное государственное автономное образовательное учреждение высшего образования «Национальный исследовательский университет „МИЭТ“»',
		shortName: 'МИЭТ',
		inn: '0000000113',
		kpp: '000001011',
		ogrn: '1260000000116',
		region: 'г. Москва',
		website: 'https://miet.example.org',
		isActive: false,
		notes:
			'Демонстрационная запись: партнёрство помечено неактивным, чтобы на стенде был виден фильтр по активности.'
	},
	{
		key: 'paid',
		kind: 'educational_institution',
		educationLevel: 'vo',
		legalName:
			'Федеральное государственное бюджетное образовательное учреждение высшего образования «Национальный исследовательский университет „МЭИ“»',
		shortName: 'НИУ «МЭИ»',
		inn: '0000000120',
		kpp: '000001012',
		ogrn: '1260000000127',
		region: 'г. Москва',
		website: 'https://mpei.example.org'
	},
	{
		key: 'ukct',
		kind: 'educational_institution',
		educationLevel: 'spo',
		legalName:
			'Государственное автономное профессиональное образовательное учреждение «Уральский колледж цифровых технологий»',
		shortName: 'УКЦТ',
		inn: '0000000138',
		kpp: '000001013',
		ogrn: '1260000000138',
		region: 'Свердловская область',
		website: 'https://ukct.example.org',
		notes: 'Название колледжа вымышленное: публичного списка партнёров по СПО у набора нет.'
	},
	{
		key: 'nkis',
		kind: 'educational_institution',
		educationLevel: 'spo',
		legalName:
			'Государственное бюджетное профессиональное образовательное учреждение «Невский колледж информационных систем»',
		shortName: 'НКИС',
		inn: '0000000145',
		kpp: '000001014',
		ogrn: '1260000000149',
		region: 'г. Санкт-Петербург',
		website: 'https://nkis.example.org',
		notes: 'Название колледжа вымышленное: публичного списка партнёров по СПО у набора нет.'
	},
	{
		key: 'vts',
		kind: 'educational_institution',
		educationLevel: 'spo',
		legalName:
			'Государственное профессиональное образовательное учреждение «Верхневолжский техникум связи»',
		shortName: 'ВТС',
		inn: '0000000152',
		kpp: '000001015',
		ogrn: '1260000000150',
		region: 'Ярославская область',
		website: 'https://vts.example.org',
		notes: 'Название техникума вымышленное: публичного списка партнёров по СПО у набора нет.'
	},
	{
		key: 'skpa',
		kind: 'educational_institution',
		educationLevel: 'spo',
		legalName:
			'Государственное автономное профессиональное образовательное учреждение «Степной колледж промышленной автоматики»',
		shortName: 'СКПА',
		inn: '0000000160',
		kpp: '000001016',
		ogrn: '1260000000160',
		region: 'Оренбургская область',
		website: 'https://skpa.example.org',
		notes: 'Название колледжа вымышленное: публичного списка партнёров по СПО у набора нет.'
	},
	{
		key: 'lyceum306',
		kind: 'educational_institution',
		educationLevel: 'school',
		legalName: 'Государственное бюджетное общеобразовательное учреждение «Лицей № 306 „Гравитон“»',
		shortName: 'Лицей № 306 «Гравитон»',
		inn: '0000000177',
		kpp: '000001017',
		ogrn: '1260000000171',
		region: 'Московская область',
		website: 'https://lyceum306.example.org',
		notes: 'Название школы вымышленное.'
	},
	{
		key: 'school47',
		kind: 'educational_institution',
		educationLevel: 'school',
		legalName:
			'Муниципальное бюджетное общеобразовательное учреждение «Инженерная школа № 47 „Вектор“»',
		shortName: 'Школа № 47 «Вектор»',
		inn: '0000000184',
		kpp: '000001018',
		ogrn: '1260000000182',
		region: 'Новосибирская область',
		website: 'https://school47.example.org',
		notes: 'Название школы вымышленное.'
	},
	{
		key: 'digital',
		kind: 'customer_company',
		legalName: 'Общество с ограниченной ответственностью «Цифровые решения»',
		shortName: 'Цифровые решения',
		inn: '0000000191',
		kpp: '000001019',
		ogrn: '1260000000193',
		region: 'г. Москва',
		website: 'https://digital-solutions.example.com',
		notes: 'Компания-заказчик вымышлена: берёт стажёров на направление DevOps.'
	},
	{
		key: 'technosphere',
		kind: 'customer_company',
		legalName: 'Общество с ограниченной ответственностью «ТехноСфера Софт»',
		shortName: 'ТехноСфера Софт',
		inn: '0000000201',
		kpp: '000001020',
		ogrn: '1260000000204',
		region: 'Самарская область',
		website: 'https://technosphere-soft.example.com',
		notes: 'Компания-заказчик вымышлена.'
	},
	{
		key: 'irbis',
		kind: 'customer_company',
		legalName: 'Общество с ограниченной ответственностью «Ирбис Аналитика»',
		shortName: 'Ирбис Аналитика',
		inn: '0000000219',
		kpp: '000001021',
		ogrn: '1260000000215',
		region: 'Пермский край',
		website: 'https://irbis-analytics.example.com',
		notes: 'Компания-заказчик вымышлена.'
	},
	{
		key: 'meridian',
		kind: 'customer_company',
		legalName: 'Общество с ограниченной ответственностью «Меридиан Инжиниринг»',
		shortName: 'Меридиан Инжиниринг',
		inn: '0000000226',
		kpp: '000001022',
		ogrn: '1260000000226',
		region: 'Воронежская область',
		website: 'https://meridian-eng.example.com',
		notes: 'Компания-заказчик вымышлена.'
	},
	{
		key: 'ladoga',
		kind: 'customer_company',
		legalName: 'Акционерное общество «Ладога Датасистемс»',
		shortName: 'Ладога Датасистемс',
		inn: '0000000233',
		kpp: '000001023',
		ogrn: '1260000000237',
		region: 'г. Санкт-Петербург',
		website: 'https://ladoga-data.example.com',
		notes: 'Компания-заказчик вымышлена.'
	},
	{
		key: 'polarcode',
		kind: 'customer_company',
		legalName: 'Общество с ограниченной ответственностью «Полярный код»',
		shortName: 'Полярный код',
		inn: '0000000240',
		kpp: '000001024',
		ogrn: '1260000000248',
		region: 'Архангельская область',
		website: 'https://polarcode.example.com',
		notes: 'Компания-заказчик вымышлена.'
	},
	{
		key: 'mayak',
		kind: 'legal_entity',
		legalName: 'Общество с ограниченной ответственностью «Маяк-Телеком»',
		shortName: 'Маяк-Телеком',
		inn: '0000000265',
		kpp: '000001026',
		ogrn: '1260000000260',
		region: 'Ленинградская область',
		website: 'https://mayak-telecom.example.com',
		notes: 'Юридическое лицо обучает своих сотрудников: группа процесса B2C. Организация вымышлена.'
	},
	{
		key: 'operator',
		kind: 'operator',
		legalName: 'Общество с ограниченной ответственностью «РТК ИТ»',
		shortName: 'ИТ Школа Ростелекома',
		inn: '0000000258',
		kpp: '000001025',
		ogrn: '1260000000259',
		region: 'г. Москва',
		website: 'https://itschool.example.org',
		notes:
			'Демонстрационные данные. Названия вузов и продуктов — публичные, реально существующие; люди, контакты, реквизиты, договоры, сроки и числа вымышлены целиком, колледжи, школы и компании-заказчики тоже. Оператор ведёт от своего имени весь процесс.'
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
		name: 'Главный кампус',
		address: 'Московская область, г. Долгопрудный, Институтский переулок, 12',
		region: 'Московская область'
	},
	{
		key: 'pupi-dept-ai',
		organizationKey: 'pupi',
		kind: 'department',
		name: 'Факультет прикладной математики и информатики',
		address: 'Московская область, г. Долгопрудный, Институтский переулок, 12, корпус 3',
		region: 'Московская область'
	},
	{
		key: 'uguis-main',
		organizationKey: 'uguis',
		kind: 'campus',
		name: 'Учебный городок',
		address: 'Томская область, г. Томск, ул. Учебная, 38',
		region: 'Томская область'
	},
	{
		key: 'uguis-dept-auto',
		organizationKey: 'uguis',
		kind: 'department',
		name: 'Кафедра автоматизации производств',
		address: 'Томская область, г. Томск, ул. Учебная, 38, корпус В',
		region: 'Томская область'
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
		address: 'Чувашская Республика, г. Чебоксары, ул. Университетская, 19',
		region: 'Чувашская Республика'
	},
	{
		key: 'vkgtu-branch-chelny',
		organizationKey: 'vkgtu',
		kind: 'branch',
		name: 'Филиал в Новочебоксарске',
		address: 'Чувашская Республика, г. Новочебоксарск, ул. Речная, 88',
		region: 'Чувашская Республика'
	},
	{
		key: 'vkgtu-dept-comm',
		organizationKey: 'vkgtu',
		kind: 'department',
		name: 'Кафедра систем связи',
		address: 'Чувашская Республика, г. Чебоксары, ул. Университетская, 19, корпус 2',
		region: 'Чувашская Республика'
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
		name: 'Учебный корпус на Энергетической',
		address: 'г. Москва, Энергетическая улица, 62',
		region: 'г. Москва'
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
	},
	{
		// Физическое лицо учится за свой счёт: основание обработки — его
		// собственное согласие, и без него такого контрагента в системе не
		// заводят вовсе (`docs/directory.md`, «Согласия»).
		key: 'sorokin-2026',
		personKey: 'sorokin',
		basis: 'consent',
		textVersion: '2026-03-02',
		givenAt: '2026-03-02'
	},
	{
		// Представителя юридического лица в систему вписал работодатель:
		// основание — исполнение договора, а не подпись субъекта.
		key: 'kudryashova-2026',
		personKey: 'kudryashova',
		basis: 'contract',
		textVersion: '2026-02-16',
		givenAt: '2026-02-16'
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
		email: 'i.astakhov@spbpu.example.org',
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
		email: 'm.belskaya@spbpu.example.org',
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
		email: 'n.guryev@spbpu.example.org',
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
		email: 'e.drozdova@spbpu.example.org',
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
		email: 'r.efimov@spbpu.example.org',
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
		email: 'k.zharova@mipt.example.org',
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
		email: 'a.zimin@mipt.example.org',
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
		email: 'o.ignatyeva@mipt.example.org',
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
		email: 'd.koltsov@tpu.example.org',
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
		email: 's.lapina@tpu.example.org',
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
		email: 't.mukhin@tpu.example.org',
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
		email: 'v.nesterov@nsuem.example.org',
		phone: '+7 900 000-00-12',
		affiliation: {
			organizationKey: 'sivt',
			siteKey: 'sivt-main',
			position: 'Директор департамента образовательных программ',
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
		email: 'a.orekhova@nsuem.example.org',
		phone: '+7 900 000-00-13',
		affiliation: {
			organizationKey: 'sivt',
			siteKey: 'sivt-main',
			position: 'Проректор по развитию',
			roleKind: 'vice_rector',
			validFrom: '2018-08-15'
		}
	},
	{
		key: 'pankratov',
		lastName: 'Панкратов',
		firstName: 'Сергей',
		middleName: 'Львович',
		email: 's.pankratov@nsuem.example.org',
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
		email: 'v.rodionova@vstu.example.org',
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
		email: 'a.savelyev@vstu.example.org',
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
		email: 'i.tarasyuk@innopolis.example.org',
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
		email: 'd.ulyanova@innopolis.example.org',
		phone: '+7 900 000-00-18',
		affiliation: {
			organizationKey: 'batse',
			position: 'Заведующая лабораторией цифровой экономики',
			roleKind: 'head_of_department',
			validFrom: '2021-09-01'
		}
	},
	{
		key: 'fedotov',
		lastName: 'Федотов',
		firstName: 'Марат',
		middleName: 'Наилевич',
		email: 'm.fedotov@chuvsu.example.org',
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
		email: 'l.khabibullina@chuvsu.example.org',
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
		email: 'e.tsvetkov@chuvsu.example.org',
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
		email: 'p.chernysheva@mospolytech.example.org',
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
		email: 'k.shilov@mospolytech.example.org',
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
		email: 'a.shcherbak@mtuci.example.org',
		phone: '+7 900 000-00-24',
		affiliation: {
			organizationKey: 'bit',
			position: 'Директор центра дополнительного образования',
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
		email: 'z.eldarova@mtuci.example.org',
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
		email: 'g.yurchenko@sstu.example.org',
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
		email: 'n.yakovleva@sstu.example.org',
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
		email: 'l.abramov@miet.example.org',
		phone: '+7 900 000-00-28',
		affiliation: {
			organizationKey: 'zipm',
			position: 'Директор института системной и программной инженерии',
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
		email: 's.belov@miet.example.org',
		phone: '+7 900 000-00-29',
		affiliation: {
			organizationKey: 'zipm',
			position: 'Преподаватель кафедры системной инженерии',
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
		email: 'y.vikhrova@mpei.example.org',
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
		email: 'i.gorbunova@mpei.example.org',
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
		email: 'k.orlov@itschool.example.org',
		phone: '+7 900 000-00-40',
		affiliation: {
			organizationKey: 'operator',
			position: 'Руководитель направления партнёрств',
			roleKind: 'coordinator',
			isPrimary: true,
			validFrom: '2022-04-01',
			channel: 'Почта, телефон'
		}
	},
	{
		// Слушатель-физлицо. Его карточка человека и есть карточка контрагента:
		// организация вида `individual` ссылается на эту строку, а копии ФИО в
		// полях организации не появляется (`docs/domain.md`, раздел 2).
		key: 'sorokin',
		retentionUntil: '2029-03-02',
		lastName: 'Сорокин',
		firstName: 'Артём',
		middleName: 'Павлович',
		email: 'a.sorokin@example.com',
		phone: '+7 900 000-00-41',
		affiliation: {
			organizationKey: 'individual-sorokin',
			position: 'Слушатель',
			roleKind: 'other',
			isPrimary: true,
			validFrom: '2026-03-02',
			channel: 'Почта'
		}
	},
	{
		key: 'kudryashova',
		lastName: 'Кудряшова',
		firstName: 'Вера',
		middleName: 'Ильинична',
		email: 'v.kudryashova@mayak-telecom.example.com',
		phone: '+7 900 000-00-42',
		affiliation: {
			organizationKey: 'mayak',
			position: 'Руководитель отдела обучения',
			roleKind: 'other',
			isPrimary: true,
			validFrom: '2024-11-11',
			channel: 'Почта, телефон'
		}
	}
];

/**
 * Контрагенты-физлица. Отдельным набором, а не строкой в `ORGANIZATIONS`, по
 * двум причинам. Первая: форма справочника такого контрагента не заводит вовсе
 * (`ORGANIZATION_FORM_KINDS`), и контракт `createOrganizationSchema`
 * справедливо его отвергает — как и у заявки с сайта, здесь запись кладётся
 * напрямую. Вторая: у неё внешний ключ на `people`, поэтому она заливается
 * после людей, а не вместе с остальными организациями.
 */
const INDIVIDUALS: readonly { key: string; personKey: string; name: string }[] = [
	{ key: 'individual-sorokin', personKey: 'sorokin', name: 'Сорокин Артём Павлович' }
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
		name: 'DevOps-инженер',
		level: 'bachelor',
		directionCode: '09.03.01',
		// Ручной приоритет: с этой программы начинают разговор с вузом.
		priority: 1,
		status: 'active',
		versions: [
			{ summary: 'Первая редакция программы.', effectiveFrom: '2023-09-01' },
			{
				summary: 'Добавлен модуль по промышленной эксплуатации и практика на площадке партнёра.',
				effectiveFrom: '2025-09-01'
			}
		]
	},
	{
		key: 'vo-bak-02',
		code: 'VO-BAK-02',
		name: 'Web-разработка на «Аколе»',
		level: 'bachelor',
		directionCode: '09.03.04',
		status: 'active',
		versions: [
			{ summary: 'Первая редакция программы.', effectiveFrom: '2022-09-01' },
			{
				summary: 'Переработан раздел интеграций, добавлены лабораторные работы.',
				effectiveFrom: '2024-09-01'
			}
		]
	},
	{
		key: 'vo-bak-03',
		code: 'VO-BAK-03',
		name: 'Мобильная разработка на «Авроре»',
		level: 'bachelor',
		directionCode: '09.03.04',
		status: 'active',
		versions: [{ summary: 'Первая редакция программы.', effectiveFrom: '2024-09-01' }]
	},
	{
		key: 'vo-mag-01',
		code: 'VO-MAG-01',
		name: 'Low-code аналитика данных',
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
		name: 'Распределённые реестры',
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
		name: 'SQL-разработчик',
		level: 'spo',
		directionCode: '09.02.07',
		status: 'active',
		versions: [{ summary: 'Первая редакция программы.', effectiveFrom: '2022-09-01' }]
	},
	{
		key: 'spo-02',
		code: 'SPO-02',
		name: 'Аналитика на Python',
		level: 'spo',
		directionCode: '09.02.06',
		priority: 2,
		status: 'active',
		versions: [
			{ summary: 'Первая редакция программы.', effectiveFrom: '2021-09-01' },
			{
				summary: 'Добавлен модуль по работе с отечественными хранилищами данных.',
				effectiveFrom: '2024-09-01'
			}
		]
	},
	{
		key: 'school-01',
		code: 'SCH-01',
		name: 'Промпт-инжиниринг',
		level: 'school',
		priority: 4,
		status: 'active',
		versions: [{ summary: 'Первая редакция программы.', effectiveFrom: '2023-09-01' }]
	},
	{
		key: 'dpo-01',
		code: 'DPO-01',
		name: 'Управление проектами',
		level: 'dpo',
		priority: 3,
		status: 'active',
		versions: [{ summary: 'Первая редакция программы.', effectiveFrom: '2024-02-01' }]
	}
];

type ProductSeed = { key: string; vendorKey: string } & Omit<
	z.input<typeof createProductSchema>,
	'vendorOrganizationId'
>;

const PRODUCTS: readonly ProductSeed[] = [
	{
		key: 'lms',
		vendorKey: 'operator',
		code: 'RT-DEVOPS',
		name: 'Базис',
		description:
			'Платформа виртуализации и DevOps: на ней идёт программа подготовки DevOps-инженеров.',
		status: 'active'
	},
	{
		key: 'analytics',
		vendorKey: 'operator',
		code: 'RT-DATAVISION',
		name: 'RT.DataVision',
		description:
			'Low-code среда визуализации и анализа данных для учебных и исследовательских задач.',
		status: 'active'
	},
	{
		key: 'lab',
		vendorKey: 'operator',
		code: 'RT-AKOLA',
		name: 'Акола',
		description: 'No-code платформа для сборки веб-приложений и порталов.',
		status: 'active'
	},
	{
		key: 'docs',
		vendorKey: 'operator',
		code: 'RT-YAGA',
		name: 'Яга',
		description: 'Система управления проектами и задачами команд.',
		status: 'active'
	},
	{
		key: 'cloud',
		vendorKey: 'operator',
		code: 'RT-AURORA-SDK',
		name: 'Аврора SDK',
		description:
			'Комплект разработчика мобильных приложений для отечественной операционной системы.',
		status: 'active'
	},
	{
		key: 'security',
		vendorKey: 'operator',
		code: 'RT-WEB3GATE',
		name: 'WEB3Gate',
		description:
			'Платформа распределённого реестра: смарт-контракты и работа с цифровыми активами.',
		status: 'active'
	},
	{
		key: 'assistant',
		vendorKey: 'operator',
		code: 'RT-NEUROGATE',
		name: 'Нейрошлюз',
		description: 'Единая точка доступа к языковым моделям для прикладных сервисов.',
		status: 'draft'
	},
	{
		key: 'archive',
		vendorKey: 'operator',
		code: 'RT-DATALAKE',
		name: 'RT.Data Lake',
		description: 'Озеро данных: хранение и подготовка больших наборов под аналитику.',
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
			PEOPLE.map(({ key, affiliation: _affiliation, retentionUntil, ...raw }) => {
				const person = checked(createPersonSchema, 'person', key, raw);

				return {
					id: seedId('person', key),
					// Срок хранения контракт создания человека не описывает: его
					// назначают отдельным действием, и в наборе он лежит рядом.
					retentionUntil: retentionUntil ?? null,
					...person,
					// Контакты — тем же слоем, что и у формы: в базе они лежат
					// шифртекстом, и набор не исключение.
					...contactColumns(person)
				};
			})
		)
		.onConflictDoNothing({ target: people.id });

	// Контрагенты-физлица — после людей: у строки организации внешний ключ на
	// `people`, и раньше ей не на кого ссылаться. Контракт формы справочника
	// здесь не применяется намеренно: он такой вид не принимает вовсе, а
	// название организации — это и есть ФИО, второй копии не появляется.
	await tx
		.insert(organizations)
		.values(
			INDIVIDUALS.map((individual) => ({
				id: seedId('organization', individual.key),
				kind: 'individual' as const,
				educationLevel: null,
				legalName: individual.name,
				shortName: individual.name,
				personId: seedId('person', individual.personKey),
				isActive: true
			}))
		)
		.onConflictDoNothing({ target: organizations.id });

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
	organizations: ORGANIZATIONS.length + INDIVIDUALS.length,
	/** Из них контрагенты-физлица: у них нет ни ИНН, ни реквизитов. */
	individuals: INDIVIDUALS.length,
	sites: SITES.length,
	people: PEOPLE.length,
	consents: CONSENTS.length,
	affiliations: PEOPLE.length + EXTRA_AFFILIATIONS.length,
	programs: PROGRAMS.length,
	programVersions: PROGRAMS.reduce((total, program) => total + program.versions.length, 0),
	products: PRODUCTS.length
} as const;
