import { redirect, type Handle } from '@sveltejs/kit';

/**
 * Decides whether the resolved caller may reach the requested route at all.
 *
 * The rule is the route group, not a list of paths: everything under `(app)` is
 * the application itself and needs a session, `(auth)` is how one is obtained,
 * and `/api/v1` authenticates with keys and answers in JSON — that belongs to
 * the API module, so it is left alone here. A request for a route that does not
 * exist (`route.id === null`) is not redirected either: a missing page must
 * answer 404 whether or not anyone is signed in, or the guard turns into a map
 * of what exists.
 *
 * Per-route permissions are checked by the loads and services that know what
 * they are protecting; this hook only answers "is there anybody there" — and,
 * since the second factor exists, "did they finish coming in".
 *
 * Перенаправление именно бросается, а не собирается ответом: у брошенного есть
 * три разных вида — заголовок `location` для обычной навигации, конверт JSON
 * для запроса данных клиентского маршрутизатора и ещё один для отправки формы
 * через `use:enhance`, — и выбирает между ними SvelteKit. Готовый 303 такого
 * разбора не проходит: форма на странице с погасшей сессией получила бы в
 * ответ HTML страницы входа вместо ожидаемого JSON и сломалась бы разбором.
 * Отложенные в `event.cookies` SvelteKit дописывает и к брошенному
 * перенаправлению — чем и пользуется хук `session`. Цена одна: заголовки,
 * которые ставят внешние хуки, на такой ответ не попадают (см.
 * `docs/development.md`).
 */
export const guard: Handle = async ({ event, resolve }) => {
	if (event.route.id?.startsWith('/(app)')) {
		const user = event.locals.user;

		if (user === null) {
			redirect(303, `/login?next=${encodeURIComponent(requestedPath(event.url))}`);
		}

		// Пароль приняли, второго фактора ещё нет: такая сессия существует только
		// ради второго шага входа и в приложение не пускает. Разворот именно сюда,
		// а не на `/login`: там человека встретила бы форма, в которую он уже всё
		// ввёл, — а незакрытый второй шаг это не «войдите», а «подтвердите».
		if (user.mfaPending === true) {
			redirect(303, `/login/mfa?next=${encodeURIComponent(requestedPath(event.url))}`);
		}
	}

	return resolve(event);
};

/** Куда человек шёл: путь вместе со строкой запроса. */
function requestedPath(url: URL): string {
	return `${url.pathname}${url.search}`;
}
