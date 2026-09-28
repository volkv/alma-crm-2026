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
 * Исключение — сайты пяти вузов (СПбПУ, МФТИ, Московский Политех, МТУСИ,
 * МИЭТ): у них настоящий адрес, потому что паспорт организации читается с
 * раздела `/sveden` сайта, и на вымышленном домене показать его нечем. Люди и
 * почта этих вузов остаются вымышленными.
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
	'school-02': 'analytics',
	'school-03': 'development',
	'school-04': 'project',
	'school-05': 'development',
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
	{ productKey: 'archive', directionKeys: ['analytics'] },
	{ productKey: 'warehouse', directionKeys: ['analytics'] }
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
	// Контрагентов пространства B2C ведёт тот же менеджер: без действующего назначения
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

/**
 * Вендоры продуктов оператора — как их называет таблица «Вендоры и контакты по
 * продуктам» заказчика: загрузка этой таблицы на демо-стенде узнаёт компании и
 * продукты и заводит только контакты. Ответственных у вендоров не бывает.
 */
const VENDOR_NOTE =
	'Вендор продуктов, которые оператор передаёт вузам. Название публичное; реквизиты вымышлены.';

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
		website: 'https://www.spbstu.ru',
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
		website: 'https://mipt.ru'
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
		website: 'https://mospolytech.ru'
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
		website: 'https://mtuci.ru'
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
		website: 'https://miet.ru',
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
		ogrn: '1260000000259',
		region: 'Ленинградская область',
		website: 'https://mayak-telecom.example.com',
		notes: 'Юридическое лицо обучает своих сотрудников: пространство B2C. Организация вымышлена.'
	},
	{
		key: 'operator',
		kind: 'operator',
		legalName: 'Общество с ограниченной ответственностью «РТК ИТ»',
		shortName: 'ИТ Школа Ростелекома',
		inn: '0000000258',
		kpp: '000001025',
		ogrn: '1260000000260',
		region: 'г. Москва',
		website: 'https://itschool.example.org',
		notes:
			'Демонстрационные данные. Названия вузов, продуктов и их вендоров — публичные, реально существующие; люди, контакты, реквизиты, договоры, сроки и числа вымышлены целиком, колледжи, школы и компании-заказчики тоже. Оператор ведёт от своего имени весь процесс.'
	},
	{
		key: 'vendor-basis',
		kind: 'vendor',
		legalName: 'Общество с ограниченной ответственностью «Базис»',
		shortName: 'Базис',
		inn: '0000000272',
		kpp: '000001027',
		ogrn: '1260000000270',
		region: 'г. Москва',
		website: 'https://basis.example.org',
		notes: VENDOR_NOTE
	},
	{
		key: 'vendor-tdata',
		kind: 'vendor',
		legalName: 'Общество с ограниченной ответственностью «ТДата»',
		shortName: 'ТДата',
		inn: '0000000280',
		kpp: '000001028',
		ogrn: '1260000000281',
		region: 'г. Москва',
		website: 'https://tdata.example.org',
		notes: VENDOR_NOTE
	},
	{
		key: 'vendor-rostelecom',
		kind: 'vendor',
		legalName: 'Публичное акционерное общество «Ростелеком»',
		shortName: 'Ростелеком',
		inn: '0000000297',
		kpp: '000001029',
		ogrn: '1260000000292',
		region: 'г. Москва',
		website: 'https://rostelecom.example.org',
		notes: VENDOR_NOTE
	},
	{
		key: 'vendor-rtk-it-plus',
		kind: 'vendor',
		legalName: 'Общество с ограниченной ответственностью «РТК ИТ Плюс»',
		shortName: 'РТК ИТ Плюс',
		inn: '0000000307',
		kpp: '000001030',
		ogrn: '1260000000303',
		region: 'г. Москва',
		website: 'https://rtk-it-plus.example.org',
		notes: VENDOR_NOTE
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
	},
	// Профильные подразделения: с ними работают дела, прошедшие поиск
	// контактов, — пункт «Найдено профильное подразделение» закрывает площадка
	// этого вида у стороны дела.
	{
		key: 'lyceum306-dept',
		organizationKey: 'lyceum306',
		kind: 'department',
		name: 'Кафедра информатики и робототехники',
		region: 'Московская область'
	},
	{
		key: 'vts-dept',
		organizationKey: 'vts',
		kind: 'department',
		name: 'Отделение информационных технологий',
		region: 'Ярославская область'
	},
	{
		key: 'paid-dept',
		organizationKey: 'paid',
		kind: 'department',
		name: 'Институт информационных и вычислительных технологий',
		region: 'г. Москва'
	},
	{
		key: 'nkis-dept',
		organizationKey: 'nkis',
		kind: 'department',
		name: 'Отделение инфокоммуникационных систем',
		region: 'г. Санкт-Петербург'
	},
	{
		key: 'school47-dept',
		organizationKey: 'school47',
		kind: 'department',
		name: 'Методическое объединение учителей информатики',
		region: 'Новосибирская область'
	},
	{
		key: 'skpa-dept',
		organizationKey: 'skpa',
		kind: 'department',
		name: 'Отделение компьютерных сетей',
		region: 'Оренбургская область'
	},
	{
		key: 'sruit-dept',
		organizationKey: 'sruit',
		kind: 'department',
		name: 'Факультет информационных технологий',
		region: 'г. Москва'
	},
	{
		key: 'ukct-dept',
		organizationKey: 'ukct',
		kind: 'department',
		name: 'Отделение цифровых технологий',
		region: 'Свердловская область'
	},
	{
		key: 'yutus-dept',
		organizationKey: 'yutus',
		kind: 'department',
		name: 'Факультет электроники и вычислительной техники',
		region: 'Волгоградская область'
	},
	{
		key: 'batse-dept',
		organizationKey: 'batse',
		kind: 'department',
		name: 'Институт разработки программного обеспечения',
		region: 'Республика Татарстан'
	},
	{
		key: 'sivt-dept',
		organizationKey: 'sivt',
		kind: 'department',
		name: 'Кафедра информационных технологий',
		region: 'Новосибирская область'
	},
	{
		key: 'bit-dept',
		organizationKey: 'bit',
		kind: 'department',
		name: 'Кафедра информационной безопасности',
		region: 'г. Москва'
	},
	{
		key: 'puts-dept',
		organizationKey: 'puts',
		kind: 'department',
		name: 'Институт прикладных информационных технологий',
		region: 'Саратовская область'
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

/**
 * Содержимое PDF «Описание программы» — материала, который лежит на карточке
 * программы и уходит вузу вложением письма (`scripts/seed/program-materials.ts`).
 * Краткое описание — колонка `description` самой программы; здесь то, что в
 * колонку не помещается: цели, слушатели, модули с часами, формат и итог.
 * Часы модулей складываются в объём, который назван в описании, а состав
 * модулей — тот, что описывает последняя редакция программы.
 */
type ProgramBrochure = {
	audience: string;
	goals: readonly string[];
	modules: readonly { name: string; hours: number }[];
	format: string;
	assessment: string;
	/** Что учебное заведение получает вместе с программой. */
	institutionGets: readonly string[];
	/** Продукты оператора, на которых идут занятия; их лицензии получает вуз. */
	productKeys: readonly string[];
};

type ProgramSeed = { key: string } & z.input<typeof createProgramSchema> & {
		versions: readonly { summary: string; effectiveFrom: string }[];
		brochure: ProgramBrochure;
	};

const PROGRAMS: readonly ProgramSeed[] = [
	{
		key: 'vo-bak-01',
		code: 'VO-BAK-01',
		name: 'DevOps-инженер',
		level: 'bachelor',
		directionCode: '09.03.01',
		description:
			'Практико-ориентированная дисциплина для студентов 3–4 курсов направления «Информатика и вычислительная техника». Студенты проходят полный цикл поставки программного обеспечения: контейнеризацию, конвейеры CI/CD, инфраструктуру как код и мониторинг — на отечественной платформе виртуализации «Базис Dynamix». Программа встраивается в учебный план как дисциплина по выбору объёмом 144 академических часа и завершается защитой командного проекта; с редакции 2025 года в неё входит практика на площадке партнёра.',
		// Ручной приоритет: с этой программы начинают разговор с вузом.
		priority: 1,
		status: 'active',
		versions: [
			{ summary: 'Первая редакция программы.', effectiveFrom: '2023-09-01' },
			{
				summary: 'Добавлен модуль по промышленной эксплуатации и практика на площадке партнёра.',
				effectiveFrom: '2025-09-01'
			}
		],
		brochure: {
			audience:
				'Студенты 3–4 курсов бакалавриата по направлению 09.03.01 и смежным; нужны основы программирования и уверенная работа в командной строке.',
			goals: [
				'Научить собирать и сопровождать конвейер поставки от коммита до промышленной среды.',
				'Дать опыт эксплуатации сервисов на отечественной платформе виртуализации.',
				'Подготовить студентов к стажировке в ИТ-подразделениях компаний-партнёров.'
			],
			modules: [
				{ name: 'Linux и сети для инженера эксплуатации', hours: 24 },
				{ name: 'Контейнеризация и оркестрация', hours: 32 },
				{ name: 'Конвейеры CI/CD и инфраструктура как код', hours: 32 },
				{ name: 'Мониторинг, журналирование и надёжность сервисов', hours: 20 },
				{ name: 'Промышленная эксплуатация на платформе «Базис Dynamix»', hours: 20 },
				{ name: 'Практика на площадке партнёра и защита проекта', hours: 16 }
			],
			format:
				'Смешанный: лекции в записи на учебной платформе ИТ Школы, очные лабораторные работы в вузе под руководством преподавателя кафедры, еженедельные консультации эксперта Школы.',
			assessment:
				'Зачёт с оценкой: защита командного проекта — развёрнутого сервиса с конвейером CI/CD и мониторингом.',
			institutionGets: [
				'Рабочая программа дисциплины, фонд оценочных средств и методические указания к лабораторным работам.',
				'Обучение преподавателей кафедры перед стартом потока.',
				'Доступ студентов к учебной платформе ИТ Школы на срок реализации программы.'
			],
			productKeys: ['lms']
		}
	},
	{
		key: 'vo-bak-02',
		code: 'VO-BAK-02',
		name: 'Web-разработка на «Аколе»',
		level: 'bachelor',
		directionCode: '09.03.04',
		description:
			'Дисциплина для студентов направления «Программная инженерия» о быстрой разработке веб-приложений и корпоративных порталов на no-code платформе AKOLA. Студенты проектируют модель данных, собирают интерфейсы и бизнес-процессы, подключают внешние сервисы через API и публикуют готовое приложение. Объём — 108 академических часов, итог — защита веб-приложения, собранного командой.',
		status: 'active',
		versions: [
			{ summary: 'Первая редакция программы.', effectiveFrom: '2022-09-01' },
			{
				summary: 'Переработан раздел интеграций, добавлены лабораторные работы.',
				effectiveFrom: '2024-09-01'
			}
		],
		brochure: {
			audience:
				'Студенты 2–4 курсов бакалавриата по направлениям 09.03.04, 09.03.03 и смежным; опыт программирования желателен, но не обязателен.',
			goals: [
				'Научить проектировать и собирать веб-приложение без ручного написания кода.',
				'Показать, как no-code приложение встраивается в ИТ-ландшафт организации через API.',
				'Дать опыт командной разработки от постановки задачи до публикации.'
			],
			modules: [
				{ name: 'Введение в no-code разработку и платформу AKOLA', hours: 12 },
				{ name: 'Модель данных и формы', hours: 20 },
				{ name: 'Бизнес-процессы и роли пользователей', hours: 20 },
				{ name: 'Интеграции с внешними системами через API', hours: 24 },
				{ name: 'Публикация и сопровождение приложения', hours: 12 },
				{ name: 'Командный проект', hours: 20 }
			],
			format:
				'Очные занятия в компьютерных классах вуза, лабораторные работы по сценариям ИТ Школы, разбор проектов с экспертом Школы в онлайн-формате.',
			assessment:
				'Экзамен: защита командного проекта — опубликованного веб-приложения с интеграцией через API.',
			institutionGets: [
				'Рабочая программа дисциплины и комплект лабораторных работ.',
				'Методические рекомендации и обучение преподавателей.',
				'Шаблоны учебных проектов для командной работы студентов.'
			],
			productKeys: ['lab']
		}
	},
	{
		key: 'vo-bak-03',
		code: 'VO-BAK-03',
		name: 'Мобильная разработка на «Авроре»',
		level: 'bachelor',
		directionCode: '09.03.04',
		description:
			'Курс для студентов старших курсов, которые хотят разрабатывать мобильные приложения для отечественной операционной системы «Аврора». Студенты работают с Аврора SDK: строят интерфейсы на QML, пишут логику на C++ и Qt, подключают сеть, хранение данных и системные сервисы, готовят приложение к публикации. Объём — 144 академических часа, итог — защита приложения, запущенного на устройстве или эмуляторе.',
		status: 'active',
		versions: [{ summary: 'Первая редакция программы.', effectiveFrom: '2024-09-01' }],
		brochure: {
			audience:
				'Студенты 3–4 курсов бакалавриата по направлениям 09.03.04, 09.03.01 и смежным; нужно знание основ C++ или другого объектно-ориентированного языка.',
			goals: [
				'Научить разрабатывать мобильные приложения для ОС «Аврора» полным циклом.',
				'Дать практику работы с Аврора SDK, эмулятором и отладкой на устройстве.',
				'Познакомить с требованиями к безопасности и публикации приложений.'
			],
			modules: [
				{ name: 'Архитектура ОС «Аврора» и среда разработки', hours: 16 },
				{ name: 'Язык QML и построение интерфейсов', hours: 32 },
				{ name: 'Логика приложения на C++ и Qt', hours: 36 },
				{ name: 'Сеть, данные и системные сервисы', hours: 24 },
				{ name: 'Безопасность и публикация приложения', hours: 16 },
				{ name: 'Проектная работа', hours: 20 }
			],
			format:
				'Смешанный: теория в записи на учебной платформе ИТ Школы, очные практические занятия в вузе, проектная работа в командах с консультациями эксперта.',
			assessment: 'Экзамен: защита мобильного приложения, запущенного на устройстве или эмуляторе.',
			institutionGets: [
				'Рабочая программа дисциплины, фонд оценочных средств и сценарии практических занятий.',
				'Обучение преподавателей работе с Аврора SDK.',
				'Консультации эксперта Школы по проектам студентов.'
			],
			productKeys: ['cloud']
		}
	},
	{
		key: 'vo-mag-01',
		code: 'VO-MAG-01',
		name: 'Low-code аналитика данных',
		level: 'master',
		directionCode: '09.04.01',
		description:
			'Программа для магистрантов, которым нужно быстро превращать данные в решения — от подготовки источников до интерактивных панелей для руководителей. Занятия идут в low-code среде RT.DataVision, поэтому основное время уходит на постановку задачи и интерпретацию результатов, а не на код. Объём — 144 академических часа; итоговая аттестация — проектная работа на данных реальной организации, которая может войти в магистерскую диссертацию.',
		status: 'active',
		versions: [
			{ summary: 'Первая редакция программы.', effectiveFrom: '2023-09-01' },
			{
				summary: 'Уточнены требования к выпускной работе и состав проектного модуля.',
				effectiveFrom: '2025-02-01'
			}
		],
		brochure: {
			audience:
				'Магистранты 1–2 курсов по направлениям 09.04.01, 38.04.05 и смежным; нужны базовые знания статистики.',
			goals: [
				'Научить ставить аналитическую задачу и выбирать метрики под решение.',
				'Дать навыки подготовки данных и построения дашбордов в low-code среде.',
				'Подготовить проектную работу, пригодную для магистерской диссертации.'
			],
			modules: [
				{ name: 'Постановка аналитической задачи и метрики', hours: 16 },
				{ name: 'Подготовка и очистка данных', hours: 28 },
				{ name: 'Визуализация и дашборды в RT.DataVision', hours: 32 },
				{ name: 'Статистические методы для принятия решений', hours: 24 },
				{ name: 'Проектный модуль: анализ данных организации', hours: 32 },
				{ name: 'Защита проекта', hours: 12 }
			],
			format:
				'Смешанный: онлайн-лекции экспертов ИТ Школы, практикумы в вузе, проектная работа на данных организации-партнёра.',
			assessment:
				'Защита проектной работы перед комиссией с участием эксперта ИТ Школы; требования к работе согласованы с требованиями к магистерской диссертации.',
			institutionGets: [
				'Рабочая программа, фонд оценочных средств и требования к проектной работе.',
				'Наборы учебных данных для практикумов.',
				'Обучение преподавателей и участие эксперта Школы в защите проектов.'
			],
			productKeys: ['analytics']
		}
	},
	{
		key: 'vo-mag-02',
		code: 'VO-MAG-02',
		name: 'Распределённые реестры',
		level: 'master',
		directionCode: '09.04.02',
		description:
			'Черновик магистерского модуля о технологиях распределённого реестра и их применении в информационных системах предприятий. Магистранты разбирают механизмы консенсуса, пишут и тестируют смарт-контракты, проектируют учёт цифровых активов на платформе Web3Gate. Планируемый объём — 108 академических часов; состав модулей согласуется с вузами-партнёрами.',
		status: 'draft',
		versions: [
			{
				summary: 'Черновик первой редакции, согласуется с партнёрами.',
				effectiveFrom: '2026-09-01'
			}
		],
		brochure: {
			audience:
				'Магистранты по направлениям 09.04.02, 10.04.01 и смежным; нужны уверенное программирование и основы криптографии.',
			goals: [
				'Дать понимание устройства распределённых реестров и границ их применения.',
				'Научить разрабатывать и тестировать смарт-контракты.',
				'Показать учёт цифровых активов на отечественной платформе.'
			],
			modules: [
				{ name: 'Основы распределённых реестров и криптографии', hours: 20 },
				{ name: 'Механизмы консенсуса и архитектура сетей', hours: 20 },
				{ name: 'Смарт-контракты: разработка и тестирование', hours: 28 },
				{ name: 'Цифровые активы на платформе Web3Gate', hours: 20 },
				{ name: 'Проект и защита', hours: 20 }
			],
			format:
				'Смешанный: онлайн-лекции, лабораторные работы в учебной сети Web3Gate, проектная работа в командах. Формат уточняется вместе с вузами-партнёрами.',
			assessment: 'Экзамен: защита проекта информационной системы с распределённым реестром.',
			institutionGets: [
				'Проект рабочей программы для согласования с кафедрой.',
				'Учебная сеть для лабораторных работ.',
				'Консультации эксперта Школы при доработке программы.'
			],
			productKeys: ['security']
		}
	},
	{
		key: 'spo-01',
		code: 'SPO-01',
		name: 'SQL-разработчик',
		level: 'spo',
		directionCode: '09.02.07',
		description:
			'Курс для студентов колледжей специальности «Информационные системы и программирование»: от первых запросов до проектирования схемы базы данных и оптимизации запросов. Обучение построено на практических заданиях по учебной базе и витринам корпоративного хранилища RT.Warehouse. Объём — 72 академических часа, итог — демонстрационный экзамен по SQL.',
		status: 'active',
		versions: [{ summary: 'Первая редакция программы.', effectiveFrom: '2022-09-01' }],
		brochure: {
			audience:
				'Студенты 2–3 курсов колледжей по специальностям 09.02.07, 09.02.06 и смежным; специальной подготовки не требуется.',
			goals: [
				'Научить писать запросы к реляционной базе данных любой сложности.',
				'Дать навыки проектирования схемы и нормализации.',
				'Подготовить к демонстрационному экзамену и работе с корпоративными витринами данных.'
			],
			modules: [
				{ name: 'Реляционная модель и основы SQL', hours: 12 },
				{ name: 'Выборки, соединения и агрегаты', hours: 16 },
				{ name: 'Проектирование схемы и нормализация', hours: 12 },
				{ name: 'Функции, процедуры и транзакции', hours: 12 },
				{ name: 'Оптимизация запросов и работа с витринами', hours: 12 },
				{ name: 'Демонстрационный экзамен', hours: 8 }
			],
			format:
				'Очные занятия в колледже по сценариям ИТ Школы, практические задания в учебной среде, онлайн-консультации эксперта.',
			assessment:
				'Демонстрационный экзамен: набор практических заданий по SQL с автоматической проверкой.',
			institutionGets: [
				'Рабочая программа, сценарии занятий и банк практических заданий.',
				'Учебная база данных и доступ к учебной среде.',
				'Обучение преподавателей колледжа.'
			],
			productKeys: ['warehouse']
		}
	},
	{
		key: 'spo-02',
		code: 'SPO-02',
		name: 'Аналитика на Python',
		level: 'spo',
		directionCode: '09.02.06',
		description:
			'Программа для студентов колледжей, которые делают первые шаги в анализе данных. Студенты осваивают Python и библиотеки pandas и matplotlib, учатся загружать данные из файлов и отечественных хранилищ, проверять гипотезы и оформлять выводы в отчёт. Объём — 108 академических часов; обучение завершается защитой аналитического мини-проекта.',
		priority: 2,
		status: 'active',
		versions: [
			{ summary: 'Первая редакция программы.', effectiveFrom: '2021-09-01' },
			{
				summary: 'Добавлен модуль по работе с отечественными хранилищами данных.',
				effectiveFrom: '2024-09-01'
			}
		],
		brochure: {
			audience:
				'Студенты 2–4 курсов колледжей по ИТ-специальностям и специальностям связи; опыт программирования не требуется.',
			goals: [
				'Научить основам Python для обработки и анализа данных.',
				'Дать навыки визуализации и простой статистической проверки гипотез.',
				'Познакомить с загрузкой данных из отечественных хранилищ.'
			],
			modules: [
				{ name: 'Основы Python для анализа данных', hours: 24 },
				{ name: 'Работа с таблицами в pandas', hours: 24 },
				{ name: 'Визуализация данных', hours: 16 },
				{ name: 'Работа с отечественными хранилищами данных', hours: 16 },
				{ name: 'Основы статистики и проверка гипотез', hours: 16 },
				{ name: 'Мини-проект', hours: 12 }
			],
			format:
				'Очные занятия в колледже, домашние задания с автоматической проверкой на учебной платформе ИТ Школы, онлайн-разборы с экспертом.',
			assessment:
				'Дифференцированный зачёт: защита аналитического мини-проекта на открытых данных.',
			institutionGets: [
				'Рабочая программа, сценарии занятий и наборы учебных данных.',
				'Доступ студентов к учебной платформе с автоматической проверкой заданий.',
				'Обучение преподавателей колледжа.'
			],
			productKeys: ['warehouse']
		}
	},
	{
		key: 'school-01',
		code: 'SCH-01',
		name: 'Промпт-инжиниринг',
		level: 'school',
		description:
			'Курс для учеников 9–11 классов о том, как ставить задачи языковым моделям и проверять их ответы. Школьники учатся формулировать запросы, разбирать ошибки моделей, работать с текстом, кодом и изображениями и соблюдать правила безопасного использования ИИ. Объём — 36 академических часов в формате кружка при школе, итог — защита мини-проекта с помощником на основе языковой модели.',
		priority: 4,
		status: 'active',
		versions: [{ summary: 'Первая редакция программы.', effectiveFrom: '2023-09-01' }],
		brochure: {
			audience: 'Ученики 9–11 классов; достаточно уверенной работы с компьютером.',
			goals: [
				'Научить формулировать задачи для языковых моделей и проверять результат.',
				'Показать, как ИИ помогает в учёбе, и где ему нельзя доверять.',
				'Сформировать правила безопасной и честной работы с ИИ.'
			],
			modules: [
				{ name: 'Как устроены языковые модели', hours: 4 },
				{ name: 'Составление запросов: роль, контекст, формат', hours: 8 },
				{ name: 'Проверка фактов и ошибки моделей', hours: 6 },
				{ name: 'ИИ для учёбы: тексты, код, изображения', hours: 8 },
				{ name: 'Этика и безопасность', hours: 4 },
				{ name: 'Мини-проект', hours: 6 }
			],
			format:
				'Кружок при школе: занятие раз в неделю, ведёт учитель школы по сценариям ИТ Школы; на защиту проектов приходит эксперт Школы.',
			assessment: 'Защита мини-проекта: помощник на основе языковой модели для учебной задачи.',
			institutionGets: [
				'Сценарии занятий и методические материалы для учителя.',
				'Доступ учеников к учебной среде с языковыми моделями.',
				'Консультации эксперта Школы для учителя.'
			],
			productKeys: []
		}
	},
	// Коммерческие курсы школы, которые продаёт сайт: их названия приходят в
	// выгрузке оплат колонкой «Курс» и сверяются со справочником по названию.
	// Коды и редакции — демонстрационные, как и у остальных программ набора.
	{
		key: 'school-02',
		code: 'SCH-02',
		name: 'Анализ данных без программирования',
		level: 'school',
		description:
			'Онлайн-курс для специалистов без технического образования, которым нужно работать с данными: менеджеров, экономистов, специалистов по продажам и маркетингу. Слушатели учатся собирать данные из таблиц, чистить и объединять их, строить сводные отчёты и интерактивные дашборды в RT.DataVision без программирования. Объём — 48 академических часов, итог — дашборд по собственной рабочей задаче и сертификат ИТ Школы.',
		priority: 4,
		status: 'active',
		versions: [{ summary: 'Первая редакция программы.', effectiveFrom: '2025-09-01' }],
		brochure: {
			audience:
				'Взрослые специалисты без опыта программирования, которые работают с таблицами и отчётами.',
			goals: [
				'Научить готовить данные к анализу без программирования.',
				'Дать навыки выбора визуализации и построения дашборда.',
				'Помочь применить анализ к собственной рабочей задаче.'
			],
			modules: [
				{ name: 'Данные и метрики', hours: 6 },
				{ name: 'Работа с таблицами и сводными отчётами', hours: 10 },
				{ name: 'Очистка и объединение источников', hours: 8 },
				{ name: 'Визуализация: какой график выбрать', hours: 8 },
				{ name: 'Дашборды в RT.DataVision', hours: 10 },
				{ name: 'Итоговый проект', hours: 6 }
			],
			format:
				'Онлайн: видеоуроки, вебинары с экспертом раз в неделю, практические задания с проверкой наставником.',
			assessment: 'Итоговый проект: дашборд по собственной рабочей задаче с разбором наставника.',
			institutionGets: [
				'Корпоративные группы для сотрудников организации-партнёра.',
				'Отчёт о прогрессе и результатах слушателей группы.',
				'Сертификаты ИТ Школы для слушателей, защитивших проект.'
			],
			productKeys: ['analytics']
		}
	},
	{
		key: 'school-03',
		code: 'SCH-03',
		name: 'Инженер-тестировщик',
		level: 'school',
		description:
			'Курс для тех, кто начинает карьеру в ИТ с тестирования программного обеспечения. Слушатели осваивают тест-дизайн, ведение баг-репортов, тестирование веб-приложений и API, основы SQL и автоматизации на Python. Объём — 96 академических часов онлайн с проверкой домашних заданий наставником; итог — портфолио из тестовой документации и автотестов и сертификат ИТ Школы.',
		priority: 4,
		status: 'active',
		versions: [{ summary: 'Первая редакция программы.', effectiveFrom: '2025-09-01' }],
		brochure: {
			audience:
				'Взрослые без опыта в ИТ и начинающие специалисты, которые хотят сменить профессию.',
			goals: [
				'Научить проектировать тесты и вести тестовую документацию.',
				'Дать практику ручного тестирования веб-приложений и API.',
				'Заложить основу автоматизации тестирования на Python.'
			],
			modules: [
				{ name: 'Жизненный цикл ПО и роль тестировщика', hours: 8 },
				{ name: 'Тест-дизайн и тестовая документация', hours: 20 },
				{ name: 'Тестирование веб-приложений', hours: 20 },
				{ name: 'Тестирование API и основы SQL', hours: 20 },
				{ name: 'Автоматизация тестирования на Python', hours: 20 },
				{ name: 'Итоговый проект', hours: 8 }
			],
			format:
				'Онлайн: видеоуроки, практические задания на учебных стендах, проверка работ и консультации наставника.',
			assessment:
				'Итоговый проект: тест-план, набор тест-кейсов и автотесты для учебного веб-приложения.',
			institutionGets: [
				'Корпоративные группы для сотрудников и студентов организации-партнёра.',
				'Учебные стенды для практических заданий.',
				'Сертификаты ИТ Школы для слушателей, защитивших проект.'
			],
			productKeys: []
		}
	},
	{
		key: 'school-04',
		code: 'SCH-04',
		name: 'Управление ИТ-проектами на базе программного продукта ПАО «Ростелеком»',
		level: 'school',
		description:
			'Курс для руководителей проектов и команд, которые переходят на отечественные инструменты управления работой. Слушатели разбирают классический и гибкий подходы, планируют сроки и ресурсы, ведут задачи, риски и отчётность в системе «Яга». Объём — 48 академических часов онлайн, итог — план проекта, собранный в системе, и сертификат ИТ Школы.',
		priority: 4,
		status: 'active',
		versions: [{ summary: 'Первая редакция программы.', effectiveFrom: '2025-09-01' }],
		brochure: {
			audience:
				'Руководители проектов, тимлиды и координаторы команд, в том числе без технического образования.',
			goals: [
				'Научить планировать проект и управлять его сроками, ресурсами и рисками.',
				'Показать, когда выбирать классический подход, а когда гибкий.',
				'Дать навыки ведения проекта в отечественной системе управления задачами.'
			],
			modules: [
				{ name: 'Проект и его жизненный цикл', hours: 6 },
				{ name: 'Планирование: цели, сроки, ресурсы', hours: 10 },
				{ name: 'Гибкие подходы: Scrum и Kanban', hours: 8 },
				{ name: 'Ведение задач и команды в системе «Яга»', hours: 12 },
				{ name: 'Риски, коммуникации и отчётность', hours: 6 },
				{ name: 'Итоговый проект', hours: 6 }
			],
			format:
				'Онлайн: вебинары с экспертом, практикумы в учебном пространстве системы «Яга», разбор проектов слушателей.',
			assessment: 'Итоговый проект: план проекта, собранный и защищённый в системе «Яга».',
			institutionGets: [
				'Корпоративные группы для руководителей проектов организации-партнёра.',
				'Учебное пространство в системе «Яга» на время обучения.',
				'Сертификаты ИТ Школы для слушателей, защитивших проект.'
			],
			productKeys: ['docs']
		}
	},
	{
		key: 'school-05',
		code: 'SCH-05',
		name: 'Python-разработчик с использованием инструментов ИИ',
		level: 'school',
		description:
			'Курс для начинающих разработчиков: язык Python с нуля до собственного веб-сервиса и работа с ИИ-ассистентами на каждом этапе. Слушатели пишут код, тесты и документацию, учатся проверять подсказки ассистента и встраивать языковые модели в свои приложения. Объём — 120 академических часов онлайн с код-ревью наставника; итог — веб-сервис в портфолио и сертификат ИТ Школы.',
		priority: 4,
		status: 'active',
		versions: [{ summary: 'Первая редакция программы.', effectiveFrom: '2025-09-01' }],
		brochure: {
			audience:
				'Взрослые, которые начинают путь в разработке; достаточно уверенной работы с компьютером.',
			goals: [
				'Научить программировать на Python и собирать веб-сервис.',
				'Дать навык работы с ИИ-ассистентом и критической проверки его подсказок.',
				'Показать, как встроить языковую модель в собственное приложение.'
			],
			modules: [
				{ name: 'Основы Python', hours: 28 },
				{ name: 'Структуры данных и ООП', hours: 20 },
				{ name: 'Работа с ИИ-ассистентом: код, тесты, документация', hours: 16 },
				{ name: 'Базы данных и веб-сервис на FastAPI', hours: 28 },
				{ name: 'Интеграция языковых моделей в приложение', hours: 16 },
				{ name: 'Итоговый проект', hours: 12 }
			],
			format: 'Онлайн: видеоуроки, практические задания, код-ревью и консультации наставника.',
			assessment:
				'Итоговый проект: веб-сервис с базой данных и функцией на основе языковой модели.',
			institutionGets: [
				'Корпоративные группы для сотрудников и студентов организации-партнёра.',
				'Отчёт о прогрессе и результатах слушателей группы.',
				'Сертификаты ИТ Школы для слушателей, защитивших проект.'
			],
			productKeys: []
		}
	},
	{
		key: 'dpo-01',
		code: 'DPO-01',
		name: 'Управление проектами',
		level: 'dpo',
		description:
			'Программа повышения квалификации для преподавателей и сотрудников вузов, которые ведут проектное обучение и совместные проекты с индустрией. Слушатели осваивают планирование и контроль проекта, гибкие методы работы команды и ведение проекта в системе «Яга», а затем переносят эти практики в учебный процесс. Объём — 72 академических часа в смешанном формате; по итогам выдаётся удостоверение о повышении квалификации.',
		priority: 3,
		status: 'active',
		versions: [{ summary: 'Первая редакция программы.', effectiveFrom: '2024-02-01' }],
		brochure: {
			audience:
				'Преподаватели, руководители образовательных программ и сотрудники проектных офисов вузов и колледжей.',
			goals: [
				'Дать инструменты планирования и контроля проекта.',
				'Научить организовывать работу студенческих проектных команд по гибким методам.',
				'Помочь встроить проектное обучение в учебный план.'
			],
			modules: [
				{ name: 'Основы управления проектами', hours: 12 },
				{ name: 'Планирование и контроль сроков и ресурсов', hours: 14 },
				{ name: 'Гибкие методы и работа команды', hours: 12 },
				{ name: 'Проект в системе «Яга»', hours: 14 },
				{ name: 'Проектное обучение в вузе: как встроить в учебный план', hours: 12 },
				{ name: 'Итоговая аттестация', hours: 8 }
			],
			format:
				'Смешанный: онлайн-модули на учебной платформе ИТ Школы и два очных интенсива в вузе, практикум в учебном пространстве системы «Яга».',
			assessment:
				'Итоговая аттестация: защита проекта внедрения проектного обучения на своей кафедре; выдаётся удостоверение о повышении квалификации.',
			institutionGets: [
				'Обучение группы преподавателей с выдачей удостоверений.',
				'Шаблоны проектной документации для студенческих команд.',
				'Учебное пространство в системе «Яга» на время обучения.'
			],
			productKeys: ['docs']
		}
	}
];

type ProductSeed = { key: string; vendorKey: string } & Omit<
	z.input<typeof createProductSchema>,
	'vendorOrganizationId'
>;

const PRODUCTS: readonly ProductSeed[] = [
	{
		key: 'lms',
		vendorKey: 'vendor-basis',
		code: 'RT-DEVOPS',
		name: 'Базис Dynamix',
		description:
			'Платформа виртуализации и DevOps: на ней идёт программа подготовки DevOps-инженеров.',
		status: 'active'
	},
	{
		key: 'analytics',
		vendorKey: 'vendor-rostelecom',
		code: 'RT-DATAVISION',
		name: 'RT.DataVision',
		description:
			'Low-code среда визуализации и анализа данных для учебных и исследовательских задач.',
		status: 'active'
	},
	{
		key: 'lab',
		vendorKey: 'vendor-rtk-it-plus',
		code: 'RT-AKOLA',
		name: 'AKOLA',
		description: 'No-code платформа для сборки веб-приложений и порталов.',
		status: 'active'
	},
	{
		key: 'docs',
		vendorKey: 'vendor-rtk-it-plus',
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
		name: 'Web3Gate',
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
	// Архивный продукт нужен фильтру «В архиве» каталога; статус демонстрационный.
	{
		key: 'archive',
		vendorKey: 'vendor-tdata',
		code: 'RT-DATALAKE',
		name: 'RT.DataLake',
		description: 'Озеро данных: хранение и подготовка больших наборов под аналитику.',
		status: 'archived'
	},
	{
		key: 'warehouse',
		vendorKey: 'vendor-tdata',
		code: 'RT-WAREHOUSE',
		name: 'RT.Warehouse',
		description: 'Корпоративное хранилище данных: витрины и отчётность поверх озера данных.',
		status: 'active'
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
			PROGRAMS.map(({ key, versions: _versions, brochure: _brochure, ...raw }) => ({
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
	/** По одному PDF «Описание программы» на каждую программу. */
	programMaterials: PROGRAMS.length,
	products: PRODUCTS.length
} as const;

/** Всё, что печатается в PDF «Описание программы», — уже с названиями, а не ключами. */
export type ProgramMaterialSeed = {
	key: string;
	code: string;
	name: string;
	level: ProgramSeed['level'];
	directionCode: string | null;
	itDirection: string;
	description: string;
	/** Последняя редакция: её состав и описывает материал. */
	version: { number: number; summary: string; effectiveFrom: string };
	brochure: ProgramBrochure;
	products: readonly { name: string; description: string }[];
};

/**
 * Материалы программ собираются из того же набора, что и сами программы:
 * описание на карточке и PDF рядом с ним не должны расходиться.
 */
export const PROGRAM_MATERIAL_SEEDS: readonly ProgramMaterialSeed[] = PROGRAMS.map((program) => {
	const direction = DIRECTIONS.find((item) => item.key === PROGRAM_DIRECTIONS[program.key]);
	const latest = program.versions.at(-1);

	if (direction === undefined || latest === undefined || program.description == null) {
		throw new Error(`Сид «program/${program.key}»: нет направления, редакции или описания`);
	}

	return {
		key: program.key,
		code: program.code,
		name: program.name,
		level: program.level,
		directionCode: program.directionCode ?? null,
		itDirection: direction.name,
		description: program.description,
		version: {
			number: program.versions.length,
			summary: latest.summary,
			effectiveFrom: latest.effectiveFrom
		},
		brochure: program.brochure,
		products: program.brochure.productKeys.map((productKey) => {
			const product = PRODUCTS.find((item) => item.key === productKey);

			if (product === undefined || product.description == null) {
				throw new Error(`Сид «program/${program.key}»: продукт «${productKey}» не описан`);
			}

			return { name: product.name, description: product.description };
		})
	};
});
