/**
 * Исходящий запрос имитатора в CRM: направления 1 (заявка) и 4 (результат
 * группы) контракта обмена.
 *
 * Имитатор — отправитель, поэтому представляется ключом доступа API
 * (`Authorization: Bearer lct_…`), как всякая чужая система
 * (`docs/exchange-contract.md`, раздел 2). Подписью HMAC подписываются
 * исходящие CRM, а не входящие в неё.
 *
 * Повторов здесь нет намеренно: повтор — это ещё одно нажатие триггера с тем
 * же `eventId`, и решает его тот, кто ведёт проверку. Имитатор, который
 * повторяет сам, скрыл бы от проверки ровно то, ради чего его подняли.
 */

/** Сколько ждём CRM. Дольше — и проверка превращается в ожидание. */
export const DEFAULT_CRM_TIMEOUT_MS = 10_000;

export type CrmTarget = {
	/** Адрес CRM, например `http://app:3000`; `null` — обмен на стенде не настроен. */
	baseUrl: string | null;
	/** Ключ доступа CRM; `null` — обмен на стенде не настроен. */
	apiKey: string | null;
	timeoutMs?: number;
};

/** Чего не хватает, чтобы пойти в CRM; `null` — всё на месте. */
export function crmIssue(target: CrmTarget): string | null {
	const missing: string[] = [];

	if (target.baseUrl === null || target.baseUrl === '') {
		missing.push('CRM_BASE_URL');
	}

	if (target.apiKey === null || target.apiKey === '') {
		missing.push('CRM_API_KEY');
	}

	return missing.length === 0
		? null
		: `Обмен со стендом не настроен: не задано ${missing.join(' и ')}`;
}

export type CrmCall = {
	url: string;
	/** Код ответа; `null` — ответа не было (обрыв связи, таймаут). */
	status: number | null;
	body: unknown;
	/** Что помешало, словами; `null` — ответ получен. */
	error: string | null;
};

export async function postToCrm(
	target: CrmTarget,
	path: string,
	payload: unknown
): Promise<CrmCall> {
	const issue = crmIssue(target);

	if (issue !== null) {
		throw new Error(issue);
	}

	const url = `${(target.baseUrl ?? '').replace(/\/+$/, '')}${path}`;
	const body = JSON.stringify(payload);
	const eventId =
		typeof payload === 'object' && payload !== null && 'eventId' in payload
			? String((payload as { eventId: unknown }).eventId)
			: null;

	let response: Response;

	try {
		response = await fetch(url, {
			method: 'POST',
			headers: {
				'content-type': 'application/json; charset=utf-8',
				accept: 'application/json',
				authorization: `Bearer ${target.apiKey ?? ''}`,
				// Тот же ключ идемпотентности, что и `eventId`: повтор одного и того
				// же события — это тот же запрос, а не новый под старым именем.
				...(eventId === null ? {} : { 'idempotency-key': eventId })
			},
			body,
			// За перенаправлением не идём: `Location` унёс бы туда и тело, и ключ.
			redirect: 'manual',
			signal: AbortSignal.timeout(target.timeoutMs ?? DEFAULT_CRM_TIMEOUT_MS)
		});
	} catch (error) {
		const name = error instanceof Error ? error.name : '';
		const message = error instanceof Error ? error.message : String(error);

		return {
			url,
			status: null,
			body: null,
			error:
				name === 'TimeoutError' || name === 'AbortError'
					? `CRM не ответила за ${target.timeoutMs ?? DEFAULT_CRM_TIMEOUT_MS} мс`
					: `Не удалось отправить: ${message}`
		};
	}

	const text = await response.text();
	let parsed: unknown;

	try {
		parsed = text === '' ? null : JSON.parse(text);
	} catch {
		// Не JSON — так и покажем: строкой. Это ответ чужой системы, и
		// притворяться, что он разобран, нельзя.
		parsed = text;
	}

	return { url, status: response.status, body: parsed, error: null };
}
