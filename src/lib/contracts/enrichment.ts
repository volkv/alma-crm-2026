/**
 * Обогащение реквизитов организации из внешних источников.
 *
 * Сотрудник знает про вуз одно из двух: как он называется или какой у него ИНН.
 * Всё остальное — полное и краткое наименование, КПП, ОГРН, регион, сайт —
 * приходится собирать руками из выписки и с сайта. Модуль делает это за него:
 * по названию или ИНН спрашивает Dadata (ЕГРЮЛ), а затем читает раздел
 * «Сведения об образовательной организации» на сайте вуза, который по приказу
 * Рособрнадзора живёт по адресу `/sveden` и размечен микроданными.
 *
 * Здесь — только то, что нужно обеим сторонам: запрос из формы и вид результата
 * на экране. Ходят наружу `$lib/server/enrichment/*`, и браузер о них не знает.
 *
 * Результат — это **черновик**, а не карточка. Ни одно поле не записывается в
 * справочник само: внешний источник ошибается, отстаёт от жизни и путает
 * головную организацию с филиалом, поэтому у каждого поля указан источник, а
 * решение остаётся за человеком.
 */
import { z } from 'zod';
import { isValidInn } from '$lib/validation/inn';
import { requiredText } from './common';
import type { EducationLevel, OrganizationKind } from './directory';

/** Потолок строки поиска: длиннее любого названия вуза вместе с формой. */
export const LOOKUP_QUERY_MAX = 300;

export const organizationLookupSchema = z.object({
	query: requiredText(LOOKUP_QUERY_MAX, 'Введите название вуза или его ИНН'),
	/**
	 * Адрес сайта, если сотрудник знает его сам.
	 *
	 * Dadata адреса сайта не отдаёт — в выписке ЕГРЮЛ его попросту нет, — а
	 * догадка по домену почты попадает не всегда. Поэтому поле есть: сотрудник,
	 * у которого сайт перед глазами, называет его и получает раздел `/sveden`
	 * сразу, вместо того чтобы смотреть, чем кончится догадка.
	 *
	 * Пустая строка, а не `null`: поле формы всегда строка, и превращать её в
	 * «не задано» — дело того, кто ищет, а не схемы.
	 */
	website: z.string().trim().max(2000, { error: 'Адрес не длиннее 2000 символов' }).default('')
});

export type OrganizationLookupInput = z.infer<typeof organizationLookupSchema>;

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

/** Откуда взялось значение поля — это видно рядом с ним на экране. */
export const FIELD_SOURCES = ['dadata', 'sveden', 'guess', 'input'] as const;

export type FieldSource = (typeof FIELD_SOURCES)[number];

/**
 * Одна организация в ответе справочника юридических лиц.
 *
 * Имена полей — наши, а не Dadata: карточка справочника не обязана знать, что
 * у поставщика краткое наименование лежит в `data.name.short_with_opf`.
 */
export type LegalEntity = {
	inn: string | null;
	kpp: string | null;
	ogrn: string | null;
	/** Полное наименование с организационно-правовой формой. */
	legalName: string;
	/** Краткое — то, которым вуз называют в переписке. */
	shortName: string;
	region: string | null;
	/** Адрес одной строкой, как его отдал поставщик. */
	address: string | null;
	status: LegalStatus;
	/** Головная организация или филиал: у филиала свой КПП и общий ИНН. */
	isBranch: boolean;
	/** Руководитель: ФИО и должность, если поставщик их отдал. */
	management: { name: string; post: string | null } | null;
	/** Почта из выписки — она же единственная зацепка для поиска сайта. */
	emails: string[];
	/** Основной вид деятельности (ОКВЭД) кодом: по нему видно, вуз ли это. */
	okved: string | null;
};

/** Поля карточки организации, которые модуль умеет заполнить. */
export type OrganizationDraft = {
	kind: OrganizationKind;
	educationLevel: EducationLevel | null;
	legalName: string;
	shortName: string;
	inn: string | null;
	kpp: string | null;
	ogrn: string | null;
	region: string | null;
	website: string | null;
};

/** Источник каждого поля черновика — по одному на поле, без пропусков. */
export type DraftSources = Record<keyof OrganizationDraft, FieldSource>;

/**
 * Что нашлось в разделе «Сведения об образовательной организации».
 *
 * Раздел проверяется не только ради полей: сам факт, что по `/sveden` лежит
 * размеченная страница, отличает сайт вуза от сайта однофамильца в домене.
 */
export type SvedenReport = {
	/** Адрес, по которому раздел нашёлся или по которому его искали. */
	url: string;
	/** Нашёлся ли раздел с микроразметкой. */
	found: boolean;
	/** Поля раздела, которые удалось прочитать. */
	fields: {
		fullName: string | null;
		shortName: string | null;
		/** Дата создания образовательной организации. */
		regDate: string | null;
		address: string | null;
		telephone: string | null;
		email: string | null;
		/** Учредитель — у государственного вуза это министерство. */
		founder: string | null;
		/** ФИО руководителя по разделу: в ЕГРЮЛ он же, но пишется иначе. */
		headName: string | null;
		headPost: string | null;
	};
	/** Сколько размеченных свойств встретилось всего: мера полноты раздела. */
	propertyCount: number;
	/** Почему раздел не прочитался; пусто — прочитался. */
	problem: string | null;
};

/** Итог поиска: черновик карточки и всё, на чём он построен. */
export type OrganizationLookupResult = {
	kind: LookupQueryKind;
	/** Организация, по которой собран черновик. */
	entity: LegalEntity;
	/**
	 * Остальные попавшие под запрос — по названию их бывает десяток, и выбор
	 * между «Политехническим университетом» и его филиалом делает человек.
	 */
	others: LegalEntity[];
	draft: OrganizationDraft;
	sources: DraftSources;
	/** Раздел `/sveden`; `null` — сайт не нашёлся, искать было негде. */
	sveden: SvedenReport | null;
	/** Замечания сотруднику: что не сошлось и на что посмотреть глазами. */
	warnings: string[];
};
