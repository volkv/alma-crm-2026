/**
 * Паспорт организации из внешних источников: от строки поиска или сайта до
 * предложения полей карточки.
 *
 * Два входа, по шагам работы сотрудника. По названию или ИНН спрашивается
 * справочник юридических лиц (`dadata.ts`) — оттуда реквизиты. По сайту из
 * карточки читается раздел «Сведения об образовательной организации»
 * (`sveden.ts`) — оттуда наименования, кандидаты в контакты и программы.
 * Третий вход — снимок JSON, загруженный файлом: тот же паспорт, собранный
 * там, где источники были включены.
 *
 * Модуль ничего не пишет в справочник. Наружу он отдаёт паспорт под номером
 * (`passports.ts`), а записывает принятые поля форма организации — когда
 * сотрудник увидел разницу, отметил нужное и сохранил. Результат всегда неполон
 * и местами неверен: ЕГРЮЛ отстаёт от жизни, сайт вуза заполняли руками, а вид
 * организации угадан. Поэтому у каждого значения — источник и дата, а рядом —
 * замечания, что посмотреть глазами.
 */
import { createHash } from 'node:crypto';
import {
	lookupQueryKind,
	organizationPassportSchema,
	passportValueFits,
	PASSPORT_FIELDS,
	type FieldSource,
	type IssuedPassport,
	type LegalEntity,
	type LookupQueryKind,
	type OrganizationPassport,
	type PassportField,
	type PassportValue,
	type SiteReport
} from '$lib/contracts/enrichment';
import type { ActorContext } from '../actor';
import { cached, peekCached, type CacheRegion } from '../cache/region';
import { NotFoundError, ValidationError } from '../errors';
import { requirePermission } from '../rbac';
import { consumeQuota, requireEnabled } from './access';
import { guessEducationLevel, guessKind } from './classify';
import { DadataError, DADATA_NOT_CONFIGURED, findParties, isDadataConfigured } from './dadata';
import { issuePassport } from './passports';
import { fetchSiteReport, normalizeWebsite } from './sveden';
import { findWebsite, type WebsiteFinding } from './website';

/** Состояния ЕГРЮЛ, о которых сотруднику говорят отдельно. */
const STATUS_WARNINGS: Record<string, string> = {
	liquidating: 'По ЕГРЮЛ организация в процессе ликвидации',
	liquidated: 'По ЕГРЮЛ организация ликвидирована',
	reorganizing: 'По ЕГРЮЛ организация в процессе реорганизации',
	bankrupt: 'По ЕГРЮЛ организация в процедуре банкротства',
	unknown: 'Состояние организации в ЕГРЮЛ не определено'
};

/**
 * Ответы источников живут сутки. Реквизиты вуза меняются реже, чем раз в год,
 * а лимит подсказок у поставщика общий на стенд. Перепроверки по расписанию нет
 * намеренно: паспорт спрашивают, когда заводят или правят карточку, и держать
 * его свежим без человека, который на него смотрит, незачем.
 */
const ENRICHMENT_CACHE: CacheRegion = { name: 'enrichment', ttlSeconds: 24 * 60 * 60 };

function valueOf(
	value: string | null | undefined,
	source: FieldSource,
	fetchedAt: string
): PassportValue | undefined {
	const trimmed = value?.trim();

	return trimmed === undefined || trimmed === ''
		? undefined
		: { value: trimmed, source, fetchedAt };
}

/** Поля без пустых: пустое значение источника — не предложение стереть поле. */
function compact(
	fields: Partial<Record<PassportField, PassportValue | undefined>>
): OrganizationPassport['fields'] {
	const result: OrganizationPassport['fields'] = {};

	for (const field of PASSPORT_FIELDS) {
		const value = fields[field];

		if (value !== undefined) {
			result[field] = value;
		}
	}

	return result;
}

/**
 * Паспорт по ответу реестра.
 *
 * Реквизиты — ИНН, КПП, ОГРН, регион, наименования — как их отдал ЕГРЮЛ. Вид
 * организации и уровень образования угаданы по ОКВЭД и названию и помечены
 * догадкой. Сайта в ЕГРЮЛ нет: его ищет цепочка источников (`website/`), и у
 * значения тот источник, который ответил, — справочник вузов или догадка по
 * почте. Не ответил никто — поля нет: паспорт без сайта всё равно паспорт.
 */
