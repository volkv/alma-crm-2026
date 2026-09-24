/**
 * Раздел «Сведения об образовательной организации» на сайте вуза.
 *
 * Образовательная организация обязана держать такой раздел по адресу `/sveden`
 * и размечать его микроданными — так требуют Правила размещения информации
 * (постановление Правительства РФ № 1802) и приказ Рособрнадзора о структуре
 * раздела. Поэтому у вуза, в отличие от произвольной организации, реквизиты,
 * подразделения и программы можно прочитать с его же сайта.
 *
 * Читаются три подраздела:
 * - `/sveden/common` — наименование, дата создания, адрес, телефон, почта,
 *   учредитель, руководитель. Сам факт размеченной страницы — ещё и
 *   доказательство, что домен принадлежит образовательной организации;
 * - `/sveden/struct` — подразделения и их руководители: кандидаты в контакты;
 * - `/sveden/education/eduop` (или сам `/sveden/education`, если перечень лежит
 *   прямо на нём) — реализуемые программы с кодами направлений.
 *
 * Ходим только по сайту из карточки организации и только внутри его домена:
 * перенаправление на чужой домен — отказ, а не переход, а переход на `http`
 * внутри сайта повышается до `https` (`redirectTarget`). Каждый заход, включая
 * каждое перенаправление, ещё и проверяется правилом исходящих адресов
 * (`integrations/outbound.ts`): иначе первый же `Location` увёл бы запрос
 * внутрь сети развёртывания.
 */
import { outboundTargetIssue } from '../integrations/outbound';
import { firstProperty, property, propertyValues, readItems, readMicrodata } from './microdata';
import {
	CONTACT_CANDIDATES_MAX,
	PROGRAM_CANDIDATES_MAX,
	type ContactCandidate,
	type ProgramCandidate,
	type SiteReport,
	type SvedenReport,
	type SvedenSection
} from '$lib/contracts/enrichment';

/** Сколько ждём одну страницу: это не наш сервис, и торопить его нечем. */
export const SVEDEN_TIMEOUT_MS = 10_000;

/**
 * Потолок страницы. Перечень программ крупного вуза весит и 15 МиБ — вместе
 * со ссылками на каждый учебный план; читается начало, а экран честно говорит,
 * что список неполон.
 */
export const SVEDEN_BODY_MAX = 4 * 1024 * 1024;

/** Сколько перенаправлений отрабатываем: `http` → `https` → `www` → слеш в конце. */
const REDIRECT_MAX = 4;

/**
 * Адреса подразделов в порядке проверки: первый, где нашлось нужное, и
 * становится ответом.
 *
 * У `common` путь бывает и `/sveden/`, и статическим `.html`. У `education`
 * перечень программ чаще лежит во вложенном `eduop`, а сам `/sveden/education`
 * оказывается меню со ссылками — поэтому `eduop` спрашивается первым.
 */
export const SVEDEN_PATHS = {
	common: ['/sveden/common', '/sveden/', '/sveden/common.html'],
	struct: ['/sveden/struct'],
	education: ['/sveden/education/eduop', '/sveden/education']
} as const;

/**
 * Сайт по почтовому адресу из выписки.
 *
 * В ЕГРЮЛ сайта нет — Dadata его и не отдаёт, — а почта есть, и у вуза она
 * почти всегда на собственном домене (`rector@spbstu.ru`). Это догадка, и
 * помечается она именно так.
 *
 * Общедоступная почта отбрасывается: `mail.ru` — это не сайт вуза.
 */
const PUBLIC_MAIL_DOMAINS = new Set([
	'mail.ru',
	'bk.ru',
	'inbox.ru',
	'list.ru',
	'internet.ru',
	'yandex.ru',
	'ya.ru',
	'yandex.com',
	'rambler.ru',
	'gmail.com',
	'googlemail.com',
	'outlook.com',
	'hotmail.com',
	'yahoo.com',
	'icloud.com'
]);

