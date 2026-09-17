/**
 * Сколько раз с одного адреса можно начать вход.
 *
 * Пароли проверяет каталог, и подбор — его забота (`keycloak/README.md`,
 * «Сроки и лимиты»). Здесь остаётся то, что каталог за нас не сделает: каждое
 * начало входа заводит в Redis запись с состоянием, `nonce` и проверочным кодом
 * PKCE, и без потолка анонимный поток нажатий забил бы Redis, не назвавшись
 * вовсе.
 *
 * Счётчик в Redis, а не в базе: это состояние попытки, оно обязано само
 * истекать и не должно переживать очистку кеша.
 */
import { pluralize } from '$lib/format';
import { getConfig } from '../config';
import { getRedis } from '../redis';

const addressKey = (ip: string): string => `login_ip:${ip}`;

/** Сколько заходов с одного адреса и за какое окно. */
const ADDRESS_ATTEMPT_LIMIT = 30;
const ADDRESS_WINDOW_SECONDS = 15 * 60;

/**
 * Во сколько раз щедрее лимит на публичной демонстрации.
 *
 * Порог рассчитан на одну машину одного человека, а демонстрацию смотрят
 * десятками из-за одного NAT: для счётчика это один адрес, и тридцати заходов
 * на всех не хватит. Порог остаётся константой, а не настройкой: настройку
 * правит администратор из интерфейса, а сам лимит защищает не данные, а систему.
 */
const DEMO_ADDRESS_MULTIPLIER = 5;

function addressAttemptLimit(): number {
	return getConfig().DEMO_MODE
		? ADDRESS_ATTEMPT_LIMIT * DEMO_ADDRESS_MULTIPLIER
		: ADDRESS_ATTEMPT_LIMIT;
}

/** Адрес, под которым считаются заходы, когда транспорт его не знает. */
export const UNKNOWN_ADDRESS = 'unknown';

/**
 * Отмечает заход с адреса. `false` — адрес исчерпал лимит окна, и начинать
 * вход ему больше не с чего.
 */
export async function withinStartLimit(ip: string): Promise<boolean> {
	const key = addressKey(ip);
	const redis = getRedis();
	const attempts = await redis.incr(key);

	if (attempts === 1) {
		// Окно фиксированное и отсчитывается от первого захода: иначе занятый
		// адрес продлевал бы собственную блокировку до бесконечности.
		await redis.expire(key, ADDRESS_WINDOW_SECONDS);
	}

	return attempts <= addressAttemptLimit();
}

/**
 * Что показать вместо кнопки, если с этого адреса больше не пускают, или
 * `null`, когда лимит не выбран и страница работает как обычно.
 *
 * Адрес берётся ровно тем же способом, что у счётчика: пустую строку транспорта
 * заменяет {@link UNKNOWN_ADDRESS}, иначе страница спрашивала бы про один ключ,
 * а хук считал бы по другому. Код ответа человеку ничего не объясняет, а ждать
 * ему всё равно придётся — и он должен знать сколько.
 */
export async function startLimitNotice(address: string): Promise<string | null> {
	const redis = getRedis();
	const key = addressKey(address || UNKNOWN_ADDRESS);
	const [value, ttl] = await Promise.all([redis.get(key), redis.ttl(key)]);
	const attempts = value === null ? 0 : Number.parseInt(value, 10);

	if (attempts < addressAttemptLimit()) {
		return null;
	}

	const minutes = Math.max(1, Math.ceil((ttl > 0 ? ttl : 0) / 60));

	return `Слишком много входов с этого адреса. Попробуйте через ${pluralize(minutes, ['минуту', 'минуты', 'минут'])}`;
}
