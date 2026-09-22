/**
 * Кэш структуры процесса: действующая редакция пространства и списки, которые
 * из неё собираются.
 *
 * Действующую редакцию со стадиями, переходами и правилами переноса читают
 * почти все экраны работы — карточка, её сводка, список, доска, — и каждое
 * чтение это четыре выборки. При этом меняется структура ровно одним
 * действием: применением черновика ко всем. Данные, которые читают на каждом
 * шаге и меняют раз в неделю, — это и есть случай кэша.
 *
 * Поколение здесь — счётчик, а не идентификатор действующей редакции. Разница
 * принципиальная: по идентификатору кэш сам собой обесценивался бы публикацией
 * и **не** обесценивался ничем другим, а это молчаливое обещание, что редакцию
 * после публикации никто не правит. Счётчик же требует явной точки сброса —
 * `invalidateProcessRevisions()` после фиксации публикации, — и она видна в
 * коде и проверяется тестом.
 *
 * Персональных данных в кэше нет: это ключи стадий, названия, нормативы и
 * чек-листы.
 */
import type { ProcessRevisionView } from '$lib/contracts/interactions';
import { bumpEpoch, cached, readEpoch, type CacheRegion } from './region';

/**
 * Минута. Структура процесса меняется публикацией, и публикация кэш
 * обесценивает; срок нужен только тому, что пережило перезапуск приложения или
 * запись мимо сервиса — например, набор данных, залитый в базу скриптом.
 */
const PROCESS_REVISION: CacheRegion = { name: 'process-revision', ttlSeconds: 60 };

/**
 * Процесс изменился: собранные редакции больше не показывать.
 *
 * Зовётся после фиксации публикации. Внутри транзакции звать нельзя: до
 * фиксации новая редакция ещё не действующая, и читатель успел бы положить в
 * кэш то, чего ещё нет.
 */
export async function invalidateProcessRevisions(): Promise<void> {
	await bumpEpoch(PROCESS_REVISION);
}

/**
 * Поколение области — для тех, кто кладёт в свой ключ и структуру процесса
 * тоже: список стадий в фильтрах отчёта живёт в кэше подбора, а меняется
 * публикацией.
 */
export async function readProcessEpoch(): Promise<string> {
	return readEpoch(PROCESS_REVISION);
}

/**
 * Действующая редакция процесса пространства: готовая или собранная заново.
 *
 * Ключ — пространство, а не редакция: иначе публикация обесценивала бы кэш сама
 * собой, и явной точки сброса в коде не было бы вовсе.
 */
export async function cachedActiveRevision(
	workspaceId: string,
	build: () => Promise<ProcessRevisionView | null>
): Promise<ProcessRevisionView | null> {
	const epoch = await readProcessEpoch();

	return cached(PROCESS_REVISION, `${epoch}:${workspaceId}`, build, (stored) => {
		const revision = stored as
			| (Omit<ProcessRevisionView, 'publishedAt'> & {
					publishedAt: string | null;
			  })
			| null;

		if (revision === null) {
			return null;
		}

		// Единственный момент времени в редакции: JSON вернул его строкой.
		return {
			...revision,
			publishedAt: revision.publishedAt === null ? null : new Date(revision.publishedAt)
		};
	});
}
