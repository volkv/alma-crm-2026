/**
 * Дашборд портфеля данных: одна картина одного отчётного периода.
 *
 * Собирается одним сервисом — плитки, разбивка по группам программ,
 * распределение по вузам, рейтинг и происхождение обязаны сходиться между
 * собой, а собранные по отдельности они сойтись не обязаны. Числа при этом
 * по-прежнему считает представление `stat_program_indicators`: здесь они
 * только складываются в вид, удобный экрану и выгрузке.
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
 * Поэтому в ключ входит отпечаток действующих назначений области — см.
 * `assignmentsKey`.
 */
import { createHash } from 'node:crypto';
import { and, isNull, sql } from 'drizzle-orm';
import {
	statPeriodKey,
	type StatDashboardTotals,
	type StatDashboardView,
	type StatPeriod
} from '$lib/contracts/stats';
import type { ActorContext } from '../actor';
import { getDb } from '../db';
import { organizationResponsibles } from '../db/schema';
import { requirePermission, scopeFingerprint } from '../rbac';
import { getRedis } from '../redis';
import {
	rankPrograms,
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

/**
 * Область доступа в ключе кэша.
 *
 * Без неё дашборд, собранный администратором, достался бы менеджеру, который
 * видит три вуза из сорока. Область уезжает в ключ отпечатком: список
 * пользователей бывает длинным, а ключ Redis читают глазами. Считает отпечаток
 * `scopeFingerprint` — тот же, что знает устройство области; своё описание
 * здесь разошлось бы с ним на первой же правке, и две разные области поделили
 * бы одну запись.
 */
function scopeKey(ctx: ActorContext): string {
	const fingerprint = scopeFingerprint(ctx);

	if (fingerprint === 'all') {
		return 'all';
	}

	return createHash('sha256').update(fingerprint, 'utf8').digest('hex').slice(0, 16);
}

/**
 * Назначения области в ключе кэша.
 *
 * Область — это множество **людей**, и `scopeKey` описывает именно его. Какие
 * вузы за этими людьми числятся, в нём не отражено никак: у КАМа отпечаток
 * области один и тот же и до передачи вуза, и после. А дашборд считается ровно
 * по вузам — значит, снятое назначение обязано менять ключ, иначе прежний
 * ответственный целую минуту (пока жив кэш) читает числа вуза, которого у него
 * уже нет, — и те же числа уезжают в выгрузку.
 *
 * Отпечаток снимается с самих действующих назначений, а не со счётчика,
 * который двигали бы `assignResponsible` и `releaseResponsible`: строки
 * `organization_responsibles` появляются ещё в трёх местах — у заведения
 * организации, у приёма заявки извне и у сида демонстрационного стенда, — и
 * счётчик, о котором знают не все, врал бы молча. Здесь же ключ считается по
 * тому же состоянию, по которому потом соберётся дашборд.
 *
 * Цена — один лёгкий запрос по частичному индексу `organization_responsibles_user_idx`
 * на чтение сводки; собранный дашборд стоит пяти тяжёлых. Полный доступ не
 * платит и этого: у него область не сужается назначениями вовсе.
 */
async function assignmentsKey(ctx: ActorContext): Promise<string> {
	if (ctx.scope.kind === 'all') {
		return 'all';
	}

	const ids = [...ctx.scope.userIds];

	if (ids.length === 0) {
		return 'none';
	}

	// Порядок в `string_agg` задан явно: без `order by` PostgreSQL волен
	// склеить те же строки иначе, и один и тот же набор вузов дал бы два
	// разных ключа — кэш перестал бы попадать, оставаясь при этом верным.
	const [row] = await getDb()
		.select({
			fingerprint: sql<string>`coalesce(left(md5(string_agg(distinct ${organizationResponsibles.organizationId}::text, ',' order by ${organizationResponsibles.organizationId}::text)), 16), 'none')`
		})
		.from(organizationResponsibles)
		.where(
			and(
				sql`${organizationResponsibles.userId} = any(${sql.param(ids)}::uuid[])`,
				isNull(organizationResponsibles.validTo)
			)
		);

	return row.fingerprint;
}

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
		rankPrograms(ctx, { period })
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
