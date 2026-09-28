/**
 * Клиент подсказок Dadata по юридическим лицам.
 *
 * Два обращения к одному сервису: `suggest/party` ищет по названию и отдаёт
 * десяток похожих, `findById/party` находит по ИНН. Оба — `POST` с телом JSON и
 * ключом в заголовке `Authorization: Token`; ключ в строке запроса Dadata тоже
 * принимает, но строка запроса попадает в журнал доступа, в `Referer` и в
 * историю посредника, а тело — нет.
 *
 * Адрес сервиса и ключ — настройка «Интеграции → Dadata»
 * (`getDadataConnection`): по умолчанию облачный `suggestions.dadata.ru`, для
 * коробочной версии в сети заказчика — её внутренний адрес. Сюда уходит ключ,
 * поэтому свой адрес действует только вместе с ключом, введённым там же, а
 * ключ окружения уходит только в облако. Свой адрес перед каждым заходом
 * проверяется правилом исходящих адресов (`integrations/outbound.ts`): имя,
 * сохранённое годным, к моменту запроса может вести куда угодно.
 *
 * Ответ Dadata описан ровно в тех полях, которыми пользуется черновик карточки:
 * у поставщика их несколько десятков, и объявить все значило бы утверждать, что
 * мы на них полагаемся.
 */
import type { LegalEntity, LegalStatus, LookupQueryKind } from '$lib/contracts/enrichment';
import { outboundTargetIssue } from '../integrations/outbound';
import { getDadataConnection, hasDadataKey } from '../integrations/settings';

/** Пути API подсказок: одинаковы у облачного сервиса и у коробочной версии. */
const SUGGEST_PATH = '/suggestions/api/4_1/rs/suggest/party';
const FIND_BY_ID_PATH = '/suggestions/api/4_1/rs/findById/party';

/** Сколько ждём подсказки: сервис отвечает за десятки миллисекунд. */
export const DADATA_TIMEOUT_MS = 10_000;

/** Сколько кандидатов показываем по названию: больше десятка не перебирают. */
export const SUGGEST_COUNT = 10;

/**
 * Единственный текст отказа для сотрудника.
 *
 * Один на все случаи: различать на экране «ключ не тот», «лимит исчерпан» и
 * «сервис недоступен» незачем — поправить сотрудник всё равно ничего не может,
 * а причина остаётся в логе сервера тому, кто держит стенд.
 */
export const DADATA_REFUSAL =
	'Справочник организаций не ответил. Попробуйте позже или заполните реквизиты вручную';

/**
 * Отдельный текст для стенда без ключа поставщика: сотруднику — что делать
 * сейчас, без имён переменных окружения; настройку администратор видит на
 * странице «Интеграции» и в диагностике.
 */
export const DADATA_NOT_CONFIGURED =
	'Поиск по ЕГРЮЛ на этом стенде не подключён: реквизиты введите вручную или загрузите снимок паспорта';

/**
 * Отказ со стороны справочника. Сообщение сотруднику одно на все случаи, а
 * машинный код объясняет причину тому, кто читает лог сервера.
 */
export class DadataError extends Error {
	readonly code: string;
	readonly status: number | null;

	constructor(code: string, status: number | null = null, message = DADATA_REFUSAL) {
		super(message);
		this.name = 'DadataError';
		this.code = code;
		this.status = status;
	}
}

/** Задан ли ключ — в интерфейсе или в окружении: без него раздел честно говорит, что поиск не настроен. */
export async function isDadataConfigured(): Promise<boolean> {
	return hasDadataKey();
}

/** Сырая подсказка Dadata — только поля, которыми пользуется черновик. */
type PartySuggestion = {
	value?: unknown;
	data?: {
		inn?: unknown;
		kpp?: unknown;
		ogrn?: unknown;
		branch_type?: unknown;
		okved?: unknown;
		emails?: unknown;
		name?: { full_with_opf?: unknown; short_with_opf?: unknown; short?: unknown; full?: unknown };
		address?: { value?: unknown; data?: { region_with_type?: unknown; region?: unknown } };
		state?: { status?: unknown };
		management?: { name?: unknown; post?: unknown };
	};
};

function text(value: unknown): string | null {
	if (typeof value !== 'string') {
		return null;
	}

	const trimmed = value.trim();

	return trimmed === '' ? null : trimmed;
}

/**
 * Состояние юридического лица. Неизвестное значение становится `unknown`, а не
 * «действует»: молча считать действующим то, чего мы не поняли, — худший из
 * возможных ответов на этот вопрос.
 */
export function legalStatus(raw: unknown): LegalStatus {
	switch (text(raw)?.toUpperCase()) {
		case 'ACTIVE':
			return 'active';
		case 'LIQUIDATING':
			return 'liquidating';
		case 'LIQUIDATED':
			return 'liquidated';
		case 'REORGANIZING':
			return 'reorganizing';
		case 'BANKRUPT':
			return 'bankrupt';
		default:
			return 'unknown';
	}
}

