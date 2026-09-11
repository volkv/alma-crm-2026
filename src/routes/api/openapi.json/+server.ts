import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { buildOpenApiDocument } from '$lib/server/api/openapi';

// Маршрут регистрирует сам себя — в своём файле, рядом с обработчиком. Значит,
// перед сборкой документа файлы маршрутов нужно загрузить, иначе содержимое
// документа зависело бы от того, какие эндпоинты кто-то успел вызвать раньше.
const _routeModules = import.meta.glob('/src/routes/api/v1/**/+server.ts', { eager: true });

/**
 * Описание API. Открыто без ключа: это контракт, а не данные, и получить его
 * интегратор должен раньше, чем ему выпустят ключ.
 */
export const GET: RequestHandler = () =>
	json(buildOpenApiDocument(), { headers: { 'cache-control': 'no-store' } });
