/**
 * Раздел «Сведения об образовательной организации» на сайте вуза.
 *
 * Образовательная организация обязана держать такой раздел по адресу `/sveden`
 * и размечать его микроданными — так требуют Правила размещения информации
 * (постановление Правительства РФ № 1802) и приказ Рособрнадзора о структуре
 * раздела. Поэтому у вуза, в отличие от произвольной организации, реквизиты,
 * подразделения и программы можно прочитать с его же сайта.
 *
 * Читаются четыре подраздела:
 * - `/sveden/common` — наименование, дата создания, адрес, телефон, почта,
 *   учредитель, руководитель. Сам факт размеченной страницы — ещё и
 *   доказательство, что домен принадлежит образовательной организации;
 * - `/sveden/struct` — подразделения (кандидаты в площадки, и с руководителем,
 *   и без) и их руководители (кандидаты в контакты);
 * - `/sveden/managers` — «Руководство»: ректор, проректоры, руководители
 *   филиалов — тоже кандидаты в контакты, с подписью «Руководство»;
 * - `/sveden/education/eduop` (или сам `/sveden/education`, если перечень лежит
 *   прямо на нём) — реализуемые программы с кодами направлений.
 *
 * Ходим только по сайту из карточки организации и только внутри его домена:
 * перенаправление на чужой домен — отказ, а не переход, а переход на `http`
 * внутри сайта повышается до `https` (`redirectTarget`). Каждый заход, включая
 * каждое перенаправление, ещё и проверяется правилом исходящих адресов
 * (`integrations/outbound.ts`) в строгом виде — только публичные адреса, без
 * списка разрешённых узлов: иначе первый же `Location` увёл бы запрос внутрь
 * сети развёртывания или к CMS заказчика.
 */
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import { publicTargetIssue } from '../integrations/outbound';
import {
	firstProperty,
	property,
	propertyValues,
	readItems,
	readMicrodata,
	type Microdata
} from './microdata';
import {
	CONTACT_CANDIDATES_MAX,
	MANAGEMENT_UNIT,
	normalizeUnitName,
	PROGRAM_CANDIDATES_MAX,
	UNIT_CANDIDATES_MAX,
	type ContactCandidate,
	type ProgramCandidate,
	type SiteReport,
	type SvedenReport,
	type SvedenSection,
	type UnitCandidate
} from '$lib/contracts/enrichment';

/**
 * Сколько ждём одну страницу вместе с телом: это не наш сервис, и торопить его
 * нечем. Сайты вузов бывают медленными — БУКЭП отдаёт первый байт через 5–6 с,
 * а страницу дочитывает ещё дольше, и 10 с на неё не хватало.
 */
export const SVEDEN_TIMEOUT_MS = 25_000;

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
 *
 * «Руководство» до 2023 года жило вместе с педагогическим составом на
 * `/sveden/employees` и размечено там теми же `rucovodstvo*`; отдельный
 * `/sveden/managers` появился позже и спрашивается первым.
 */
// У каждого пути — двойник со слешем в конце: сайты на «Битриксе» отдают
// `/sveden/common` как 404 без перенаправления, а раздел живёт на
// `/sveden/common/` (Институт бизнеса и дизайна, `ibisedu.ru`). Двойник
// запрашивается, только если путь без слеша не дал разметки.
export const SVEDEN_PATHS = {
	common: ['/sveden/common', '/sveden/common/', '/sveden/', '/sveden/common.html'],
	struct: ['/sveden/struct', '/sveden/struct/'],
	managers: ['/sveden/managers', '/sveden/managers/', '/sveden/employees', '/sveden/employees/'],
	education: [
		'/sveden/education/eduop',
		'/sveden/education/eduop/',
		'/sveden/education',
		'/sveden/education/'
	]
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

	const target = secureUrl(next.toString());

	return target === current ? null : target;
}

