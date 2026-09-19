import { json } from '@sveltejs/kit';
import { actorFromEvent } from '$lib/server/actor';
import { tourSamples } from '$lib/server/onboarding/samples';
import type { RequestHandler } from './$types';

/**
 * Записи, которые подсказкам разрешено открыть этой сессии.
 *
 * Отдельный эндпоинт, а не поле в данных оболочки: восемь выборок на каждый
 * переход между страницами платил бы каждый, а нужны они одному человеку из
 * многих и один раз за сеанс — тур спрашивает их лениво, когда его открывают.
 *
 * Маршрут лежит внутри `(app)`, поэтому сессию требует общий хук; права и
 * область доступа проверяют те же сервисы списков, которые собирают образцы.
 * Ответ не кэшируется: назначение ответственного меняет область доступа
 * немедленно, и вчерашний образец увёл бы тур на запись, которой человек уже
 * не видит.
 */
export const GET: RequestHandler = async (event) => {
	return json(await tourSamples(actorFromEvent(event)), {
		headers: { 'cache-control': 'no-store' }
	});
};
