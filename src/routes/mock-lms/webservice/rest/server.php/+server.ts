import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getConfig } from '$lib/server/config';
import { mockRest, readParams } from '$lib/server/integrations/mock-lms/server';

/**
 * `webservice/rest/server.php` мока системы обучения: один адрес на все
 * функции, как у настоящего Moodle, — что спрашивают, говорит `wsfunction`.
 *
 * Без флага `MOCK_LMS` маршрута не существует (404): включённая на боевом
 * стенде заглушка выглядела бы как вторая система данных об обучении.
 */
function guard(): void {
	if (!getConfig().MOCK_LMS) {
		error(404, 'Страница не найдена');
	}
}

async function respond(request: Request, url: URL): Promise<Response> {
	guard();

	const { status, body } = mockRest(await readParams(request, url), new Date());

	return json(body, { status, headers: { 'cache-control': 'no-store' } });
}

export const GET: RequestHandler = ({ request, url }) => respond(request, url);
export const POST: RequestHandler = ({ request, url }) => respond(request, url);
