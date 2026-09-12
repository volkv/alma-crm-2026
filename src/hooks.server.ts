import type { HandleServerError, ServerInit } from '@sveltejs/kit';
import { sequence } from '@sveltejs/kit/hooks';
import { getConfig } from '$lib/server/config';
import { guard } from '$lib/server/hooks/guard';
import { rateLimit } from '$lib/server/hooks/rate-limit';
import { requestId } from '$lib/server/hooks/request-id';
import { securityHeaders } from '$lib/server/hooks/security-headers';
import { session } from '$lib/server/hooks/session';

/**
 * Runs once while the server starts, before it accepts any request — and not
 * during the build. A missing or malformed variable stops the process here
 * rather than surfacing as a broken page later.
 */
export const init: ServerInit = () => {
	getConfig();
};

/**
 * Every cross-cutting concern of a request, in the order it has to happen:
 * an id to log under, headers that must be on every response, who the caller is,
 * whether they may proceed, and how often they may do so. A new aspect goes into
 * its own file under `lib/server/hooks` and into this list — never inline here.
 */
export const handle = sequence(requestId, securityHeaders, session, guard, rateLimit);

/**
 * Отказы, которые сочиняет не приложение, а сам фреймворк: до нашего кода такой
 * запрос не доходит, и объяснить его некому, кроме этой таблицы.
 *
 * 413 приезжает из `adapter-node`, когда тело запроса перевалило за
 * `BODY_SIZE_LIMIT`, — это загрузка файла крупнее потолка, и потолок в тексте
 * назван, иначе человек не знает, насколько ужимать. 415 — это форма, поданная
 * не как форма: так выглядит чужой скрипт или наш собственный `fetch` с
 * неправильным заголовком.
 */
const REJECTIONS: Record<number, string> = {
	404: 'Страница не найдена',
	413: 'Файл или запрос больше, чем принимает сервер (до 25 МиБ)',
	415: 'Неподдерживаемый формат запроса'
};

/**
 * Everything nobody planned for: a load that threw, a route that does not
 * exist, a page that failed to render. The visitor gets a short sentence and
 * the request id — the same id the log line carries, so one report maps to one
 * request. Neither the message of the original error nor its stack goes out:
 * those describe how the system is built.
 *
 * Errors thrown deliberately with `error()` never reach this hook — SvelteKit
 * keeps their body as written, which is exactly what the services mean by
 * "сказать человеку, что случилось".
 */
export const handleError: HandleServerError = ({ error, event, status, message }) => {
	const rejection = REJECTIONS[status];

	if (rejection === undefined) {
		console.error(`[app] необработанная ошибка запроса ${event.locals.requestId}`, error);
	} else if (status !== 404) {
		// Отвергнутый по форме запрос — не сбой приложения: стек описывает наш
		// код, а причина лежит в самом запросе, и строки о ней достаточно.
		// Ненайденный адрес не пишется вовсе: им лог забивают чужие сканеры.
		console.warn(`[app] запрос ${event.locals.requestId} отвергнут: ${status} ${message}`);
	}

	return {
		message: rejection ?? 'Внутренняя ошибка сервера',
		requestId: event.locals.requestId
	};
};
