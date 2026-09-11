/**
 * Ограничение частоты обращений к публичному API.
 *
 * Окно фиксированное: счётчик живёт в ключе, имя которого содержит начало
 * минуты, и умирает вместе с ней. Это грубее скользящего окна — на стыке двух
 * минут можно уложить двойную норму, — зато состояние ограничителя это одно
 * целое число и один `INCR`, а не список отметок времени на каждого
 * обратившегося. Для защиты от перебора и от случайного цикла в интеграции
 * этого достаточно.
 *
 * Лимитов два, и они про разное: ключ отвечает за своё поведение, адрес — за
 * поведение всех, кто ходит из одной сети, включая тех, у кого ключа нет.
 */
import { getRedis } from '../redis';

/** Общее начало всех ключей API в Redis: по нему их видно и можно вычистить. */
export const API_REDIS_PREFIX = 'lct:api:';

export const API_RATE_LIMIT_WINDOW_SECONDS = 60;
/** На один ключ доступа. */
export const API_RATE_LIMIT_PER_KEY = 120;
/** На один адрес: общий потолок для всех ключей и всех неудачных попыток. */
export const API_RATE_LIMIT_PER_IP = 600;

export type RateLimitVerdict = {
	allowed: boolean;
	limit: number;
	/** Сколько запросов осталось в текущем окне. */
	remaining: number;
	/** Через сколько секунд окно сменится. */
	resetSeconds: number;
};

/** Границы окна, в которое попадает момент времени. Чистая функция. */
export function windowFor(nowMs: number): { start: number; resetSeconds: number } {
	const nowSeconds = Math.floor(nowMs / 1000);
	const start = nowSeconds - (nowSeconds % API_RATE_LIMIT_WINDOW_SECONDS);

	return { start, resetSeconds: start + API_RATE_LIMIT_WINDOW_SECONDS - nowSeconds };
}

/**
 * Засчитывает обращение в корзину и говорит, пропускать ли его. Запрос,
 * который не пропустили, всё равно засчитан: иначе перебор на границе лимита
 * стоил бы ровно столько же, сколько обычная работа.
 */
export async function consumeRateLimit(bucket: string, limit: number): Promise<RateLimitVerdict> {
	const { start, resetSeconds } = windowFor(Date.now());
	const key = `${API_REDIS_PREFIX}rate:${bucket}:${start}`;
	const redis = getRedis();

	const hits = await redis.incr(key);
	if (hits === 1) {
		// Срок жизни ставится один раз, при первом обращении: иначе каждое
		// следующее продлевало бы ключ и он пережил бы своё окно.
		await redis.expire(key, API_RATE_LIMIT_WINDOW_SECONDS);
	}

	return {
		allowed: hits <= limit,
		limit,
		remaining: Math.max(0, limit - hits),
		resetSeconds
	};
}

/** Из двух вердиктов наружу сообщается тот, который ближе к отказу. */
export function tighter(left: RateLimitVerdict, right: RateLimitVerdict): RateLimitVerdict {
	if (left.allowed !== right.allowed) {
		return left.allowed ? right : left;
	}

	return left.remaining <= right.remaining ? left : right;
}

/** Заголовки лимита по черновику RFC «RateLimit header fields for HTTP». */
export function rateLimitHeaders(verdict: RateLimitVerdict): Record<string, string> {
	return {
		'RateLimit-Limit': String(verdict.limit),
		'RateLimit-Remaining': String(verdict.remaining),
		'RateLimit-Reset': String(verdict.resetSeconds)
	};
}
