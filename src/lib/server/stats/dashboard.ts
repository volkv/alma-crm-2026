/**
 * Дашборд портфеля данных: одна картина одного отчётного периода.
 *
 * Собирается одним сервисом — плитки, разбивка по группам программ,
 * распределение по вузам и происхождение обязаны сходиться между собой, а
 * собранные по отдельности они сойтись не обязаны. Числа при этом по-прежнему
 * считает представление `stat_program_indicators`: здесь они только
 * складываются в вид, удобный экрану и выгрузке. Рейтинг — исключение: он
 * считается по фактам системы, а не по снимкам (`stats/ranking.ts`), и
 * приезжает сюда тем же сервисом, что и на экран рейтинга. Поэтому
 * подтверждение снимка его не меняет, а новая заявка или результат группы
 * доходят до дашборда по сроку жизни записи.
 *
 * Периоды не складываются между собой: период входит в ключ группировки
 * показателей, и сложить пересекающиеся значило бы посчитать одних и тех же
 * обучающихся дважды. Поэтому дашборд всегда про один период, и период — часть
 * адреса и часть ключа кэша.
 *
 * Кэш живёт в Redis и живёт недолго. Инвалидация — счётчиком поколения, а не
 * перебором ключей: ключ включает и период, и область доступа, поэтому найти
 * «все ключи, которые устарели» можно было бы только сканированием, а `INCR`
 * обесценивает их все одной командой. Пережившие своё поколение ключи уходят
 * сами по сроку жизни.
 *
 * Счётчик отвечает за числа — за то, что меняет подтверждение снимка. За состав
 * области отвечает второе слагаемое ключа: назначения вузов меняют не картину
 * периода, а то, чью её часть человеку видно, и меняет их не эта подсистема.
 * Поэтому в ключ входит и отпечаток области доступа, и отпечаток её
 * действующих назначений — оба считает `cache/region.ts`, общий для всех
 * областей кэша. Своего описания области здесь нет намеренно: два описания
 * одного и того же разошлись бы на первой правке, и две разные области
 * поделили бы одну запись.
 */
import {
	statPeriodKey,
	type StatDashboardTotals,
	type StatDashboardView,
	type StatPeriod
} from '$lib/contracts/stats';
import type { ActorContext } from '../actor';
import { assignmentsKey, scopeKey } from '../cache/region';
import { requirePermission } from '../rbac';
import { getRedis } from '../redis';
import { getRanking } from './ranking';
import {
	readDashboardGroups,
	readDashboardOrganizations,
	readDashboardOrigin,
	readDashboardTotals
} from './read';

const DASHBOARD_PREFIX = 'lct:stats:dashboard:';

/**
 * Поколение кэша: его увеличивает подтверждение снимка. Ключ с прежним
 * поколением уже никто не прочитает, поэтому удалять его незачем.
 */
const EPOCH_KEY = `${DASHBOARD_PREFIX}epoch`;

/**
 * Сколько живёт собранный дашборд.
 *
 * Минута — это про наплыв (раздел открыли впятером на планёрке), а не про
 * актуальность: актуальность обеспечивает инвалидация при подтверждении
 * снимка, и подтверждение видно на дашборде сразу, а не через минуту.
 */
export const STATS_DASHBOARD_TTL_SECONDS = 60;

async function cacheKey(ctx: ActorContext, period: StatPeriod): Promise<string> {
	const [epoch, assignments] = await Promise.all([getRedis().get(EPOCH_KEY), assignmentsKey(ctx)]);

	return `${DASHBOARD_PREFIX}${epoch ?? '0'}:${scopeKey(ctx)}:${assignments}:${statPeriodKey(period)}`;
}

/**
 * Картина периода стала другой: собранное раньше больше не показывать.
 * Зовётся после подтверждения снимка — единственного события, которое меняет
 * показатели.
 */
export async function invalidateStatsDashboard(): Promise<void> {
	await getRedis().incr(EPOCH_KEY);
}

async function buildStatsDashboard(
	ctx: ActorContext,
	period: StatPeriod
): Promise<StatDashboardView> {
	const [totals, groups, organizations, origin, ranking] = await Promise.all([
		readDashboardTotals(ctx, period),
		readDashboardGroups(ctx, period),
		readDashboardOrganizations(ctx, period),
		readDashboardOrigin(ctx, period),
		getRanking(ctx, period)
	]);

	const confirmed = origin.sources
		.map((source) => source.confirmedAt)
		.filter((moment): moment is string => moment !== null)
		.sort();

	return {
		period,
		totals: { ...totals, siteCount: origin.siteCount } satisfies StatDashboardTotals,
		groups,
		organizations,
		ranking,
		sources: origin.sources,
		// Актуальность — это подтверждение импорта: до него числа остаются
		// черновиком, и момент загрузки файла о картине периода ничего не говорит.
		updatedAt: confirmed.at(-1) ?? null
	};
}

/**
 * Дашборд за период. Первым делом право: кэш не должен становиться обходом
 * проверки, а проверка «право есть» дешевле похода в Redis.
 */
export async function getStatsDashboard(
	ctx: ActorContext,
	period: StatPeriod
): Promise<StatDashboardView> {
	requirePermission(ctx, 'stats.read');

	const redis = getRedis();
	const key = await cacheKey(ctx, period);
	const cached = await redis.get(key);

	if (cached !== null) {
		return JSON.parse(cached) as StatDashboardView;
	}

	const view = await buildStatsDashboard(ctx, period);

	await redis.set(key, JSON.stringify(view), 'EX', STATS_DASHBOARD_TTL_SECONDS);

	return view;
}
