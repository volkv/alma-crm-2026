import { version } from '$app/environment';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { pingDatabase } from '$lib/server/db';
import { pingStorage } from '$lib/server/documents/storage';
import { pingRedis } from '$lib/server/redis';

type CheckResult = 'ok' | string;

async function check(probe: () => Promise<void>): Promise<CheckResult> {
	try {
		await probe();
		return 'ok';
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

/**
 * Liveness/readiness probe. Returns 200 only when every backing service
 * answers; otherwise 503 with the error reported by the service that is down.
 *
 * Хранилище файлов входит в пробу наравне с базой и Redis. Без него не
 * работают загрузка, скачивание, генерация документов и импорт статистики —
 * называть такое приложение здоровым значит спрятать отказ от того, кто смотрит
 * на стенд. Docker неисправный контейнер сам не перезапускает, так что цена
 * честного ответа — метка `unhealthy` и строка в ответе, а не рестарт по кругу.
 */
export const GET: RequestHandler = async () => {
	const [db, redis, storage] = await Promise.all([
		check(pingDatabase),
		check(pingRedis),
		check(pingStorage)
	]);
	const healthy = db === 'ok' && redis === 'ok' && storage === 'ok';

	return json(
		{ status: healthy ? 'ok' : 'error', db, redis, storage, version },
		{ status: healthy ? 200 : 503, headers: { 'cache-control': 'no-store' } }
	);
};
