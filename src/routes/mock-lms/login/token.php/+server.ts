import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getConfig } from '$lib/server/config';
import { mockToken, readParams } from '$lib/server/integrations/mock-lms/server';

/**
 * `login/token.php` мока системы обучения — тот же адрес, что у Moodle.
 *
 * Без флага `MOCK_LMS` маршрута не существует: не «выключен», а отвечает 404,
 * как любой несуществующий адрес. Включённая на боевом стенде заглушка
 * выглядела бы как вторая система входа.
 */
function guard(): void {
	if (!getConfig().MOCK_LMS) {
		error(404, 'Страница не найдена');
	}
}

async function respond(request: Request, url: URL): Promise<Response> {
	guard();

	const { status, body } = mockToken(await readParams(request, url));

	return json(body, { status, headers: { 'cache-control': 'no-store' } });
}

export const GET: RequestHandler = ({ request, url }) => respond(request, url);
export const POST: RequestHandler = ({ request, url }) => respond(request, url);
