import { error, type Handle } from '@sveltejs/kit';
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

export const csrf: Handle = async ({ event, resolve }) => {
	if (UNSAFE_METHODS.has(event.request.method) && isFormSubmission(event.request)) {
		const origin = event.request.headers.get('origin');

		if (origin !== new URL(getConfig().ORIGIN).origin) {
			error(
				403,
				'Запрос отправлен с другого сайта и отклонён. Откройте форму в системе и повторите отправку.'
			);
		}
	}

	return resolve(event);
};