export async function registryPassport(
	query: string,
	entities: readonly LegalEntity[],
	fetchedAt: string
): Promise<OrganizationPassport> {
	const [entity, ...others] = entities;

	if (entity === undefined) {
		throw new NotFoundError('По этой строке в реестре никого нет');
	}

	const kind = guessKind(entity.legalName, entity.okved);
	const educationLevel =
		kind === 'educational_institution' ? guessEducationLevel(entity.legalName, entity.okved) : null;
	const website = await findWebsite(entity);

	return {
		version: 1,
		query,
		entity,
		others,
		fields: compact({
			kind: valueOf(kind, 'guess', fetchedAt),
			educationLevel: valueOf(educationLevel, 'guess', fetchedAt),
			legalName: valueOf(entity.legalName, 'dadata', fetchedAt),
			shortName: valueOf(entity.shortName, 'dadata', fetchedAt),
			inn: valueOf(entity.inn, 'dadata', fetchedAt),
			kpp: valueOf(entity.kpp, 'dadata', fetchedAt),
			ogrn: valueOf(entity.ogrn, 'dadata', fetchedAt),
			region: valueOf(entity.region, 'dadata', fetchedAt),
			website:
				website === null
					? undefined
					: {
							value: website.website,
							source: website.source,
							fetchedAt: website.fetchedAt ?? fetchedAt
						}
		}),
		site: null,
		warnings: registryWarnings(entity, others, kind, website)
	};
}

/** Что проверить глазами в ответе реестра, прежде чем принимать реквизиты. */
export function registryWarnings(
	entity: LegalEntity,
	others: readonly LegalEntity[],
	kind: string,
	website: WebsiteFinding | null
): string[] {
	const warnings: string[] = [];
	const statusWarning = STATUS_WARNINGS[entity.status];

	if (statusWarning !== undefined) {
		warnings.push(statusWarning);
	}

	if (entity.isBranch) {
		warnings.push('Это филиал, а не головная организация: ИНН у них общий, КПП разный');
	}

	if (others.length > 0) {
		warnings.push(
			`Под запрос попало ещё ${others.length} организаций — проверьте, что выбрана нужная`
		);
	}

	if (kind !== 'educational_institution') {
		warnings.push(
			'По названию и коду ОКВЭД это не похоже на образовательную организацию: вид угадан'
		);
	}

	// Насколько верить сайту, знает тот источник, который его дал: догадка по
	// почте и выгрузка мониторинга ошибаются по-разному.
	if (website !== null && website.note !== null) {
		warnings.push(website.note);
	}

	return warnings;
}

/**
 * Наименование, как его набрали в ячейке сайта: с заглавной буквы и без точки
 * в конце — «федеральное … Великого».» в карточку не переносят.
 */
function tidyOrganizationName(value: string): string {
	const trimmed = value.trim().replace(/\s+/g, ' ').replace(/\.+$/, '').trim();

	return trimmed.charAt(0).toLocaleUpperCase('ru') + trimmed.slice(1);
}

/**
 * Написания через запятую или точку с запятой: разделитель внутри кавычек
 * («…», "…") частью названия остаётся. Повторы и пустые куски отбрасываются.
 */
function splitNameVariants(value: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let current = '';

	for (const char of value) {
		if (char === '«') {
			depth += 1;
		} else if (char === '»') {
			depth = Math.max(0, depth - 1);
		} else if (char === '"') {
			depth = depth === 0 ? 1 : 0;
		}

		if ((char === ',' || char === ';') && depth === 0) {
			parts.push(current);
			current = '';
		} else {
			current += char;
		}
	}

	parts.push(current);

	const seen = new Set<string>();

	return parts
		.map((part) => tidyOrganizationName(part))
		.filter((part) => {
			const key = part.toLocaleLowerCase('ru');

			if (part === '' || seen.has(key)) {
				return false;
			}

			seen.add(key);
			return true;
		});
}