/** Почтовые адреса из выписки: по их домену потом ищется сайт. */
function emailsOf(raw: unknown): string[] {
	if (!Array.isArray(raw)) {
		return [];
	}

	const found: string[] = [];

	for (const entry of raw) {
		const value =
			typeof entry === 'object' && entry !== null
				? text((entry as { value?: unknown }).value)
				: text(entry);

		if (value !== null && value.includes('@') && !found.includes(value)) {
			found.push(value);
		}
	}

	return found;
}

/**
 * Подсказка Dadata в виде организации справочника.
 *
 * `null` — у записи нет ни одного наименования: называть нечем, и показывать
 * такую строку сотруднику незачем.
 */
export function toLegalEntity(suggestion: PartySuggestion): LegalEntity | null {
	const data = suggestion.data ?? {};
	const name = data.name ?? {};
	const legalName =
		text(name.full_with_opf) ?? text(name.full) ?? text(suggestion.value) ?? text(name.short);
	const shortName = text(name.short_with_opf) ?? text(name.short) ?? text(suggestion.value);

	if (legalName === null || shortName === null) {
		return null;
	}

	const management = data.management ?? {};
	const managementName = text(management.name);

	return {
		inn: text(data.inn),
		kpp: text(data.kpp),
		ogrn: text(data.ogrn),
		legalName,
		shortName,
		region: text(data.address?.data?.region_with_type) ?? text(data.address?.data?.region),
		address: text(data.address?.value),
		status: legalStatus(data.state?.status),
		// `branch_type` равен `MAIN` у головной организации и `BRANCH` у филиала.
		isBranch: text(data.branch_type)?.toUpperCase() === 'BRANCH',
		management:
			managementName === null ? null : { name: managementName, post: text(management.post) },
		emails: emailsOf(data.emails),
		okved: text(data.okved)
	};
}

/** Подсказки из тела ответа; чужой формат — это отказ, а не пустой список. */
export function readSuggestions(body: unknown): LegalEntity[] {
	if (
		typeof body !== 'object' ||
		body === null ||
		!Array.isArray((body as { suggestions?: unknown }).suggestions)
	) {
		throw new DadataError('bad_shape');
	}

	const suggestions = (body as { suggestions: unknown[] }).suggestions;
	const entities: LegalEntity[] = [];

	for (const entry of suggestions) {
		if (typeof entry !== 'object' || entry === null) {
			continue;
		}

		const entity = toLegalEntity(entry as PartySuggestion);

		if (entity !== null) {
			entities.push(entity);
		}
	}

	return entities;
}

async function call(path: string, payload: Record<string, unknown>): Promise<LegalEntity[]> {
	const { origin, key, custom } = await getDadataConnection();

	if (key === null) {
		throw new DadataError('not_configured', null, DADATA_NOT_CONFIGURED);
	}

	const url = new URL(path, origin).toString();

	// Свой адрес проверяется в момент запроса, а не только при сохранении:
	// имя, сохранённое годным, к этому моменту может вести внутрь установки.
	if (custom && (await outboundTargetIssue(url)) !== null) {
		throw new DadataError('outbound_refused');
	}

	let response: Response;

	try {
		response = await fetch(url, {
			method: 'POST',
			headers: {
				accept: 'application/json',
				'content-type': 'application/json',
				authorization: `Token ${key}`
			},
			body: JSON.stringify(payload),
			// За перенаправлением не идём: `Location` ведёт куда угодно, и туда
			// уехал бы заголовок с ключом.
			redirect: 'manual',
			signal: AbortSignal.timeout(DADATA_TIMEOUT_MS)
		});
	} catch (error) {
		throw new DadataError(
			error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
				? 'timeout'
				: 'unreachable'
		);
	}

	if (response.status >= 300 && response.status < 400) {
		throw new DadataError('redirect', response.status);
	}

	if (!response.ok) {
		// 401 и 403 — ключ, 429 — исчерпан дневной лимит запросов. Для сотрудника
		// это один и тот же отказ, а код уходит в лог.
		throw new DadataError('http_status', response.status);
	}

	let body: unknown;

	try {
		body = await response.json();
	} catch {
		throw new DadataError('not_json', response.status);
	}

	return readSuggestions(body);
}

/**
 * Организации по строке поиска.
 *
 * По ИНН идёт `findById`: там ответ либо один, либо пустой, и «похожих» быть не
 * может. По названию — `suggest` с `type: LEGAL`: физические лица и ИП в
 * справочнике вузов не нужны, и отсеивать их после ответа значило бы тратить
 * подсказки впустую.
 */
export async function findParties(query: string, kind: LookupQueryKind): Promise<LegalEntity[]> {
	return kind === 'inn'
		? call(FIND_BY_ID_PATH, { query, count: SUGGEST_COUNT })
		: call(SUGGEST_PATH, { query, count: SUGGEST_COUNT, type: 'LEGAL' });
}
