/**
 * Включённость внешних источников и квота сотрудника.
 *
 * Внешние источники — отключаемая зависимость: флаг в настройках решает, ходит
 * ли сервер в Dadata и на сайты вузов вообще. Выключено — форма организации
 * работает вручную и принимает снимок JSON файлом, а сюда запрос не доходит.
 *
 * Квота считается на сотрудника в сутки и только по настоящим обращениям:
 * ответ из кэша ничего не стоит. Сутки — календарные по UTC: ключ счётчика
 * живёт двое суток и уходит сам, без уборки по расписанию.
 */
import type { PassportAvailability } from '$lib/contracts/enrichment';
import type { ActorContext } from '../actor';
import { getRedis } from '../redis';
import { getSetting } from '../settings';
import { isDadataConfigured } from './dadata';

/**
 * Отказ источников, который сотрудник может понять и который правкой полей не
 * лечится: выключено настройкой, исчерпана квота. `status` — код ответа формы.
 */
export class EnrichmentRefusal extends Error {
	readonly status: number;

	constructor(message: string, status: number) {
		super(message);
		this.name = 'EnrichmentRefusal';
		this.status = status;
	}
}

const QUOTA_TTL_SECONDS = 2 * 24 * 60 * 60;

function quotaKey(userId: string, now: Date): string {
	return `lct:enrichment:quota:${userId}:${now.toISOString().slice(0, 10)}`;
}

/** Включены ли источники; выключено — отказ с объяснением, где включают. */
export async function requireEnabled(): Promise<{ dailyQuota: number }> {
	const settings = await getSetting('enrichment');

	if (!settings.enabled) {
		throw new EnrichmentRefusal(
			'Внешние источники выключены в настройках. Заполните карточку вручную или загрузите снимок паспорта файлом',
			503
		);
	}

	return { dailyQuota: settings.dailyQuota };
}

/**
 * Списывает одно обращение из квоты сотрудника.
 *
 * Счётчик растёт и при отказе: `INCR` атомарен, а проверка «прочитать, сравнить,
 * записать» пропустила бы две одновременные вкладки сверх квоты.
 */
export async function consumeQuota(ctx: ActorContext, dailyQuota: number): Promise<void> {
	// Без человека квоты нет — и паспорта тоже: его принимает сотрудник.
	if (ctx.user === null) {
		throw new EnrichmentRefusal('Паспорт организации запрашивает только сотрудник', 403);
	}

	const key = quotaKey(ctx.user.id, new Date());
	const redis = getRedis();
	const used = await redis.incr(key);

	if (used === 1) {
		await redis.expire(key, QUOTA_TTL_SECONDS);
	}

	if (used > dailyQuota) {
		throw new EnrichmentRefusal(
			`На сегодня обращения к внешним источникам исчерпаны (${dailyQuota} в сутки). Уже полученные ответы доступны из кэша`,
			429
		);
	}
}

/** Что форма показывает до первого нажатия: включено ли, есть ли ключ, сколько осталось. */
export async function passportAvailability(ctx: ActorContext): Promise<PassportAvailability> {
	const settings = await getSetting('enrichment');
	const used =
		ctx.user === null ? 0 : Number((await getRedis().get(quotaKey(ctx.user.id, new Date()))) ?? 0);

	return {
		enabled: settings.enabled,
		registryConfigured: await isDadataConfigured(),
		remaining: Math.max(0, settings.dailyQuota - used),
		dailyQuota: settings.dailyQuota
	};
}