/**
 * Организационно-правовая форма в начале краткого наименования: «ФГАОУ ВО
 * СПбПУ». В справочнике краткое наименование — то, как вуз зовут в работе,
 * поэтому такие написания предлагаются последними.
 */
const LEGAL_FORM_PREFIX = /^(Ф?Г[АБК]?(ОУ|У)|[АЧН]?НОУ|АНО|ЧОУ|ОУ|МБОУ|МАОУ|ГАПОУ|ГБПОУ)(\s|$)/u;

/**
 * Аббревиатура: одно слово, в котором хотя бы две заглавные, — «ВолгГТУ»,
 * «СПбПУ». Так вуз зовут в работе и в списках.
 */
const ABBREVIATION = /^[\p{L}\d-]*\p{Lu}[\p{L}\d-]*\p{Lu}[\p{L}\d-]*$/u;

/**
 * Краткое наименование с сайта: одно предложенное и остальные написания.
 * Предлагается аббревиатура, если сайт её дал; иначе — первое написание без
 * организационно-правовой формы; если нет и такого — первое как есть.
 */
function shortNameOffer(value: string | null | undefined, fetchedAt: string) {
	const variants = splitNameVariants(value ?? '');
	const [first] = variants;

	if (first === undefined) {
		return undefined;
	}

	const plain = variants.filter((variant) => !LEGAL_FORM_PREFIX.test(variant));
	const chosen = plain.find((variant) => ABBREVIATION.test(variant)) ?? plain[0] ?? first;
	const others = variants.filter((variant) => variant !== chosen);

	return {
		value: chosen,
		...(others.length > 0 ? { variants: others } : {}),
		source: 'sveden' as const,
		fetchedAt
	};
}

/** Субъекты с самостоятельным «г.» в адресе: у остальных регион — область, край, республика. */
const FEDERAL_CITIES = ['Москва', 'Санкт-Петербург', 'Севастополь'] as const;

/**
 * Административные центры субъектов. Адрес вуза в «Сведениях» чаще всего
 * называет только город — «400005, г. Волгоград, пр. Ленина, 28», — и регион
 * по нему однозначен, если это столица субъекта. Для остальных городов
 * догадки нет: Таганрог не скажет, область это или край, без справочника
 * населённых пунктов.
 */
const REGIONAL_CENTERS: Record<string, string> = {
	Майкоп: 'Республика Адыгея',
	'Горно-Алтайск': 'Республика Алтай',
	Уфа: 'Республика Башкортостан',
	'Улан-Удэ': 'Республика Бурятия',
	Махачкала: 'Республика Дагестан',
	Магас: 'Республика Ингушетия',
	Нальчик: 'Кабардино-Балкарская Республика',
	Элиста: 'Республика Калмыкия',
	Черкесск: 'Карачаево-Черкесская Республика',
	Петрозаводск: 'Республика Карелия',
	Сыктывкар: 'Республика Коми',
	Симферополь: 'Республика Крым',
	'Йошкар-Ола': 'Республика Марий Эл',
	Саранск: 'Республика Мордовия',
	Якутск: 'Республика Саха (Якутия)',
	Владикавказ: 'Республика Северная Осетия — Алания',
	Казань: 'Республика Татарстан',
	Кызыл: 'Республика Тыва',
	Ижевск: 'Удмуртская Республика',
	Абакан: 'Республика Хакасия',
	Грозный: 'Чеченская Республика',
	Чебоксары: 'Чувашская Республика',
	Барнаул: 'Алтайский край',
	Чита: 'Забайкальский край',
	'Петропавловск-Камчатский': 'Камчатский край',
	Краснодар: 'Краснодарский край',
	Красноярск: 'Красноярский край',
	Пермь: 'Пермский край',
	Владивосток: 'Приморский край',
	Ставрополь: 'Ставропольский край',
	Хабаровск: 'Хабаровский край',
	Благовещенск: 'Амурская область',
	Архангельск: 'Архангельская область',
	Астрахань: 'Астраханская область',
	Белгород: 'Белгородская область',
	Брянск: 'Брянская область',
	Владимир: 'Владимирская область',
	Волгоград: 'Волгоградская область',
	Вологда: 'Вологодская область',
	Воронеж: 'Воронежская область',
	Иваново: 'Ивановская область',
	Иркутск: 'Иркутская область',
	Калининград: 'Калининградская область',
	Калуга: 'Калужская область',
	Кемерово: 'Кемеровская область',
	Киров: 'Кировская область',
	Кострома: 'Костромская область',
	Курган: 'Курганская область',
	Курск: 'Курская область',
	Липецк: 'Липецкая область',
	Магадан: 'Магаданская область',
	Мурманск: 'Мурманская область',
	'Нижний Новгород': 'Нижегородская область',
	'Великий Новгород': 'Новгородская область',
	Новосибирск: 'Новосибирская область',
	Омск: 'Омская область',
	Оренбург: 'Оренбургская область',
	Орёл: 'Орловская область',
	Орел: 'Орловская область',
	Пенза: 'Пензенская область',
	Псков: 'Псковская область',
	'Ростов-на-Дону': 'Ростовская область',
	Рязань: 'Рязанская область',
	Самара: 'Самарская область',
	Саратов: 'Саратовская область',
	'Южно-Сахалинск': 'Сахалинская область',
	Екатеринбург: 'Свердловская область',
	Смоленск: 'Смоленская область',
	Тамбов: 'Тамбовская область',
	Тверь: 'Тверская область',
	Томск: 'Томская область',
	Тула: 'Тульская область',
	Тюмень: 'Тюменская область',
	Ульяновск: 'Ульяновская область',
	Челябинск: 'Челябинская область',
	Ярославль: 'Ярославская область',
	Биробиджан: 'Еврейская автономная область',
	'Нарьян-Мар': 'Ненецкий автономный округ',
	'Ханты-Мансийск': 'Ханты-Мансийский автономный округ — Югра',
	Анадырь: 'Чукотский автономный округ',
	Салехард: 'Ямало-Ненецкий автономный округ'
};