export function siteFromEmails(emails: readonly string[]): string | null {
	for (const email of emails) {
		const domain = email.split('@')[1]?.trim().toLowerCase();

		if (domain === undefined || domain === '' || PUBLIC_MAIL_DOMAINS.has(domain)) {
			continue;
		}

		// Имя домена, а не что попало после собаки: строка приехала из внешнего
		// справочника и станет адресом в карточке.
		if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) {
			return `https://${domain}`;
		}
	}

	return null;
}

/**
 * Адрес сайта в виде, пригодном для захода.
 *
 * Сотрудник пишет сайт как придётся — `spbstu.ru`, `www.spbstu.ru/`,
 * `https://spbstu.ru/sveden/common`. Схема дописывается, путь отбрасывается:
 * раздел ищется от корня, и «сайт» здесь — это происхождение, а не страница.
 */
export function normalizeWebsite(raw: string): string | null {
	const trimmed = raw.trim();

	if (trimmed === '') {
		return null;
	}

	const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

	try {
		const url = new URL(withScheme);

		return url.hostname === '' ? null : url.origin;
	} catch {
		return null;
	}
}

/**
 * Остаётся ли адрес на сайте организации.
 *
 * Разрешён сам домен из карточки, его `www`-двойник и поддомены: вуз уводит
 * `spbstu.ru` на `www.spbstu.ru`, а раздел держит на `sveden.miet.ru`. Всё
 * остальное — чужой сайт, и идти туда значило бы читать «сведения» кого
 * угодно под именем этого вуза.
 */
export function withinSite(siteHost: string, targetHost: string): boolean {
	const base = siteHost.toLowerCase().replace(/^www\./, '');
	const target = targetHost.toLowerCase().replace(/^www\./, '');

	return target === base || target.endsWith(`.${base}`);
}

/**
 * Куда вести заход после перенаправления; `null` — не идти.
 *
 * Вуз бывает настроен криво: Московский Политех отвечает на
 * `https://mospolytech.ru/sveden/struct` адресом `http://mospolytech.ru/sveden/struct/`,
 * а уже тот — обратно на `https`. Наружу по `http` сервер не ходит (правило
 * исходящих адресов), поэтому переход на `http` **внутри сайта организации**
 * повышается до `https` того же адреса: схема — не повод бросать раздел.
 * Повышение делается только после проверки домена — чужой сайт остаётся отказом
 * при любой схеме, — а итоговый адрес дальше проверяет то же правило исходящих
 * адресов, что и первый заход.
 *
 * Перенаправление на тот же адрес, с которого пришли, — петля: идти по нему
 * значит сжечь лимит переходов впустую.
 */
export function redirectTarget(siteHost: string, current: string, location: string): string | null {
	let next: URL;

	try {
		next = new URL(location, current);
	} catch {
		return null;
	}

	if (next.protocol !== 'http:' && next.protocol !== 'https:') {
		return null;
	}

	if (!withinSite(siteHost, next.hostname)) {
		return null;
	}

	if (next.protocol === 'http:') {
		next.protocol = 'https:';
	}

	const target = next.toString();

	return target === current ? null : target;
}

/** Написания одного и того же свойства: разметку расставляли руками. */
const FULL_NAME = ['fullName', 'fullNameOrg', 'nameOrg'] as const;
const SHORT_NAME = ['shortName', 'shortNameOrg'] as const;
const REG_DATE = ['regDate', 'dateCreate', 'regdateorg'] as const;
const ADDRESS = ['address', 'addressStr', 'addressFact', 'addressPost'] as const;
const TELEPHONE = ['telephone', 'phone', 'telephoneOrg'] as const;
const EMAIL = ['email', 'emailOrg'] as const;
const FOUNDER = ['uchredName', 'nameUchred', 'founder', 'nameUchr', 'uchreditel'] as const;
const HEAD_NAME = ['fio', 'headName', 'rukName', 'fioRuk'] as const;
const HEAD_POST = ['post', 'headPost', 'rukPost'] as const;

/**
 * Разбор страницы `/sveden/common`.
 *
 * Отдельно от захода, потому что проверять здесь нужно именно разбор, а сеть в
 * этом не участвует: на вход — разметка, на выход — поля.
 *
 * Подразделом считается страница, на которой нашлось хоть одно размеченное
 * свойство. Страница без микроданных — это либо не тот адрес, либо сайт,
 * который правил не соблюдает; в обоих случаях брать оттуда нечего.
 */
