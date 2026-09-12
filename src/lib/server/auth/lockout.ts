/**
 * Счётчики попыток входа.
 *
 * Их два, и они про разное. Счётчик по учётной записи защищает одного человека
 * от подбора его пароля; счётчик по адресу — систему от перебора учётных
 * записей с одной машины. Оба живут в Redis, а не в базе: это состояние
 * попытки, оно должно само истекать и не должно переживать очистку кеша.
 */
import { getConfig } from '../config';
import { getRedis } from '../redis';

const failureKey = (email: string, ip: string): string =>
	`login_fail:${email.toLocaleLowerCase('en')}:${ip}`;

const addressKey = (ip: string): string => `login_ip:${ip}`;

/** Сколько попыток с одного адреса и за какое окно. */
const ADDRESS_ATTEMPT_LIMIT = 30;
const ADDRESS_WINDOW_SECONDS = 15 * 60;

/**
 * Во сколько раз щедрее лимит на публичной демонстрации.
 *
 * Порог рассчитан на одну машину одного человека, а демонстрацию смотрят
 * десятками из-за одного NAT: для счётчика это один адрес, и тридцати попыток
 * на всех не хватит. Порог остаётся константой, а не настройкой: настройку
 * правит администратор из интерфейса, а на демонстрации именно этого права и
 * нет — да и сам лимит защищает не данные, а систему.
 */
const DEMO_ADDRESS_MULTIPLIER = 5;

function addressAttemptLimit(): number {
	return getConfig().DEMO_MODE
		? ADDRESS_ATTEMPT_LIMIT * DEMO_ADDRESS_MULTIPLIER
		: ADDRESS_ATTEMPT_LIMIT;
}

/** Адрес, под которым считаются попытки, когда транспорт его не знает. */
export const UNKNOWN_ADDRESS = 'unknown';

export type LockoutState = {
	failures: number;
	/** Сколько секунд осталось до снятия блокировки; 0 — блокировки нет. */
	remainingSeconds: number;
};

export async function lockoutState(email: string, ip: string): Promise<LockoutState> {
	const redis = getRedis();
	const key = failureKey(email, ip);
	const [value, ttl] = await Promise.all([redis.get(key), redis.ttl(key)]);

	return {
		failures: value === null ? 0 : Number.parseInt(value, 10),
		remainingSeconds: ttl > 0 ? ttl : 0
	};
}

/**
 * Записывает неудачную попытку и возвращает их число. Срок жизни счётчика
 * продлевается на каждой неудаче: блокировка длится заданные минуты с последней
 * попытки, а не с первой, иначе подбор возобновляется по расписанию.
 */
export async function registerLoginFailure(
	email: string,
	ip: string,
	lockoutMinutes: number
): Promise<number> {
	const key = failureKey(email, ip);
	const results = await getRedis()
		.multi()
		.incr(key)
		.expire(key, lockoutMinutes * 60)
		.exec();
	const failures = results?.[0]?.[1];

	return typeof failures === 'number' ? failures : 0;
}

/** Снимает счётчик: пароль подошёл, считать больше нечего. */
export async function clearLoginFailures(email: string, ip: string): Promise<void> {
	await getRedis().del(failureKey(email, ip));
}

/**
 * Отмечает попытку входа с адреса. `false` — адрес исчерпал лимит окна; такому
 * вызывающему отказывают, не разбирая, чей пароль он прислал.
 */
export async function withinAddressLimit(ip: string): Promise<boolean> {
	const key = addressKey(ip);
	const redis = getRedis();
	const attempts = await redis.incr(key);

	if (attempts === 1) {
		// Окно фиксированное и отсчитывается от первой попытки: иначе занятый
		// адрес продлевал бы собственную блокировку до бесконечности.
		await redis.expire(key, ADDRESS_WINDOW_SECONDS);
	}

	return attempts <= addressAttemptLimit();
}

export type AddressLimitState = {
	/** Лимит окна исчерпан: следующая попытка с этого адреса не пройдёт. */
	exhausted: boolean;
	/** Сколько секунд осталось до конца окна; 0 — счётчика нет. */
	remainingSeconds: number;
};

/**
 * Состояние счётчика адреса, ничего не меняя. Нужно странице входа: если
 * попытки с этого адреса всё равно не пройдут, форму надо не рисовать, а
 * объяснить словами — иначе человек жмёт «Войти» и получает пустой отказ.
 */
export async function addressLimitState(ip: string): Promise<AddressLimitState> {
	const redis = getRedis();
	const key = addressKey(ip);
	const [value, ttl] = await Promise.all([redis.get(key), redis.ttl(key)]);
	const attempts = value === null ? 0 : Number.parseInt(value, 10);

	return {
		exhausted: attempts >= addressAttemptLimit(),
		remainingSeconds: ttl > 0 ? ttl : 0
	};
}

/**
 * Снимает счётчик адреса. Зовётся при удачном входе **по паролю**: лимит по
 * адресу считает перебор, а тот, кто назвал верный пароль, ничего не перебирал.
 * Без этого жюри или класс за одним NAT выбирает общий лимит обычными входами и
 * упирается в отказ, которого ничем не заслужил. Подбор это не открывает:
 * счётчик по паре «учётная запись и адрес» живёт отдельно, а чтобы снять
 * адресный, нужен верный пароль. Демонстрационный вход счётчик не трогает:
 * пароля он не спрашивает, и снятие по нему было бы бесплатным обходом лимита.
 */
export async function clearAddressAttempts(ip: string): Promise<void> {
	await getRedis().del(addressKey(ip));
}