/**
 * Регион из адреса «Сведений»: первая часть адреса, похожая на субъект
 * федерации, — «г. Санкт-Петербург», «Свердловская обл.», «Республика
 * Татарстан». Адрес набран руками, поэтому это догадка, а не значение
 * источника; не нашлось похожего — `null`.
 */
function regionFromAddress(address: string | null | undefined): string | null {
	if (address === null || address === undefined) {
		return null;
	}

	const parts = address.split(',').map((raw) => raw.trim().replace(/\.$/, ''));

	for (const part of parts) {
		for (const city of FEDERAL_CITIES) {
			if (new RegExp(`^(г\\.?|город)\\s*${city}$`, 'iu').test(part)) {
				return `г. ${city}`;
			}
		}

		if (/\sобл$/u.test(part)) {
			return part.replace(/обл$/u, 'область');
		}

		if (
			/^Республика\s+\S/u.test(part) ||
			/\s(область|край|автономный округ|автономная область|АО)$/u.test(part) ||
			/\sРеспублика$/u.test(part)
		) {
			return part;
		}
	}

	// Субъекта в адресе нет — ищется столица субъекта: «г. Волгоград»,
	// «город Казань» или просто «Волгоград».
	for (const part of parts) {
		const city = part.replace(/^(г\.?|город)\s*/iu, '');
		const region = FEDERAL_CITIES.some((federal) => federal === city)
			? `г. ${city}`
			: REGIONAL_CENTERS[city];

		if (region !== undefined) {
			return region;
		}
	}

	return null;
}

/**
 * Паспорт по разделу `/sveden` сайта.
 *
 * Из полей карточки сайт предлагает наименования и — догадкой по адресу —
 * регион: реквизиты живут в реестре, и сайт, где ИНН набран руками, ему не
 * соперник. Краткое наименование сайт даёт перечнем написаний; предлагается
 * одно, остальные — на выбор. Руководители подразделений и программы идут
 * списками для просмотра.
 */
export function sitePassport(report: SiteReport): OrganizationPassport {
	const common = report.common.found ? report.common.fields : null;
	const fullName =
		common?.fullName === null || common?.fullName === undefined
			? null
			: tidyOrganizationName(common.fullName);

	return {
		version: 1,
		query: null,
		entity: null,
		others: [],
		fields: compact({
			legalName: valueOf(fullName, 'sveden', report.fetchedAt),
			shortName: shortNameOffer(common?.shortName, report.fetchedAt),
			region: valueOf(regionFromAddress(common?.address), 'guess', report.fetchedAt)
		}),
		site: report,
		warnings: siteWarnings(report)
	};
}