export function readSvedenPage(url: string, html: string): SvedenReport {
	const data = readMicrodata(html);
	const propertyCount = [...data.properties.values()].reduce((sum, list) => sum + list.length, 0);

	return {
		url,
		found: propertyCount > 0,
		fields: {
			fullName: firstProperty(data, FULL_NAME),
			shortName: firstProperty(data, SHORT_NAME),
			regDate: firstProperty(data, REG_DATE),
			address: firstProperty(data, ADDRESS),
			telephone: firstProperty(data, TELEPHONE),
			email: firstProperty(data, EMAIL),
			founder: firstProperty(data, FOUNDER),
			headName: firstProperty(data, HEAD_NAME),
			headPost: firstProperty(data, HEAD_POST)
		},
		propertyCount,
		problem: propertyCount > 0 ? null : 'На странице нет микроразметки раздела'
	};
}

/**
 * Значение ячейки, если в ней есть что-то кроме отписки.
 *
 * Приказ требует заполнить каждую ячейку, и там, где сказать нечего, вузы
 * пишут «нет» или «отсутствует». Для кандидата в контакты это не ФИО и не
 * почта, а пустое место.
 */
function meaningful(value: string | null): string | null {
	if (value === null) {
		return null;
	}

	return /^(нет|отсутству[её]т|не предусмотрен[оа]?|не имеется|-|—|–)\.?$/i.test(value.trim())
		? null
		: value;
}

/** Строки таблицы органов управления и подразделений. */
const STRUCT_ROWS = ['structOrgUprav'] as const;

/**
 * Подразделения и их руководители из `/sveden/struct`.
 *
 * Строка без руководителя и без почты кандидатом в контакты не становится:
 * «Конференция работников» с прочерком вместо ФИО — это не человек, которому
 * можно написать. Повторы одной пары «подразделение — руководитель» (таблица
 * бывает продублирована скрытым блоком для проверяющих) сливаются.
 */
export function readStructPage(html: string): ContactCandidate[] {
	const contacts: ContactCandidate[] = [];
	const seen = new Set<string>();

	for (const row of readItems(html, STRUCT_ROWS)) {
		const unit = meaningful(property(row, 'name'));
		const name = meaningful(property(row, 'fio'));
		const email = meaningful(property(row, 'email'));

		if (unit === null || (name === null && email === null)) {
			continue;
		}

		const key = `${unit}\u0000${name ?? ''}`.toLocaleLowerCase('ru');

		if (seen.has(key)) {
			continue;
		}

		seen.add(key);
		contacts.push({
			unit,
			name,
			post: meaningful(property(row, 'post')),
			email,
			address: meaningful(property(row, 'addressStr'))
		});

		if (contacts.length >= CONTACT_CANDIDATES_MAX) {
			break;
		}
	}

	return contacts;
}

/**
 * Строки таблиц подраздела «Образование», где есть код и наименование
 * направления. Главная — `eduOp` (перечень программ); у сайтов, где её нет
 * или она пустая, те же коды лежат в таблицах аккредитации, численности и
 * приёма — из них перечень и собирается.
 */
const EDUCATION_ROWS = [
	'eduOp',
	'eduAccred',
	'eduChislen',
	'eduPriem',
	'eduPerevod',
	'eduAdOp'
] as const;

/** Код направления или специальности: `09.03.01`, `2.3.5` у научных специальностей. */
const PROGRAM_CODE = /\b(\d{1,2}\.\d{1,2}\.\d{1,2})\b/;

/**
 * Реализуемые программы из `/sveden/education`.
 *
 * Строка без кода направления отбрасывается: это шапка таблицы, продублированная
 * разметкой («Код», «Наименование»), или отписка «Отсутствует». Программа —
 * это код, уровень и направленность; формы обучения одной программы стоят в
 * разных строках и сливаются в список.
 */
