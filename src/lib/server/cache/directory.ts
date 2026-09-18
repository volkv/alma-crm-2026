/**
 * Кэш справочных списков, из которых выбирают в формах и фильтрах.
 *
 * Это не списки разделов и не выборки API: здесь только подбор — «выбери
 * организацию», «выбери человека». Он приезжает вместе почти с каждой формой,
 * читается целиком, а меняется с заведением новой строки справочника, то есть
 * несопоставимо реже, чем открывается.
 *
 * Поколение — счётчик: строка справочника меняется в одном месте, а в ключах
 * лежит по записи на каждую область доступа, и обесценить их все можно только
 * одной командой. Область доступа в ключе обязательна: подбор ограничен вузами
 * ответственного, и общая запись выдала бы менеджеру чужие названия.
 */
import type { ActorContext } from '../actor';
import { assignmentsKey, bumpEpoch, cached, readEpoch, scopeKey, type CacheRegion } from './region';

/**
 * Полминуты. Подбор — это то, что человек видит перед тем, как выбрать, и
 * заведённая соседом организация обязана появляться в нём заметно быстрее, чем
 * человек успеет спросить, куда она делась.
 */
const DIRECTORY_OPTIONS: CacheRegion = { name: 'directory-options', ttlSeconds: 30 };

/**
 * Справочник изменился: собранные подсказки больше не показывать.
 *
 * Зовётся после любой записи в справочник — организации, площадки, люди, роли
 * людей, программы, продукты, направления.
 */
export async function invalidateDirectoryOptions(): Promise<void> {
	await bumpEpoch(DIRECTORY_OPTIONS);
}

/**
 * Подбор из справочника: готовый или собранный заново.
 *
 * `part` называет список («organizations», «people»); право на чтение
 * проверяет сам список, до обращения сюда.
 */
export async function cachedDirectoryOptions<TValue>(
	ctx: ActorContext,
	part: string,
	build: () => Promise<TValue>,
	revive: (stored: unknown) => TValue
): Promise<TValue> {
	const [epoch, assignments] = await Promise.all([
		readEpoch(DIRECTORY_OPTIONS),
		assignmentsKey(ctx)
	]);

	return cached(
		DIRECTORY_OPTIONS,
		`${epoch}:${scopeKey(ctx)}:${assignments}:${part}`,
		build,
		revive
	);
}