/** Что не прочиталось на сайте — сказано словами, а не пустыми блоками. */
export function siteWarnings(report: SiteReport): string[] {
	const warnings: string[] = [];

	if (!report.common.found) {
		warnings.push(
			`«Основные сведения» по адресу ${report.common.url} не прочитались: что сайт принадлежит образовательной организации, ничем не подтверждено`
		);
	}

	if (!report.struct.found) {
		warnings.push(
			'Подраздел «Структура и органы управления» не прочитался: кандидатов в контакты нет'
		);
	}

	if (!report.education.found) {
		warnings.push('Перечень образовательных программ не прочитался');
	} else if (report.education.truncated) {
		warnings.push(
			'Страница с программами больше допустимого размера и прочитана не целиком: список неполон'
		);
	}

	return warnings;
}

function cacheKey(...parts: string[]): string {
	return createHash('sha256').update(parts.join('\u0000'), 'utf8').digest('hex').slice(0, 32);
}

export type RegistryAnswer = {
	kind: LookupQueryKind;
	query: string;
	entities: LegalEntity[];
	fetchedAt: string;
};

/**
 * Ответ реестра по строке поиска — общий шаг панели паспорта и подбора
 * организации в форме взаимодействия.
 *
 * Право — то же, что на правку организаций: ответ существует ради заполнения
 * карточки. Ответ из кэша квоту не тратит — тратит только настоящее обращение
 * к поставщику. Пустой список — не отказ: что с ним делать, решает вызывающий.
 */
export async function queryRegistry(ctx: ActorContext, raw: string): Promise<RegistryAnswer> {
	requirePermission(ctx, 'organizations.write');
	const settings = await requireEnabled();

	// Без ключа обращения не будет — и квоту на него тратить нечего.
	if (!isDadataConfigured()) {
		throw new DadataError('not_configured', null, DADATA_NOT_CONFIGURED);
	}

	const { kind, query } = lookupQueryKind(raw);

	// Кэш общий для всех сотрудников: это открытые сведения реестра, а не
	// выборка из справочника, и области доступа они не знают.
	const answer = await cached<Pick<RegistryAnswer, 'entities' | 'fetchedAt'>>(
		ENRICHMENT_CACHE,
		`registry:${cacheKey(kind, query.toLocaleLowerCase('ru'))}`,
		async () => {
			await consumeQuota(ctx, settings.dailyQuota);

			return { entities: await findParties(query, kind), fetchedAt: new Date().toISOString() };
		},
		(stored) => stored as Pick<RegistryAnswer, 'entities' | 'fetchedAt'>
	);

	return { kind, query, ...answer };
}

/** Поиск по реестру для панели паспорта: реквизиты по названию или ИНН. */
export async function lookupRegistry(ctx: ActorContext, raw: string): Promise<IssuedPassport> {
	const { kind, query, ...answer } = await queryRegistry(ctx, raw);

	if (answer.entities.length === 0) {
		throw new NotFoundError(notFoundMessage(kind));
	}

	return issuePassport(
		ctx,
		'live',
		await registryPassport(query, answer.entities, answer.fetchedAt)
	);
}

/**
 * Подсказки реестра по мере набора — для выпадающего списка панели паспорта.
 *
 * Каждая строка ответа — свой паспорт под своим номером: сотрудник выбирает
 * головной вуз или филиал из списка, и выбранное показывается диффом сразу,
 * без второго обращения к поставщику. Пустой ответ — пустой список, а не
 * отказ: подсказка, которой нечего предложить, ошибкой не является.
 */
export async function suggestRegistry(ctx: ActorContext, raw: string): Promise<IssuedPassport[]> {
	const { query, entities, fetchedAt } = await queryRegistry(ctx, raw);

	return Promise.all(
		entities.map(async (entity) =>
			issuePassport(ctx, 'live', await registryPassport(query, [entity], fetchedAt))
		)
	);
}

