import { json, type Handle, type RequestEvent } from '@sveltejs/kit';
import { getConfig } from '$lib/server/config';

/**
 * Запросы, которые браузер отправляет с чужой страницы, не спрашивая ни о чём.
 *
 * Форма с постороннего сайта уходит на наш адрес вместе с сессионной кукой, и
 * без проверки происхождения нажатие на чужой странице делало бы всё, что
 * может сделать вошедший. Проверка встроена и во фреймворк, но отвечает она
 * английской фразой своего текста («Cross-site POST form submissions are
 * forbidden») — на русском экране это единственное место, которое говорит не
 * по-русски и не объясняет, что делать. Поэтому встроенная проверка выключена
 * (`csrf.trustedOrigins` в `vite.config.ts`), а правило то же самое живёт
 * здесь.
 *
 * Правило: у запроса, меняющего состояние, заголовок `Origin` обязан совпадать
 * с адресом приложения. Формы отправляются без `Origin` только очень старыми
 * браузерами — такой запрос тоже не проходит, потому что отличить его от
 * подделанного нечем.
 */
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Типы тела, которые браузер отправляет на чужой адрес без предварительного
 * запроса разрешения (`CORS preflight`), — то есть ровно те, которыми подделка
 * и делается. Всё остальное (`application/json`, свои заголовки) браузер сперва
 * согласует с сервером, и наш ответ на согласование его не пропустит.
 */
const FORM_CONTENT_TYPES = [
	'application/x-www-form-urlencoded',
	'multipart/form-data',
	'text/plain'
];

function isFormSubmission(request: Request): boolean {
	const contentType = request.headers.get('content-type')?.toLowerCase() ?? '';

	return FORM_CONTENT_TYPES.some((type) => contentType.startsWith(type));
}

const REFUSAL =
	'Запрос отправлен с другого сайта и отклонён. Откройте форму в системе и повторите отправку.';

/**
 * Политика для страницы отказа: в ней нет ни скриптов, ни стилей, ни картинок,
 * так что запрещено всё. CSP страниц приложения собирает фреймворк при
 * отрисовке, а этот ответ отрисовки не проходит.
 */
const REFUSAL_CSP =
	"default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/**
 * Отказ возвращается готовым ответом, а не бросается через `error()`: брошенную
 * ошибку фреймворк превращает в ответ уже за пределами цепочки хуков, и до
 * внешних хуков — `securityHeaders`, `requestId` — он не доходит. Готовый ответ
 * идёт обратно по цепочке и получает те же заголовки, что и любой другой.
 *
 * Конверт — как у ошибки фреймворка: JSON для `use:enhance`, запроса данных
 * страницы и программного клиента, короткая страница для перехода браузера.
 */
function refuse(event: RequestEvent): Response {
	const accept = event.request.headers.get('accept') || 'text/html';

	if (event.isDataRequest || !accept.includes('text/html')) {
		return json(
			{ message: REFUSAL },
			{ status: 403, headers: { 'Content-Security-Policy': REFUSAL_CSP } }
		);
	}

	const page = `<!doctype html>
<html lang="ru">
<meta charset="utf-8">
<title>Запрос отклонён</title>
<h1>Запрос отклонён</h1>
<p>${REFUSAL}</p>
`;

	return new Response(page, {
		status: 403,
		headers: {
			'Content-Type': 'text/html; charset=utf-8',
			'Content-Security-Policy': REFUSAL_CSP
		}
	});
}

export const csrf: Handle = async ({ event, resolve }) => {
	if (UNSAFE_METHODS.has(event.request.method) && isFormSubmission(event.request)) {
		const origin = event.request.headers.get('origin');

		if (origin !== new URL(getConfig().ORIGIN).origin) {
			return refuse(event);
		}
	}

	return resolve(event);
};