/** Тот же сайт с `www.` или без него: `https://www.bsuedu.ru` ↔ `https://bsuedu.ru`. */
export function wwwTwin(origin: string): string {
	const url = new URL(origin);

	url.hostname = url.hostname.startsWith('www.') ? url.hostname.slice(4) : `www.${url.hostname}`;

	return url.origin;
}

/** Тот же адрес по `https`: по `http` наружу сервер не ходит. */
export function secureUrl(raw: string): string {
	const url = new URL(raw);

	if (url.protocol === 'http:') {
		url.protocol = 'https:';
	}

	return url.toString();
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
 * Значение без подписи поля.
 *
 * Приказ размечает сведение целиком, и вузы кладут в размеченный элемент и
 * подпись: `<p itemprop="fullName"><b>Полное наименование</b>: …</p>`. Подписью
 * считается начало до первого двоеточия, если это слова без цифр и кавычек:
 * у адреса «Россия, 400005, г. Волгоград» и у часов «8:30» двоеточие подписи
 * не отделяет. Подпись без значения — это пустое поле, а не значение.
 */
const CAPTION = /^\p{L}[\p{L}\s().,/-]{1,119}?\s*:\s*/u;

export function withoutCaption(value: string | null): string | null {
	if (value === null) {
		return null;
	}

	const caption = CAPTION.exec(value);

	if (caption === null) {
		return value;
	}

	const rest = value.slice(caption[0].length).trim();

	return rest === '' ? null : rest;
}

function withoutTrailingDot(value: string | null): string | null {
	return value === null ? null : value.replace(/\s*\.$/, '');
}

const EMAIL_IN_TEXT = /[\p{L}\d._%+-]+@[\p{L}\d-]+(?:\.[\p{L}\d-]+)+/gu;

/** Адреса почты в свободном тексте: ячейку заполняют как придётся. */
function emailsIn(value: string): string[] {
	return [...value.matchAll(EMAIL_IN_TEXT)].map((match) => match[0]);
}

/**
 * Телефоны из ячейки: всё, что осталось без адресов почты, куски через `;` или
 * `,` с хотя бы пятью цифрами. Вуз пишет в ячейку «Электронная почта» и номер —
 * «(8442) 23-00-76; rector@vstu.ru», — и номер нужен карточке человека
 * отдельным полем.
 */
function phonesIn(value: string): string[] {
	return value
		.replace(EMAIL_IN_TEXT, ' ')
		.split(/[;,]/)
		.map((part) =>
			part
				.replace(/^\s*(тел(ефон)?|т)\.?\s*:?\s*/iu, '')
				.replace(/[.\s]+$/, '')
				.trim()
		)
		.filter((part) => (part.match(/\d/g)?.length ?? 0) >= 5);
}

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
	const field = (names: readonly string[]) => withoutCaption(firstProperty(data, names));
	const email = field(EMAIL);

	return {
		url,
		found: propertyCount > 0,
		fields: {
			fullName: field(FULL_NAME),
			shortName: field(SHORT_NAME),
			regDate: field(REG_DATE),
			address: withoutTrailingDot(field(ADDRESS)),
			telephone: withoutTrailingDot(field(TELEPHONE)),
			email: email === null ? null : (emailsIn(email)[0] ?? email),
			founder: withoutTrailingDot(field(FOUNDER)),
			headName: field(HEAD_NAME),
			headPost: field(HEAD_POST)
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

	const trimmed = value.trim();

	// Ячейка без единой буквы и цифры — «--, --» — та же отписка.
	return /^(нет|отсутству[её]т|не предусмотрен[оа]?|не имеется)\.?$/i.test(trimmed) ||
		!/[\p{L}\d]/u.test(trimmed)
		? null
		: trimmed;
}

/**
 * Название подразделения без ссылки на его положение.
 *
 * Ссылку `divisionClauseDocLink` вузы кладут внутрь ячейки `name`, и текст
 * ссылки — «Положение от 03.12.2019» — прилипает к названию. Он вырезается,
 * как и маркеры вложенности, которыми таблицу рисуют деревом («• Архив»).
 */
function unitName(value: string | null, documents: readonly string[]): string | null {
	if (value === null) {
		return null;
	}

	let name = value;

	for (const document of documents) {
		name = name.split(document).join(' ');
	}

	return meaningful(
		name
			.replace(/\s+Положени[ея]\s+(от|о)\s.*$/iu, '')
			.replace(/^[^\p{L}\d«"]+/u, '')
			.replace(/\s+/g, ' ')
	);
}

/** Строки таблицы органов управления и подразделений. */
const STRUCT_ROWS = ['structOrgUprav'] as const;

type RowData = ReturnType<typeof readMicrodata>;

/**
 * Почта и телефон строки таблицы: вузы пишут их в одну ячейку как придётся,
 * поэтому обе ячейки читаются вместе и раскладываются по видам.
 */
function reachOf(row: RowData): { email: string | null; phone: string | null } {
	const reach = [property(row, 'email'), property(row, 'telephone')]
		.map((value) => meaningful(value))
		.filter((value) => value !== null)
		.join('; ');
	const phone = phonesIn(reach)[0] ?? null;
	// Ячейка, в которой не нашлось ни адреса, ни номера («priem[at]vuz.ru»),
	// остаётся почтой как есть: карточка человека покажет её на проверку.
	const email = emailsIn(reach)[0] ?? (phone === null ? meaningful(property(row, 'email')) : null);

	return { email, phone };
}

/**
 * Адрес страницы подразделения из ячейки `site`: первая ссылка `http(s)`.
 * Ячейку заполняли руками — «нет», «www.vuz.ru/kaf», две ссылки подряд, — а
 * на экран уходит только то, что точно адрес: остальное — не значение.
 */
function unitSite(value: string | null): string | null {
	const found = /https?:\/\/[^\s<>"']+/i.exec(value ?? '')?.[0];

	if (found === undefined) {
		return null;
	}

	try {
		return new URL(found).toString().slice(0, 1000);
	} catch {
		return null;
	}
}

/**
 * Подразделения из `/sveden/struct` — кандидаты в площадки организации.
 *
 * В отличие от кандидатов в контакты, строка без ФИО руководителя здесь
 * остаётся: карточке дела нужна кафедра, с которой идёт работа, даже если
 * сайт не назвал её заведующего. Отбрасываются строки руководства
 * («Ректор», «Проректор по АХР»): это должность, а не подразделение, — и
 * повторы названия (сверка — `normalizeUnitName`, как и со справочником).
 */
export function readStructUnits(html: string): UnitCandidate[] {
	const units: UnitCandidate[] = [];
	const seen = new Set<string>();

	for (const row of readItems(html, STRUCT_ROWS)) {
		const name = unitName(property(row, 'name'), propertyValues(row, 'divisionClauseDocLink'));

		if (name === null || POST_AS_UNIT.test(name)) {
			continue;
		}

		const key = normalizeUnitName(name);

		if (key === '' || seen.has(key) || units.length >= UNIT_CANDIDATES_MAX) {
			continue;
		}

		seen.add(key);
		units.push({
			name,
			address: meaningful(property(row, 'addressStr')),
			...reachOf(row),
			site: unitSite(property(row, 'site'))
		});
	}

	return units;
}

/**
 * Строки подраздела «Руководство»: руководитель, его заместители и
 * руководители филиалов — у каждой свой `itemprop` по приказу Рособрнадзора.
 */
const MANAGER_ROWS = ['rucovodstvo', 'rucovodstvoZam', 'rucovodstvoFil'] as const;

/**
 * Люди из «Руководства» — кандидаты в контакты с подписью `MANAGEMENT_UNIT`.
 *
 * Строка с несколькими ФИО — это не строка, а контейнер: вузы размечают
 * `rucovodstvo` и всю таблицу целиком, и тогда внутри лежат ячейки всех
 * заместителей; её люди придут своими строками. У руководителя филиала
 * должность дополняется названием филиала — иначе «директор» ничего не
 * говорит. Повторы сливаются по ФИО, как и в «Структуре».
 */
export function readManagersPage(html: string): ContactCandidate[] {
	const contacts: ContactCandidate[] = [];
	const byName = new Map<string, ContactCandidate>();

	const rows = readItems(html, MANAGER_ROWS);

	for (const row of rows.length > 0 && rows.some(hasManagerName) ? rows : looseManagerRows(html)) {
		const cells = propertyValues(row, 'fio');
		const cell = cells.length === 1 ? meaningful(cells[0]) : null;

		if (cell === null) {
			continue;
		}

		const split = NAME_WITH_POST.exec(cell);
		const name = split?.[1] ?? cell;
		const branch = meaningful(property(row, 'nameFil'));
		const ownPost = withPost(split?.[2] ?? null, meaningful(property(row, 'post')));
		const post = branch === null ? ownPost : `${ownPost ?? 'руководитель'} (${branch})`;
		const { email, phone } = reachOf(row);
		const key = name.replace(/\s+/g, ' ').toLocaleLowerCase('ru');
		const known = byName.get(key);

		if (known !== undefined) {
			known.post = withPost(known.post, post);
			known.email ??= email;
			known.phone ??= phone;
			continue;
		}

		if (contacts.length >= CONTACT_CANDIDATES_MAX) {
			continue;
		}

		const candidate: ContactCandidate = {
			unit: MANAGEMENT_UNIT,
			name,
			post,
			email,
			phone,
			address: null
		};

		byName.set(key, candidate);
		contacts.push(candidate);
	}

	return contacts;
}

function hasManagerName(row: Microdata): boolean {
	return propertyValues(row, 'fio').length > 0;
}

/**
 * Строки «Руководства», когда контейнер размечен мимо: у ИБИС `itemprop=
 * "rucovodstvo"` стоит на пустом `<br>`, а ФИО, должности, телефоны и почта
 * лежат рядом, вне него. Тогда поля страницы собираются по порядку — n-е ФИО с
 * n-й должностью. Телефон и почта берутся, только если их столько же, сколько
 * ФИО: иначе порядок уже ничего не говорит, и чужой номер хуже пустого.
 */
function looseManagerRows(html: string): Microdata[] {
	const page = readMicrodata(html);
	const names = propertyValues(page, 'fio');
	const posts = propertyValues(page, 'post');

	if (names.length === 0 || posts.length !== names.length) {
		return [];
	}

	const aligned = (name: string): string[] | null => {
		const values = propertyValues(page, name);

		return values.length === names.length ? values : null;
	};
	const phones = aligned('telephone');
	const emails = aligned('email');

	return names.map((name, index) => {
		const properties = new Map<string, string[]>([
			['fio', [name]],
			['post', [posts[index]]]
		]);

		if (phones !== null) {
			properties.set('telephone', [phones[index]]);
		}

		if (emails !== null) {
			properties.set('email', [emails[index]]);
		}

		return { properties, types: new Set<string>() };
	});
}

/**
 * Один список кандидатов из «Руководства» и «Структуры».
 *
 * «Руководство» идёт первым: ректор и проректоры — те, кого ищут чаще всего, и
 * потолок списка не должен отрезать их ради сотой кафедры. Человек из обоих
 * подразделов остаётся одним кандидатом — из «Руководства», — а недостающие
 * почта и телефон берутся из его строки «Структуры».
 */
export function mergeContactCandidates(
	managers: readonly ContactCandidate[],
	struct: readonly ContactCandidate[]
): ContactCandidate[] {
	const contacts = managers.map((candidate) => ({ ...candidate }));
	const byName = new Map(
		contacts.map((candidate) => [
			candidate.name.replace(/\s+/g, ' ').toLocaleLowerCase('ru'),
			candidate
		])
	);

	for (const candidate of struct) {
		const known = byName.get(candidate.name.replace(/\s+/g, ' ').toLocaleLowerCase('ru'));

		if (known !== undefined) {
			known.email ??= candidate.email;
			known.phone ??= candidate.phone;
			continue;
		}

		if (contacts.length < CONTACT_CANDIDATES_MAX) {
			contacts.push({ ...candidate });
		}
	}

	return contacts;
}

/**
 * ФИО с должностью в одной ячейке: «Рудской Андрей Иванович, председатель
 * Ученого совета, ректор». ФИО — начало до первой запятой, если это два-три
 * слова с заглавной; остальное — должность.
 */
const NAME_WITH_POST = /^(\p{Lu}[\p{Ll}-]+(?:\s+\p{Lu}[\p{Ll}-]+){1,2})\s*,\s*(.+)$/u;

/**
 * Должность вместо подразделения: вузы заводят руководство отдельными
 * строками таблицы, и в ячейке подразделения стоит «Ректор СПбПУ» или
 * «Проректор по АХР».
 */
const POST_AS_UNIT =
	/^(?:(?:первый|исполнительный|главный)\s+)?(?:и\.?\s?о\.?\s+)?(?:ректор|проректор|президент|вице-президент|помощник\s+ректора|советник\s+ректора|заместитель|бухгалтер|инженер|директор|председатель)(?=[\s,.]|$)/iu;

/** Добавляет должность к перечню, если её там ещё нет — хотя бы частью другой. */
function withPost(posts: string | null, post: string | null): string | null {
	if (post === null) {
		return posts;
	}

	if (posts === null) {
		return post;
	}

	return posts.toLocaleLowerCase('ru').includes(post.toLocaleLowerCase('ru'))
		? posts
		: `${posts}; ${post}`.slice(0, 1000);
}

/**
 * Подразделения и их руководители из `/sveden/struct`.
 *
 * Строка без ФИО руководителя кандидатом в контакты не становится, даже с
 * почтой: контакт справочника — человек, и «Попечительский совет» с общим
 * ящиком завести им нельзя, а в списке кандидатов он только сбивает счёт.
 *
 * Один человек — один кандидат: ректор стоит и строкой «Ученый совет», и
 * строкой «Ректор», директор двух подразделений — двумя строками. Повторы
 * сливаются по ФИО, должности из остальных строк дописываются к первой — с
 * подразделением, если оно своё. Должность из ячейки ФИО и из ячейки
 * подразделения («Проректор по АХР») переезжает в должность.
 */
export function readStructPage(html: string): ContactCandidate[] {
	const contacts: ContactCandidate[] = [];
	const byName = new Map<string, ContactCandidate>();

	for (const row of readItems(html, STRUCT_ROWS)) {
		const unit = unitName(property(row, 'name'), propertyValues(row, 'divisionClauseDocLink'));
		const cell = meaningful(property(row, 'fio'));
		const { email, phone } = reachOf(row);

		if (unit === null || cell === null) {
			continue;
		}

		const split = NAME_WITH_POST.exec(cell);
		const name = split?.[1] ?? cell;
		const unitIsPost = POST_AS_UNIT.test(unit);
		const post = withPost(
			withPost(split?.[2] ?? null, meaningful(property(row, 'post'))),
			unitIsPost ? unit : null
		);
		const key = name.replace(/\s+/g, ' ').toLocaleLowerCase('ru');
		const known = byName.get(key);

		if (known !== undefined) {
			const ownUnit =
				!unitIsPost && unit.toLocaleLowerCase('ru') !== known.unit.toLocaleLowerCase('ru');

			known.post = withPost(known.post, ownUnit ? `${post ?? 'руководитель'} (${unit})` : post);
			known.email ??= email;
			known.phone ??= phone;
			continue;
		}

		if (contacts.length >= CONTACT_CANDIDATES_MAX) {
			continue;
		}

		const candidate: ContactCandidate = {
			unit,
			name,
			post,
			email,
			phone,
			address: meaningful(property(row, 'addressStr'))
		};

		byName.set(key, candidate);
		contacts.push(candidate);
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

type Fetched = { url: string; html: string; truncated: boolean; insecure: boolean };

/**
 * Отказ проверки сертификата, а не сети: сайт ответил бы, но его сертификат
 * истёк, самоподписан, выписан на другое имя или выдан центром, которого среда
 * не знает (центр Минцифры — у многих вузов).
 */
const CERTIFICATE_ERRORS = new Set([
	'CERT_HAS_EXPIRED',
	'CERT_NOT_YET_VALID',
	'DEPTH_ZERO_SELF_SIGNED_CERT',
	'SELF_SIGNED_CERT_IN_CHAIN',
	'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
	'UNABLE_TO_GET_ISSUER_CERT',
	'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
	'ERR_TLS_CERT_ALTNAME_INVALID'
]);

export function isCertificateError(error: unknown): boolean {
	const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
	const code = cause?.code ?? (error as { code?: unknown } | null)?.code;

	return typeof code === 'string' && CERTIFICATE_ERRORS.has(code);
}

/** Статусы, у ответа с которыми тела быть не может: `Response` иначе бросит. */
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

/**
 * Тот же заход без проверки сертификата — только для чтения раздела `/sveden`
 * после отказа проверки (`isCertificateError`).
 *
 * Упрощение для хакатона: раздел — открытые сведения, мы их только читаем и
 * ничего сайту не отправляем, поэтому истёкший сертификат вуза не повод
 * оставлять карточку пустой. Цена — страницу могли подменить по дороге; отчёт
 * помечается (`insecureTls`), и паспорт об этом говорит. Правило исходящих
 * адресов проверено до захода, как и для обычного запроса. Интеграции (CMS,
 * система обучения, вебхуки) так не ходят никогда. В рабочей эксплуатации
 * центр Минцифры кладётся в доверенные среды (`NODE_EXTRA_CA_CERTS`), и
 * запасной заход остаётся для по-настоящему сломанных сертификатов.
 */
function fetchWithoutCertificateCheck(url: string): Promise<Response> {
	return new Promise((resolve, reject) => {
		const request = httpsRequest(
			url,
			{
				method: 'GET',
				headers: { accept: 'text/html,application/xhtml+xml', 'accept-encoding': 'identity' },
				rejectUnauthorized: false,
				signal: AbortSignal.timeout(SVEDEN_TIMEOUT_MS)
			},
			(incoming) => {
				const headers = new Headers();

				for (const [name, value] of Object.entries(incoming.headers)) {
					if (value !== undefined) {
						headers.set(name, Array.isArray(value) ? value.join(', ') : value);
					}
				}

				const status = incoming.statusCode ?? 502;

				if (NULL_BODY_STATUSES.has(status) || status < 200 || status > 599) {
					incoming.resume();
					resolve(
						new Response(null, { status: status < 200 || status > 599 ? 502 : status, headers })
					);

					return;
				}

				resolve(
					new Response(Readable.toWeb(incoming) as ReadableStream<Uint8Array>, { status, headers })
				);
			}
		);

		request.on('error', reject);
		request.end();
	});
}

/**
 * Один заход по адресу с ручной отработкой перенаправлений.
 *
 * `null` — по адресу нечего читать: не пустили, не ответили, ответили не
 * страницей, увели за пределы сайта. Разбирать причину незачем: адрес всё равно
 * проверяется следующий, а итог подраздела скажет, что он не открылся.
 */
async function fetchPage(target: string, siteHost: string): Promise<Fetched | null> {
	// Первый заход повышается до `https` так же, как переход (`redirectTarget`):
	// сайт в карточке часто записан с `http://` — так его отдаёт и мониторинг
	// вузов, — а по `http` наружу сервер не ходит, и раздел отказал бы, не
	// начавшись. КФУ: `http://www.kpfu.ru/sveden/common` читается только как
	// `https://…` → `http://sveden.kpfu.ru/common/` → `https://sveden.kpfu.ru/common/`.
	let url = secureUrl(target);
	let insecure = false;

	for (let hop = 0; hop <= REDIRECT_MAX; hop += 1) {
		// Проверяется каждый переход, а не только первый: `Location` — это новый
		// адрес, и он ведёт куда угодно — на чужой сайт или внутрь сети.
		if (!withinSite(siteHost, new URL(url).hostname) || (await publicTargetIssue(url)) !== null) {
			return null;
		}

		let response: Response;

		try {
			response = await fetch(url, {
				headers: { accept: 'text/html,application/xhtml+xml' },
				redirect: 'manual',
				signal: AbortSignal.timeout(SVEDEN_TIMEOUT_MS)
			});
		} catch (error) {
			if (!isCertificateError(error)) {
				return null;
			}

			try {
				response = await fetchWithoutCertificateCheck(url);
				insecure = true;
			} catch {
				return null;
			}
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

		// Таймаут запроса действует и на чтение тела: медленный сайт отдаёт
		// заголовки вовремя, а страницу — уже за пределом, и ошибка прилетает
		// отсюда, а не из `fetch`. Раздел тогда не прочитан, а не весь отчёт
		// сорван исключением.
		try {
			const { body, truncated } = await readBody(response);

			return { url, html: decodeBody(body, contentType), truncated, insecure };
		} catch {
			return null;
		}
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
): Promise<{ section: SvedenSection; value: TValue | null; insecure: boolean }> {
	const siteHost = new URL(origin).hostname;
	let first: { section: SvedenSection; value: TValue } | null = null;
	let insecure = false;
	let opened = false;

	// Двойник с `www` или без него — только если с исходного адреса не открылась
	// ни одна страница: у БелГУ сертификат выписан на `bsuedu.ru`, а
	// `www.bsuedu.ru` из мониторинга не отвечает вовсе. Двойник — тот же сайт
	// организации (`withinSite`), и правило исходящих адресов проверяет его так же.
	const attempts = [origin, wwwTwin(origin)].flatMap((base) =>
		paths.map((path) => ({ base, target: new URL(path, base).toString() }))
	);

	for (const { base, target } of attempts) {
		if (base !== origin && opened) {
			break;
		}

		const page = await fetchPage(target, siteHost);

		if (page === null) {
			continue;
		}

		opened = true;

		insecure ||= page.insecure;
		const value = parse(page);
		const found = isFound(value);
		const section: SvedenSection = {
			url: page.url,
			found,
			truncated: page.truncated,
			problem: found ? null : 'На странице нет нужной микроразметки'
		};

		if (found) {
			return { section, value, insecure };
		}

		first ??= { section, value };
	}

	return {
		...(first ?? {
			section: {
				url: new URL(paths[0], origin).toString(),
				found: false,
				truncated: false,
				problem: 'Страница не открылась или увела за пределы сайта организации'
			},
			value: null
		}),
		insecure
	};
}

/**
 * Раздел `/sveden` по сайту организации: четыре подраздела параллельно.
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

	const [common, struct, managers, education] = await Promise.all([
		readSection(
			origin,
			SVEDEN_PATHS.common,
			(page) => readSvedenPage(page.url, page.html),
			(report) => report.found
		),
		// «Структура» найдена, если на ней есть хоть одно подразделение: кафедры
		// без названных заведующих — тоже сведения для карточки дела.
		readSection(
			origin,
			SVEDEN_PATHS.struct,
			(page) => ({ contacts: readStructPage(page.html), units: readStructUnits(page.html) }),
			(value) => value.contacts.length > 0 || value.units.length > 0
		),
		readSection(origin, SVEDEN_PATHS.managers, (page) => readManagersPage(page.html), notEmpty),
		readSection(origin, SVEDEN_PATHS.education, (page) => readEducationPage(page.html), notEmpty)
	]);

	return {
		website: origin,
		fetchedAt,
		common: common.value ?? emptyCommon(common.section.url, common.section.problem),
		struct: struct.section,
		managers: managers.section,
		education: education.section,
		contacts: mergeContactCandidates(managers.value ?? [], struct.value?.contacts ?? []),
		units: struct.value?.units ?? [],
		programs: education.value ?? [],
		insecureTls: [common, struct, managers, education].some((section) => section.insecure)
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