function notFoundMessage(kind: LookupQueryKind): string {
	return kind === 'inn'
		? 'Организация с таким ИНН в реестре не найдена'
		: 'По этому названию в реестре ничего не нашлось';
}

/**
 * Чтение раздела `/sveden` по сайту из карточки.
 *
 * Сайт называет форма — то, что сейчас стоит в поле «Сайт». Идти разрешено
 * только внутри его домена (`withinSite`), и каждый адрес проверяется правилом
 * исходящих адресов.
 */
export async function lookupSite(ctx: ActorContext, website: string): Promise<IssuedPassport> {
	requirePermission(ctx, 'organizations.write');
	const settings = await requireEnabled();
	const origin = normalizeWebsite(website);

	if (origin === null) {
		throw new ValidationError('Адрес сайта в карточке не разбирается');
	}

	const report = await cached<SiteReport | null>(
		ENRICHMENT_CACHE,
		siteCacheKey(origin),
		async () => {
			await consumeQuota(ctx, settings.dailyQuota);

			return fetchSiteReport(origin, new Date().toISOString());
		},
		(stored) => stored as SiteReport | null
	);

	if (report === null) {
		throw new ValidationError('Адрес сайта в карточке не разбирается');
	}

	return issuePassport(ctx, 'live', sitePassport(report));
}

/**
 * Ключ отчёта сайта. Номер — версия разбора: отчёт в кэше хранит уже
 * разобранные поля, и после исправления разбора прочитанное раньше должно
 * читаться заново, а не дожидаться суток.
 */
const SITE_REPORT_VERSION = 2;

function siteCacheKey(origin: string): string {
	return `site:v${SITE_REPORT_VERSION}:${cacheKey(origin.toLowerCase())}`;
}

/**
 * Отчёт сайта, если его уже читали в пределах суток, — без обращения к сайту и
 * без списания квоты.
 *
 * Карточка вуза показывает прочитанный раздел сразу, не заставляя нажимать
 * «Прочитать» ради того, что уже лежит в кэше. Право — то же, что на само
 * чтение; выключенные источники не мешают: наружу этот вызов не ходит. Ключ —
 * тот же `siteCacheKey`, под которым отчёт кладёт `lookupSite` через `cached`.
 */
export async function peekSiteReport(
	ctx: ActorContext,
	website: string
): Promise<SiteReport | null> {
	requirePermission(ctx, 'organizations.write');
	const origin = normalizeWebsite(website);

	if (origin === null) {
		return null;
	}

	const report = await peekCached<SiteReport | null>(
		ENRICHMENT_CACHE,
		siteCacheKey(origin),
		(stored) => stored as SiteReport | null
	);

	return report ?? null;
}

/** Потолок снимка: паспорт с полным перечнем программ весит сотни килобайт. */
export const SNAPSHOT_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Снимок паспорта из файла — тот же формат, что отдаёт поиск.
 *
 * Работает и при выключенных источниках: наружу он не ходит, а принятые из него
 * поля проходят тот же дифф и то же подтверждение. Происхождение таких полей
 * помечается снимком: источник и дату в нём назвал тот, кто его собирал.
 */
export async function importSnapshot(ctx: ActorContext, text: string): Promise<IssuedPassport> {
	requirePermission(ctx, 'organizations.write');

	let raw: unknown;

	try {
		raw = JSON.parse(text);
	} catch {
		throw new ValidationError('Файл не читается как JSON');
	}

	const parsed = organizationPassportSchema.safeParse(raw);

	if (!parsed.success) {
		throw new ValidationError(
			'Файл не похож на снимок паспорта организации',
			parsed.error.issues.slice(0, 5).map((issue) => `${issue.path.join('.')}: ${issue.message}`)
		);
	}

	const misfits = PASSPORT_FIELDS.filter((field) => {
		const value = parsed.data.fields[field];

		return value !== undefined && !passportValueFits(field, value.value);
	});

	if (misfits.length > 0) {
		throw new ValidationError('В снимке есть значения, которых карточка не допускает', misfits);
	}

	return issuePassport(ctx, 'snapshot', parsed.data);
}
