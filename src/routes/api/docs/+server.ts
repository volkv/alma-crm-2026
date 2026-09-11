import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { DOCS_PAGE, docsHeaders } from '$lib/server/api/docs';

/**
 * Страница документации API. Единственное место раздела, которое смотрит на
 * сессию браузера: это страница для человека, а не эндпоинт для машины, поэтому
 * и не вошедшего она встречает так же, как остальные страницы, — входом.
 */
export const GET: RequestHandler = ({ locals, url }) => {
	if (locals.user === null) {
		redirect(303, `/login?next=${encodeURIComponent(url.pathname)}`);
	}

	return new Response(DOCS_PAGE, { headers: docsHeaders('text/html; charset=utf-8') });
};
