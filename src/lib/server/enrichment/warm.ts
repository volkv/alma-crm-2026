/**
 * Прогрев отчёта сайта: раздел `/sveden` читается заранее, без человека.
 *
 * Формы карточки дела предлагают подразделения и людей вуза «с сайта» — из
 * того же отчёта, что показывает карточка организации. Ждать, пока сотрудник
 * сам нажмёт «Прочитать сведения», значит оставлять эти блоки пустыми, поэтому
 * сервер читает раздел сам: когда вуз заводят из ЕГРЮЛ и когда открывают
 * карточку дела с вузом, чей отчёт ещё не прочитан.
 *
 * Прогрев — это ускорение, а не обязанность, и правила у него свои:
 * - **не блокирует.** Вызывающий не ждёт: ответ страницы уходит сразу, а
 *   отчёт ложится в кэш, когда сайт ответит;
 * - **не тратит квоту сотрудника** и не требует пользователя: квота считает
 *   обращения человека, а сюда никто не обращался. От лишних заходов
 *   защищает кэш на неделю и замок на сайт;
 * - **уважает выключатель.** Источники выключены настройкой — наружу не ходит
 *   никто, в том числе прогрев;
 * - **молчит об ошибках.** Упавший прогрев — строка в логе; форма без
 *   прогретого отчёта работает, как работала.
 *
 * Замок в Redis (`SET NX` со сроком) держит один прогрев на сайт: карточку
 * дела открывают впятером на планёрке, а на сайт вуза нужно сходить один раз.
 * Отдельной очереди нет: заход короче минуты, и потерянный при перезапуске
 * прогрев повторит следующее открытие карточки.
 */
import { createHash } from 'node:crypto';
import type { SiteReport } from '$lib/contracts/enrichment';
import { peekCached } from '../cache/region';
import { getRedis } from '../redis';
import { getSetting } from '../settings';
import { cachedSiteReport, SITE_REPORT_CACHE, siteCacheKey } from './index';
import { fetchSiteReport, normalizeWebsite } from './sveden';

/**
 * Срок замка: дольше самого долгого чтения раздела (четыре подраздела
 * параллельно, до трёх адресов и четырёх переходов у каждого по десять
 * секунд), чтобы второй прогрев не пошёл, пока идёт первый. Упавший процесс
 * замок не снимет — его снимет срок.
 */
const WARM_LOCK_SECONDS = 3 * 60;

function lockKey(origin: string): string {
	const hash = createHash('sha256').update(origin.toLowerCase(), 'utf8').digest('hex').slice(0, 32);

	return `lct:enrichment:warm:${hash}`;
}

/** Чем кончился прогрев: для журнала и проверок, вызывающему не нужен. */
export type WarmOutcome = 'no_site' | 'disabled' | 'cached' | 'busy' | 'fetched';

/**
 * Прогрев с ожиданием результата — для проверок и для тех, кто вправе ждать.
 * Бросает, как бросают Redis и настройки; `warmSiteReport` ловит это за него.
 */
export async function warmSite(website: string | null): Promise<WarmOutcome> {
	const origin = website === null ? null : normalizeWebsite(website);

	if (origin === null) {
		return 'no_site';
	}

	if (!(await getSetting('enrichment')).enabled) {
		return 'disabled';
	}

	const known = await peekCached(
		SITE_REPORT_CACHE,
		siteCacheKey(origin),
		(stored) => stored as SiteReport | null
	);

	if (known !== undefined) {
		return 'cached';
	}

	const redis = getRedis();
	const lock = lockKey(origin);

	if ((await redis.set(lock, '1', 'EX', WARM_LOCK_SECONDS, 'NX')) === null) {
		return 'busy';
	}

	try {
		await cachedSiteReport(origin, () => fetchSiteReport(origin, new Date().toISOString()));

		return 'fetched';
	} finally {
		await redis.del(lock);
	}
}

/**
 * Прогрев в фоне: вызывающий не ждёт, ошибки остаются в логе.
 *
 * Адрес сайта в лог не пишется целиком — только происхождение: это адрес вуза
 * из карточки, а не персональные данные, но и путь со строкой запроса в логе
 * ни к чему.
 */
export function warmSiteReport(website: string | null): void {
	void warmSite(website).catch((cause: unknown) => {
		const origin = website === null ? null : normalizeWebsite(website);

		console.error(
			`[enrichment] прогрев сведений сайта ${origin ?? '(без адреса)'} не удался:`,
			cause instanceof Error ? cause.message : cause
		);
	});
}

/** Состояние отчёта сайта для форм: готов, читается, или его не будет. */
export type SiteReadiness =
	| { state: 'ready'; report: SiteReport }
	| { state: 'warming' }
	| { state: 'no_site' }
	| { state: 'disabled' };

/**
 * Отчёт сайта для формы: из кэша, а нет его — прогрев в фоне и «читается».
 *
 * Права проверяет вызывающий: здесь нет ни человека, ни организации — только
 * адрес сайта из карточки, которую вызывающий уже прочитал со своими правами.
 * Прочитанный отчёт показывается и при выключенных источниках: наружу этот
 * вызов тогда не ходит.
 */
export async function siteReadiness(website: string | null): Promise<SiteReadiness> {
	const origin = website === null ? null : normalizeWebsite(website);

	if (origin === null) {
		return { state: 'no_site' };
	}

	const known = await peekCached(
		SITE_REPORT_CACHE,
		siteCacheKey(origin),
		(stored) => stored as SiteReport | null
	);

	if (known !== undefined) {
		return known === null ? { state: 'no_site' } : { state: 'ready', report: known };
	}

	if (!(await getSetting('enrichment')).enabled) {
		return { state: 'disabled' };
	}

	warmSiteReport(origin);

	return { state: 'warming' };
}
