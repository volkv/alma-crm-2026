import { version } from '$app/environment';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { pingDatabase } from '$lib/server/db';
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
 * Liveness/readiness probe. Returns 200 only when both backing services answer;
 * otherwise 503 with the error reported by the service that is down.
 */
export const GET: RequestHandler = async () => {
	const [db, redis] = await Promise.all([check(pingDatabase), check(pingRedis)]);
	const healthy = db === 'ok' && redis === 'ok';

	return json(
		{ status: healthy ? 'ok' : 'error', db, redis, version },
		{ status: healthy ? 200 : 503, headers: { 'cache-control': 'no-store' } }
	);
};