export function readEducationPage(html: string): ProgramCandidate[] {
	const programs = new Map<string, ProgramCandidate>();

	for (const row of readItems(html, EDUCATION_ROWS)) {
		const code = PROGRAM_CODE.exec(property(row, 'eduCode') ?? '')?.[1];
		const name = meaningful(property(row, 'eduName'));

		if (code === undefined || name === null) {
			continue;
		}

		const level = meaningful(property(row, 'eduLevel'));
		const profile = meaningful(property(row, 'eduProf'));
		const key = [code, level ?? '', profile ?? ''].join('\u0000').toLocaleLowerCase('ru');
		const forms = propertyValues(row, 'eduForm')
			.map((form) => meaningful(form))
			.filter((form): form is string => form !== null);
		const known = programs.get(key);

		if (known !== undefined) {
			for (const form of forms) {
				if (!known.forms.includes(form) && known.forms.length < 10) {
					known.forms.push(form);
				}
			}

			continue;
		}

		if (programs.size >= PROGRAM_CANDIDATES_MAX) {
			continue;
		}

		programs.set(key, { code, name, level, profile, forms: forms.slice(0, 10) });
	}

	return [...programs.values()];
}

/**
 * Кодировка страницы по заголовку и по самой разметке.
 *
 * Сайты вузов до сих пор отдают `windows-1251`, и прочитанная как UTF-8
 * страница превращается в набор замен — вместе со всеми полями раздела.
 * Заголовок ответа главнее: он описывает то, что действительно приехало, а
 * `<meta charset>` внутри бывает унаследован от старой версии страницы.
 */
