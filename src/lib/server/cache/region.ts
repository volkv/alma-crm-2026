/**
 * Механика кэша чтений в Redis: одна на все области.
 *
 * Кэш здесь — это ускорение повторного открытия, а не второй источник правды.
 * Отсюда три правила, которым подчиняется каждая область:
 *
 * 1. **право и область доступа проверяются всегда, до кэша.** Запись в Redis не
 *    имеет права становиться обходом проверки: сначала сервис отвечает на
 *    вопрос «можно ли этому человеку», и только потом смотрит, собрано ли уже
 *    то, что он просит;
 * 2. **область доступа входит в ключ.** Без неё список, собранный
 *    администратором, достался бы менеджеру, который видит три вуза из сорока.
 *    Область — это множество людей, поэтому в ключ идёт и отпечаток самого
 *    множества (`scopeKey`), и отпечаток действующих назначений
 *    (`assignmentsKey`): передача вуза множество людей не меняет, а видимое им
 *    меняет;
 * 3. **инвалидация — сменой ключа, а не перебором.** Ключей у области столько
 *    же, сколько сочетаний «область доступа × запись», и найти «все устаревшие»
 *    можно было бы только сканированием Redis. Поэтому в ключ входит поколение:
 *    счётчик, который `INCR` обесценивает разом (`bumpEpoch`), или величина,
 *    которую и так двигает запись, — например, момент последнего события по
 *    взаимодействию. Пережившие своё поколение записи уходят сами по сроку.
 *
 * Значение хранится JSON-ом, поэтому `Date` в нём становится строкой. Обратно
 * их возвращает `revive` — своя у каждого чтения: общий «оживитель», который
 * угадывал бы даты по виду строки, однажды превратил бы в дату комментарий.
 */
import { createHash } from 'node:crypto';
import { and, isNull, sql } from 'drizzle-orm';
import type { ActorContext } from '../actor';
import { getDb } from '../db';
import { organizationResponsibles } from '../db/schema';
import { scopeFingerprint } from '../rbac';
import { getRedis } from '../redis';

export type CacheRegion = {
	/** Часть ключа Redis и имя счётчика поколения. */
	readonly name: string;
	/**
	 * Сколько живёт собранное. Срок — это про наплыв (раздел открыли впятером на
	 * планёрке), а не про актуальность: за актуальность отвечает поколение.
	 */
	readonly ttlSeconds: number;
};

const PREFIX = 'lct:cache:';

function entryKey(region: CacheRegion, key: string): string {
	return `${PREFIX}${region.name}:${key}`;
}

function epochKey(region: CacheRegion): string {
	return `${PREFIX}${region.name}:epoch`;
}

/** Поколение области: всё, что собрано при прежнем, уже никто не прочитает. */
export async function readEpoch(region: CacheRegion): Promise<string> {
	return (await getRedis().get(epochKey(region))) ?? '0';
}

/** Данные области изменились: собранное раньше больше не показывать. */
export async function bumpEpoch(region: CacheRegion): Promise<void> {
	await getRedis().incr(epochKey(region));
}

/**
 * Отпечаток области доступа в ключе кэша.
 *
 * Список пользователей бывает длинным, а ключ Redis читают глазами, поэтому
 * область уезжает в ключ хешем. Считает его `scopeFingerprint` — тот же, что
 * знает устройство области; своё описание здесь разошлось бы с ним на первой же
 * правке, и две разные области поделили бы одну запись.
 */
export function scopeKey(ctx: ActorContext): string {
	const fingerprint = scopeFingerprint(ctx);

	if (fingerprint === 'all') {
		return 'all';
	}

	return createHash('sha256').update(fingerprint, 'utf8').digest('hex').slice(0, 16);
}

/**
 * Отпечаток действующих назначений области.
 *
 * `scopeKey` описывает множество **людей**, и оно не меняется от передачи вуза:
 * у КАМа отпечаток области один и тот же и до передачи, и после. А видит он
 * ровно свои вузы — значит, снятое назначение обязано менять ключ, иначе
 * прежний ответственный целую минуту (пока жив кэш) читает подсказку с
 * названием вуза, которого у него уже нет.
 *
 * Отпечаток снимается с самих назначений, а не со счётчика, который двигали бы
 * `assignResponsible` и `releaseResponsible`: строки `organization_responsibles`
 * появляются ещё и у заведения организации, у приёма заявки извне и у сида, — и
 * счётчик, о котором знают не все, врал бы молча.
 *
 * Цена — один запрос по частичному индексу `organization_responsibles_user_idx`.
 * Полный доступ не платит и его: у него область назначениями не сужается.
 */
export async function assignmentsKey(ctx: ActorContext): Promise<string> {
	if (ctx.scope.kind === 'all') {
		return 'all';
	}

	const ids = [...ctx.scope.userIds];

	if (ids.length === 0) {
		return 'none';
	}

	// Порядок в `string_agg` задан явно: без `order by` PostgreSQL волен склеить
	// те же строки иначе, и один и тот же набор вузов дал бы два разных ключа —
	// кэш перестал бы попадать, оставаясь при этом верным.
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

/**
 * Готовое из кэша или собранное заново.
 *
 * `key` — всё, что отличает одну запись области от другой: поколение, область
 * доступа, идентификатор записи. Собирает его область, потому что только она
 * знает, от чего её значение зависит.
 */
export async function cached<TValue>(
	region: CacheRegion,
	key: string,
	build: () => Promise<TValue>,
	revive: (stored: unknown) => TValue
): Promise<TValue> {
	const redis = getRedis();
	const full = entryKey(region, key);
	const stored = await redis.get(full);

	if (stored !== null) {
		return revive(JSON.parse(stored));
	}

	const value = await build();

	await redis.set(full, JSON.stringify(value), 'EX', region.ttlSeconds);

	return value;
}

/**
 * Только то, что уже собрано, — без сборки.
 *
 * Для экранов, которые показывают готовое, если оно есть, но не вправе сами
 * запускать дорогую сборку (внешний запрос, списание квоты). Ключ строится так
 * же, как у `cached`, поэтому находится ровно записанное ею. `undefined` —
 * записи нет: JSON его не хранит, так что с сохранённым `null` он не спутается.
 */
export async function peekCached<TValue>(
	region: CacheRegion,
	key: string,
	revive: (stored: unknown) => TValue
): Promise<TValue | undefined> {
	const stored = await getRedis().get(entryKey(region, key));

	return stored === null ? undefined : revive(JSON.parse(stored));
}
