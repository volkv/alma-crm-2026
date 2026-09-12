import { error } from '@sveltejs/kit';
import { actorFromEvent } from '$lib/server/actor';
import { can } from '$lib/server/rbac';
import { listRoutes } from '$lib/server/stages/routes';
import type { PageServerLoad } from './$types';

/**
 * Маршруты стадий: версии описания процесса.
 *
 * Список показывает версии, а не маршруты: у одного ключа их столько, сколько
 * раз процесс переписывали, и работают они одновременно — старые взаимодействия
 * идут по своей версии, новые заводятся по маршруту по умолчанию. Поэтому в
 * строке стоит счётчик активных взаимодействий: по нему видно, какую версию
 * ещё нельзя списывать со счетов.
 */
export const load: PageServerLoad = async (event) => {
	const ctx = actorFromEvent(event);

	if (!can(ctx, 'stages.configure')) {
		error(403, 'Раздел доступен только с правом «Настройка маршрутов и стадий»');
	}

	return { routes: await listRoutes(ctx) };
};