export function charsetOf(contentType: string | null, head: string): string {
	const fromHeader = /charset\s*=\s*"?([\w-]+)/i.exec(contentType ?? '')?.[1];

	if (fromHeader !== undefined) {
		return fromHeader.toLowerCase();
	}

	const fromMeta =
		/<meta[^>]+charset\s*=\s*["']?\s*([\w-]+)/i.exec(head)?.[1] ??
		/<meta[^>]+content\s*=\s*["'][^"']*charset\s*=\s*([\w-]+)/i.exec(head)?.[1];

	return (fromMeta ?? 'utf-8').toLowerCase();
}

function decodeBody(bytes: Uint8Array, contentType: string | null): string {
	// Для определения кодировки хватает начала страницы, а `latin1` читает байты
	// один к одному — имя кодировки в нём и написано.
	const head = new TextDecoder('latin1').decode(bytes.subarray(0, 4096));
	const charset = charsetOf(contentType, head);

	try {
		return new TextDecoder(charset).decode(bytes);
	} catch {
		// Кодировка, которой не знает среда: читаем как UTF-8 — это чаще всего
		// верно, а альтернатива здесь только одна — не читать вовсе.
		return new TextDecoder('utf-8').decode(bytes);
	}
}

/** Тело ответа с потолком: страница длиннее потолка обрывается, а не читается. */
async function readBody(response: Response): Promise<{ body: Uint8Array; truncated: boolean }> {
	const reader = response.body?.getReader();

	if (reader === undefined) {
		return { body: new Uint8Array(), truncated: false };
	}

	const chunks: Uint8Array[] = [];
	let size = 0;
	let truncated = false;

	for (;;) {
		const { done, value } = await reader.read();

		if (done) {
			break;
		}

		chunks.push(value);
		size += value.byteLength;

		if (size >= SVEDEN_BODY_MAX) {
			truncated = true;
			await reader.cancel();
			break;
		}
	}

	const body = new Uint8Array(size);
	let offset = 0;

	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}

	return { body, truncated };
}

type Fetched = { url: string; html: string; truncated: boolean };

/**
 * Один заход по адресу с ручной отработкой перенаправлений.
 *
 * `null` — по адресу нечего читать: не пустили, не ответили, ответили не
 * страницей, увели за пределы сайта. Разбирать причину незачем: адрес всё равно
 * проверяется следующий, а итог подраздела скажет, что он не открылся.
 */
async function fetchPage(target: string, siteHost: string): Promise<Fetched | null> {
	let url = target;

	for (let hop = 0; hop <= REDIRECT_MAX; hop += 1) {
		// Проверяется каждый переход, а не только первый: `Location` — это новый
		// адрес, и он ведёт куда угодно — на чужой сайт или внутрь сети.
		if (!withinSite(siteHost, new URL(url).hostname) || (await outboundTargetIssue(url)) !== null) {
			return null;
		}

		let response: Response;

		try {
			response = await fetch(url, {
				headers: { accept: 'text/html,application/xhtml+xml' },
				redirect: 'manual',
				signal: AbortSignal.timeout(SVEDEN_TIMEOUT_MS)
			});
		} catch {
			return null;
		}

		if (response.status >= 300 && response.status < 400) {
			const location = response.headers.get('location');

			await response.body?.cancel();

			if (location === null) {
				return null;
			}

			const next = redirectTarget(siteHost, url, location);

			if (next === null) {
				return null;
			}

			url = next;

			continue;
		}

		if (!response.ok) {
			await response.body?.cancel();

			return null;
		}

		const contentType = response.headers.get('content-type');

		if (contentType !== null && !/html|xml|text\/plain/i.test(contentType)) {
			await response.body?.cancel();

			return null;
		}

		const { body, truncated } = await readBody(response);

		return { url, html: decodeBody(body, contentType), truncated };
	}

	return null;
}

/**
 * Первый адрес подраздела, где разбор нашёл нужное.
 *
 * Не нашлось нигде — итог по первой открывшейся странице (она была, но пустая)
 * или по первому адресу (не открылось ничего): «подраздел не найден» — это
 * тоже сведение о вузе, и молчать о нём хуже, чем сказать.
 */
async function readSection<TValue>(
	origin: string,
	paths: readonly string[],
	parse: (page: Fetched) => TValue,
	isFound: (value: TValue) => boolean
): Promise<{ section: SvedenSection; value: TValue | null }> {
	const siteHost = new URL(origin).hostname;
	let first: { section: SvedenSection; value: TValue } | null = null;

	for (const path of paths) {
		const target = new URL(path, origin).toString();
		const page = await fetchPage(target, siteHost);

		if (page === null) {
			continue;
		}

		const value = parse(page);
		const found = isFound(value);
		const section: SvedenSection = {
			url: page.url,
			found,
			truncated: page.truncated,
			problem: found ? null : 'На странице нет нужной микроразметки'
		};

		if (found) {
			return { section, value };
		}

		first ??= { section, value };
	}

	return (
		first ?? {
			section: {
				url: new URL(paths[0], origin).toString(),
				found: false,
				truncated: false,
				problem: 'Страница не открылась или увела за пределы сайта организации'
			},
			value: null
		}
	);
}

/**
 * Раздел `/sveden` по сайту организации: три подраздела параллельно.
 *
 * `null` — адрес сайта не разбирается, идти некуда.
 */
export async function fetchSiteReport(
	website: string,
	fetchedAt: string
): Promise<SiteReport | null> {
	const origin = normalizeWebsite(website);

	if (origin === null) {
		return null;
	}

	const [common, struct, education] = await Promise.all([
		readSection(
			origin,
			SVEDEN_PATHS.common,
			(page) => readSvedenPage(page.url, page.html),
			(report) => report.found
		),
		readSection(origin, SVEDEN_PATHS.struct, (page) => readStructPage(page.html), notEmpty),
		readSection(origin, SVEDEN_PATHS.education, (page) => readEducationPage(page.html), notEmpty)
	]);

	return {
		website: origin,
		fetchedAt,
		common: common.value ?? emptyCommon(common.section.url, common.section.problem),
		struct: struct.section,
		education: education.section,
		contacts: struct.value ?? [],
		programs: education.value ?? []
	};
}

function notEmpty(list: readonly unknown[]): boolean {
	return list.length > 0;
}

function emptyCommon(url: string, problem: string | null): SvedenReport {
	return {
		url,
		found: false,
		fields: {
			fullName: null,
			shortName: null,
			regDate: null,
			address: null,
			telephone: null,
			email: null,
			founder: null,
			headName: null,
			headPost: null
		},
		propertyCount: 0,
		problem
	};
}
