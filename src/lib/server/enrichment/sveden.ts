/**
 * Раздел «Сведения об образовательной организации» на сайте вуза.
 *
 * Образовательная организация обязана держать такой раздел по адресу `/sveden`
 * и размечать его микроданными — так требуют Правила размещения информации
 * (постановление Правительства РФ № 1802) и приказ Рособрнадзора о структуре
 * раздела. Поэтому у вуза, в отличие от произвольной организации, реквизиты
 * можно прочитать с его же сайта, а не только из выписки.
 *
 * Читается раздел ради двух разных вещей. Во-первых, ради полей: наименование,
 * дата создания, адрес, телефон, почта, учредитель, руководитель. Во-вторых,
 * ради самого факта: размеченный `/sveden` — это доказательство, что домен
 * принадлежит именно образовательной организации, а не однофамильцу. Догадка о
 * сайте по домену почты из выписки без такой проверки стоила бы немного.
 *
 * Сайт называет человек или подсказывает почта из ЕГРЮЛ — то и другое ведёт
 * куда угодно, поэтому каждый заход проверяется правилом исходящих адресов
 * (`integrations/outbound.ts`), и перенаправления отрабатываются вручную: иначе
 * первый же `Location` увёл бы запрос внутрь сети развёртывания.
 */
import { outboundTargetIssue } from '../integrations/outbound';
import { firstProperty, readMicrodata } from './microdata';
import type { SvedenReport } from '$lib/contracts/enrichment';

/** Сколько ждём сайт вуза: это не наш сервис, и торопить его нечем. */
export const SVEDEN_TIMEOUT_MS = 12_000;

/** Потолок страницы. Раздел — это текст; всё, что больше, читать незачем. */
export const SVEDEN_BODY_MAX = 4 * 1024 * 1024;

/** Сколько перенаправлений отрабатываем: `http` → `https` → канонический путь. */
const REDIRECT_MAX = 3;

/**
 * Адреса, по которым ищется раздел, в порядке проверки.
 *
 * Приказ задаёт путь `/sveden`, но подстраницы у сайтов разные: у одних
 * микроразметка лежит на `/sveden/common`, у других — на самом `/sveden`, у
 * третьих путь кончается расширением, потому что страницы статические. Порядок
 * от точного к общему: первый адрес с разметкой и становится ответом.
 */
export function svedenCandidates(website: string): string[] {
	const base = new URL(website);
	const origin = base.origin;

	return ['/sveden/common', '/sveden/', '/sveden/common.html', '/sveden/common/'].map((path) =>
		new URL(path, origin).toString()
	);
}

/**
 * Сайт по почтовому адресу из выписки.
 *
 * В ЕГРЮЛ сайта нет — Dadata его и не отдаёт, — а почта есть, и у вуза она
 * почти всегда на собственном домене (`rector@spbstu.ru`). Это догадка, и
 * подтверждает её не она сама, а найденный по этому домену раздел `/sveden`.
 *
 * Общедоступная почта отбрасывается: `mail.ru` — это не сайт вуза, а адрес, по
 * которому мы отправили бы запрос к почтовому провайдеру.
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
		// справочника, а станет адресом, по которому сервер пойдёт сам.
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

/** Написания одного и того же свойства: разметку расставляли руками. */
const FULL_NAME = ['fullName', 'fullNameOrg', 'nameOrg'] as const;
const SHORT_NAME = ['shortName', 'shortNameOrg'] as const;
const REG_DATE = ['regDate', 'dateCreate', 'regdateorg'] as const;
const ADDRESS = ['address', 'addressStr', 'addressFact', 'addressPost'] as const;
const TELEPHONE = ['telephone', 'phone', 'telephoneOrg'] as const;
const EMAIL = ['email', 'emailOrg'] as const;
const FOUNDER = ['uchredName', 'founder', 'nameUchr', 'uchreditel'] as const;
const HEAD_NAME = ['fio', 'headName', 'rukName', 'fioRuk'] as const;
const HEAD_POST = ['post', 'headPost', 'rukPost'] as const;

/**
 * Разбор страницы раздела.
 *
 * Отдельно от захода, потому что проверять здесь нужно именно разбор, а сеть в
 * этом не участвует: на вход — разметка, на выход — поля.
 *
 * Разделом считается страница, на которой нашлось хоть одно размеченное
 * свойство. Страница без микроданных — это либо не тот адрес, либо сайт,
 * который правил не соблюдает; в обоих случаях брать оттуда нечего, и
 * подтверждением принадлежности домена она тоже не служит.
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
async function readBody(response: Response): Promise<Uint8Array> {
	const reader = response.body?.getReader();

	if (reader === undefined) {
		return new Uint8Array();
	}

	const chunks: Uint8Array[] = [];
	let size = 0;

	for (;;) {
		const { done, value } = await reader.read();

		if (done) {
			break;
		}

		chunks.push(value);
		size += value.byteLength;

		if (size >= SVEDEN_BODY_MAX) {
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

	return body;
}

type Fetched = { url: string; html: string };

/**
 * Один заход по адресу с ручной отработкой перенаправлений.
 *
 * `null` — по адресу нечего читать: не пустили, не ответили, ответили не
 * страницей. Разбирать причину незачем: адрес всё равно проверяется следующий.
 */
async function fetchPage(target: string): Promise<Fetched | null> {
	let url = target;

	for (let hop = 0; hop <= REDIRECT_MAX; hop += 1) {
		// Проверяется каждый переход, а не только первый: `Location` — это новый
		// адрес, и он ведёт куда угодно, в том числе внутрь сети развёртывания.
		if ((await outboundTargetIssue(url)) !== null) {
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

			try {
				url = new URL(location, url).toString();
			} catch {
				return null;
			}

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

		return { url, html: decodeBody(await readBody(response), contentType) };
	}

	return null;
}

/**
 * Раздел `/sveden` по адресу сайта.
 *
 * Адреса перебираются по очереди, и побеждает первый, на котором нашлась
 * микроразметка. Не нашлось нигде — возвращается отчёт по первому адресу с
 * объяснением: «раздел не найден» — это тоже сведение о вузе, и молчать о нём
 * хуже, чем сказать.
 */
export async function fetchSveden(website: string): Promise<SvedenReport> {
	const origin = normalizeWebsite(website);

	if (origin === null) {
		return emptyReport(website, 'Адрес сайта не разбирается');
	}

	const candidates = svedenCandidates(origin);
	let firstPage: SvedenReport | null = null;

	for (const candidate of candidates) {
		const page = await fetchPage(candidate);

		if (page === null) {
			continue;
		}

		const report = readSvedenPage(page.url, page.html);

		if (report.found) {
			return report;
		}

		firstPage ??= report;
	}

	return (
		firstPage ??
		emptyReport(candidates[0], 'Раздел «Сведения об образовательной организации» не открылся')
	);
}

function emptyReport(url: string, problem: string): SvedenReport {
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
